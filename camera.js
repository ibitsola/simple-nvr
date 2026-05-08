const childProcess = require("child_process");
const path = require("path");
const fs = require('fs');
const fsAsync = require('fs').promises;
var CronJob = require('cron').CronJob;

const storage = require('./storage.json');
const cameraConfigs = require('./cameras.json');
const videoConcatinator = require('./video-concat.js');

const videoLengthSeconds = 300; // 5 mins
const timeoutRecordingWatcher = 1000 * 310; // 5 minutes 10 seconds - increased due to mkv files not triggering changes as frequently
const retentionDays = Number.isInteger(storage.retentionDays) && storage.retentionDays >= 1 ? storage.retentionDays : 30;
const cameras = [];

module.exports.initCameras = () => {
    for (let i = 0; i < cameraConfigs.length; i++) {
        const cameraConfig = cameraConfigs[i];
        const camera = new CameraStream(cameraConfig.name, cameraConfig.url);
        cameras.push(camera);
    }
}

class CameraStream {
    constructor(name, url) {
        this.name = name;
        this.log(`Initialising camera...`);

        this.url = url;
        this.storagePath = path.join(storage.rootpath, this.name);
        this.rawStoragePath = path.join(this.storagePath, 'raw');


        fs.mkdirSync(this.rawStoragePath, { recursive: true });

        this.ffmpegProcess = null;
        this.recordingWatcher = null;

        this.args = [
            "-hide_banner",
            "-y", // overwrite files without asking
            "-loglevel", "error",
            "-rtsp_transport", "tcp",
            "-use_wallclock_as_timestamps", "1", // Fix the timestamps in the file not being correct
            "-i", this.url,
            "-vcodec", "copy",
            "-f", "segment",
            "-reset_timestamps", "1",
            "-segment_time", `${videoLengthSeconds}`,
            "-segment_format", "mkv",
            "-segment_atclocktime", "1",
            "-strftime", "1",
            `${path.join(this.rawStoragePath, "%Y-%m-%dT%H %M %S%z.mkv")}`
        ];

        this.initTimeoutWatcher();
        this.initFileMover();
        this.initCombinationCron();
        this.initRetentionCleanupCron();
        this.startRecording();
        this.log(`Camera initialised`);
    }

    // Watch for file changes in the /raw folder. 
    // If there are no changes - the stream has stopped so restart it.
    initTimeoutWatcher() {
        fs.watch(this.rawStoragePath, { encoding: 'buffer' }, (eventType, filename) => {
            if (eventType == 'change') {
                if (this.recordingWatcher) clearInterval(this.recordingWatcher)
                this.recordingWatcher = setInterval(
                    () => {
                        this.log('File change timeout');
                        this.restartRecording()
                    }, timeoutRecordingWatcher);
            }
        })
    }

    // move finished segments to a /yyyy/mm/dd folder
    initFileMover() {
        this.fileMoveInterval = setInterval(
            () => {
                this.moveCompletedFiles();
            },
            1000 * 15
        )
    }

    initCombinationCron() {
        new CronJob('0 1 * * *', async () => {
            try {
                const yesterday = new Date()
                yesterday.setUTCHours(-24, 0, 0, 0);
                const dayDir = dayDirectory(this.storagePath, yesterday)
                await videoConcatinator.combineFilesInDirectory(dayDir, true);
            } catch (error) {
                console.log('error combining files', error);
            }
        }, null, true, 'UTC');
    }


    initRetentionCleanupCron() {
        // Cleanup runs after concatenation cron, but only deletes day folders older than retention and
        // always skips today and yesterday. This means it cannot target the folder being concatenated.
        new CronJob('0 2 * * *', async () => {
            try {
                await this.deleteOldDayFolders();
            } catch (error) {
                this.log('Retention cleanup failed', error);
            }
        }, null, true, 'UTC');
    }

    async deleteOldDayFolders() {
        const dayFolders = await this.getDayDirectories();
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);

        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);

        const retentionCutoff = new Date(todayStart);
        retentionCutoff.setUTCDate(retentionCutoff.getUTCDate() - retentionDays);

        for (let i = 0; i < dayFolders.length; i++) {
            const item = dayFolders[i];
            const dayDate = item.date;

            if (dayDate >= yesterdayStart) continue; // never delete today or yesterday
            if (dayDate >= retentionCutoff) continue; // still within retention period

            try {
                await fsAsync.rm(item.path, { recursive: true, force: false });
                this.log(`Deleted old day folder: ${item.path}`);
            } catch (error) {
                this.log(`Failed to delete old day folder: ${item.path}`, error);
            }
        }
    }

    async getDayDirectories() {
        const results = [];
        const yearEntries = await fsAsync.readdir(this.storagePath, { withFileTypes: true });

        for (const yearEntry of yearEntries) {
            if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) continue;
            const yearPath = path.join(this.storagePath, yearEntry.name);
            const monthEntries = await fsAsync.readdir(yearPath, { withFileTypes: true });

            for (const monthEntry of monthEntries) {
                if (!monthEntry.isDirectory() || !/^\d{2}$/.test(monthEntry.name)) continue;
                const monthPath = path.join(yearPath, monthEntry.name);
                const dayEntries = await fsAsync.readdir(monthPath, { withFileTypes: true });

                for (const dayEntry of dayEntries) {
                    if (!dayEntry.isDirectory() || !/^\d{2}$/.test(dayEntry.name)) continue;

                    const dayPath = path.join(monthPath, dayEntry.name);
                    const dayDate = new Date(`${yearEntry.name}-${monthEntry.name}-${dayEntry.name}T00:00:00.000Z`);
                    if (Number.isNaN(dayDate.valueOf())) continue;

                    results.push({ path: dayPath, date: dayDate });
                }
            }
        }

        return results;
    }

    log(message, ...optionalParams) {
        console.log(`${new Date().toISOString()} [${this.name}] ${message}`, ...optionalParams);
    }

    restartRecording() {
        this.log('Attempting recording restart...');
        this.killRecording();
        this.startRecording();
    }

    killRecording() {
        if (this.ffmpegProcess) {
            try {
                this.log('Killing ffmpeg process...');
                this.ffmpegProcess.kill();
            } catch (error) {
                this.log('Error killing process', error)
            }
            this.ffmpegProcess = null;
        }
    }

    startRecording() {
        try {
            this.log(`*** Spawing ffmpeg process ***`);
            this.ffmpegProcess = childProcess.spawn("ffmpeg", this.args, {});

            this.ffmpegProcess.stdout.on('data', (data) => {
                this.log('[STDOUT]', data.toString());
            });

            this.ffmpegProcess.stderr.on('data', (data) => {
                this.log('[STDERR]', data.toString());
            });

            this.ffmpegProcess.on('exit', (code) => {
                this.log(`[EXIT] code ${code}`);
            });
            
            this.ffmpegProcess.on('error', (err) => {
                this.log(`[ERROR]`, err);
            });

        } catch (error) {
            this.log('startRecording error', error);
            if (this.ffmpegProcess) this.ffmpegProcess.kill();
        }
    }


    async moveCompletedFiles() {
        const filepaths = await this.getCompletedFiles();
        for (let i = 0; i < filepaths.length; i++) {
            const filepath = filepaths[i];
            await this.moveFileToDated(filepath);
        }
    }

    async getCompletedFiles() {
        let listOfFiles = await fsAsync.readdir(this.rawStoragePath);
        listOfFiles = listOfFiles.sort();
        const filepaths = [];
        while (listOfFiles.length > 1) {
            const filename = listOfFiles.shift();
            if (filename.endsWith('.mkv')) {
                filepaths.push(path.join(this.rawStoragePath, filename));
            }
        }
        return filepaths;
    }

    async moveFileToDated(filepath) {
        const fileDateName = path.basename(filepath, '.mkv');
        let dateString = fileDateName.split(' ').join(':');
        let date = new Date(dateString);
        if (Number.isNaN(date.valueOf())) {
            this.log('Invalid file date', dateString);
            // try just the "yyyy-mm-ddThh:mm:ss" portion
            // Windows systems incorrectly parse the lower case "z" formatter on the ffmpeg date time parser.
            // Instead of (e.g.) "+0100", they have (e.g.) "GMT Summer Time".
            // This doesn't parse as a "new Date( )";
            dateString = dateString.substr(0, 19);
            date = new Date(dateString);
            if (Number.isNaN(date.valueOf())) {
                this.log('Still an invalid file date', dateString);
                // date format still not valid
                return;
            }
        }
        const newDirectory = dayDirectory(this.storagePath, date);
        await fsAsync.mkdir(newDirectory, { recursive: true });
        const newFilename = `${date.toISOString().split(':').join(' ').split('.')[0]}.mkv`;
        const newFilepath = path.join(newDirectory, newFilename);
        await fsAsync.rename(filepath, newFilepath);
        this.log(`Moved ${date.toISOString()}`);
    }
}


function dayDirectory(baseDir = '/', date = new Date()) {
    const year = add_zero(date.getUTCFullYear());
    const month = add_zero(date.getUTCMonth() + 1);
    const day = add_zero(date.getUTCDate());
    return path.join(baseDir, year, month, day);
}

function add_zero(your_number, length = 2) {
    var num = '' + your_number;
    while (num.length < length) {
        num = '0' + num;
    }
    return num;
}