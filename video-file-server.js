const express = require('express');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const os = require('os');
const { spawn } = require('child_process');

var router = express.Router();

const storage = require('./storage.json');

const tempDir = path.join(os.tmpdir(), 'simple-nvr-mp4');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
const generationPromises = new Map();

function createTempMp4(mkvPath, tempMp4) {
    if (generationPromises.has(tempMp4)) {
        return generationPromises.get(tempMp4);
    }

    const tempMp4Tmp = `${tempMp4}.tmp.mp4`;
    if (fs.existsSync(tempMp4Tmp)) {
        try { fs.unlinkSync(tempMp4Tmp); } catch (err) { }
    }

    const promise = new Promise((resolve, reject) => {
        console.log(`Starting MP4 generation for: ${tempMp4}`);
        const ffmpeg = spawn('ffmpeg', ['-i', mkvPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', '-y', tempMp4Tmp]);

        ffmpeg.on('error', (err) => {
            console.error(`FFmpeg spawn error for ${tempMp4Tmp}:`, err);
            try { if (fs.existsSync(tempMp4Tmp)) fs.unlinkSync(tempMp4Tmp); } catch (cleanupErr) { }
            reject(err);
        });

        ffmpeg.on('close', (code) => {
            if (code !== 0) {
                console.error(`FFmpeg failed for ${tempMp4Tmp} with code ${code}`);
                try { if (fs.existsSync(tempMp4Tmp)) fs.unlinkSync(tempMp4Tmp); } catch (cleanupErr) { }
                return reject(new Error(`FFmpeg exited with code ${code}`));
            }

            fs.stat(tempMp4Tmp, (err, stats) => {
                if (err || !stats || stats.size === 0) {
                    console.error(`Temp MP4 generation failed or empty: ${tempMp4Tmp}`, err);
                    try { if (fs.existsSync(tempMp4Tmp)) fs.unlinkSync(tempMp4Tmp); } catch (cleanupErr) { }
                    return reject(new Error('Generated MP4 is empty'));    
                }

                try {
                    fs.renameSync(tempMp4Tmp, tempMp4);
                } catch (renameErr) {
                    console.error(`Failed to rename ${tempMp4Tmp} to ${tempMp4}:`, renameErr);
                    try { if (fs.existsSync(tempMp4Tmp)) fs.unlinkSync(tempMp4Tmp); } catch (cleanupErr) { }
                    return reject(renameErr);
                }

                console.log(`Temp MP4 created: ${tempMp4}, size: ${stats.size}`);
                resolve(tempMp4);
            });
        });
    });

    generationPromises.set(tempMp4, promise);
    promise.finally(() => generationPromises.delete(tempMp4));
    return promise;
}

// Cleanup function for temp files
function cleanupTempFiles() {
    if (!fs.existsSync(tempDir)) return;
    const now = Date.now();
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
        if (!file.endsWith('.mp4') && !file.endsWith('.tmp')) continue;
        const filePath = path.join(tempDir, file);
        try {
            const stats = fs.statSync(filePath);
            if (now - stats.mtime.getTime() > 5 * 60 * 1000) {
                fs.unlinkSync(filePath);
                console.log(`Cleaned up old temp file: ${filePath}`);
            }
        } catch (err) {
            console.log(`Error checking temp file ${filePath}:`, err);
        }
    }
}

// Initial cleanup on startup
cleanupTempFiles();

// Periodic cleanup every minute
setInterval(cleanupTempFiles, 60 * 1000);

function serveVideoFile(filePath, res, ext, req) {
    fs.stat(filePath, function (err, stats) {
        if (err) {
            if (err.code === 'ENOENT') {
                console.log('file not found', err);
                // 404 Error if file not found
                return res.status(404).send();
            }
            console.log('file stat error', err);
            return res.send(err);
        }
        var range = req.headers.range;

        var videoSize = stats.size;

        console.log('Serving file:', filePath, 'size:', videoSize, 'range:', range);

        if (videoSize === 0) {
            console.log('File is empty or not ready:', filePath);
            return res.status(404).send('File not ready or empty');
        }

        const contentType = ext === 'mkv' ? 'video/x-matroska' : `video/${ext}`;

        // Some players/browser checks request metadata without a Range header.
        // Serve the full file in that case instead of returning 416.
        if (!range) {
            res.writeHead(200, {
                "Accept-Ranges": "bytes",
                "Content-Length": videoSize,
                "Content-Type": contentType,
            });

            return fs.createReadStream(filePath)
                .on("error", function (err) {
                    console.log('stream error', err)
                    res.send(err);
                })
                .pipe(res);
        }

        // Parse Range
        // Example: "bytes=32324-"
        const CHUNK_SIZE = 10 ** 6; // 1MB
        const [startRaw, endRaw] = range.replace(/bytes=/, '').split('-');
        const start = Number(startRaw);
        const requestedEnd = endRaw ? Number(endRaw) : start + CHUNK_SIZE;

        console.log('Parsed range:', start, requestedEnd, 'for size:', videoSize);

        if (isNaN(start) || start < 0) {
            console.log('Invalid range start:', start, 'for file:', filePath);
            return res.status(416).send('Requested range not satisfiable');
        }

        const end = Math.min(requestedEnd, videoSize - 1);

        if (start > end || start >= videoSize) {
            console.log('Invalid range:', start, '-', end, 'for videoSize:', videoSize, 'file:', filePath);
            return res.status(416).send('Requested range not satisfiable');
        }

        // Create headers
        const contentLength = end - start + 1;
        const headers = {
            "Content-Range": `bytes ${start}-${end}/${videoSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": contentLength,
            "Content-Type": contentType,
        };
        
        // Re-validate file before streaming
        fs.stat(filePath, (err, stats) => {
            if (err || !stats || stats.size === 0) {
                console.log('File became invalid before streaming:', filePath, err);
                return res.status(404).send('File not available');
            }
            if (start >= stats.size || end >= stats.size) {
                console.log('Range invalid after re-check:', start, end, stats.size, filePath);
                return res.status(416).send('Requested range not satisfiable');
            }
            // HTTP Status 206 for Partial Content
            res.writeHead(206, headers);

            var stream = fs.createReadStream(filePath, { start: start, end: end })
                .on("open", function () {
                    stream.pipe(res);
                }).on("error", function (err) {
                    console.log('stream error', err)
                    res.send(err);
                });
        });
    });
}

router.get('/api/*.:ext', async (req, res, next) => {
    const ext = req.params.ext;
    const parts = `${req.params['0']}.${ext}`.split('/').filter(x => x.length > 0);

    var filepath = path.join(storage.rootpath, ...parts);

    if (ext === 'mp4') {
        const mkvPath = filepath.replace(/\.mp4$/, '.mkv');
        if (!fs.existsSync(mkvPath)) {
            return res.status(404).send('Corresponding MKV not found');
        }
        if (path.basename(mkvPath) === 'output.mkv') {
            console.log('Skipping MP4 generation for output.mkv');
            return res.status(404).send('MP4 playback not supported for output.mkv');
        }

        const relativePath = path.relative(storage.rootpath, filepath);
        const tempMp4 = path.join(tempDir, Buffer.from(relativePath).toString('base64').replace(/=+$/, '') + '.mp4');
        const tempMp4Tmp = `${tempMp4}.tmp`;
        const serve = () => serveVideoFile(tempMp4, res, 'mp4', req);

        try {
            if (generationPromises.has(tempMp4)) {
                console.log(`Waiting for ongoing MP4 generation: ${tempMp4}`);
                await generationPromises.get(tempMp4);
                fs.utimesSync(tempMp4, new Date(), new Date());
                return serve();
            }

            if (fs.existsSync(tempMp4)) {
                const stats = await fsPromises.stat(tempMp4);
                if (stats.size > 0) {
                    fs.utimesSync(tempMp4, new Date(), new Date());
                    return serve();
                }
                console.log(`Existing MP4 file is empty, removing: ${tempMp4}`);
                fs.unlinkSync(tempMp4);
            }

            if (fs.existsSync(tempMp4Tmp) && !generationPromises.has(tempMp4)) {
                console.log(`Removing stale temp file: ${tempMp4Tmp}`);
                fs.unlinkSync(tempMp4Tmp);
            }

            await createTempMp4(mkvPath, tempMp4);
            fs.utimesSync(tempMp4, new Date(), new Date());
            return serve();
        } catch (err) {
            console.error(`Failed to prepare MP4 for ${tempMp4}:`, err.message || err);
            return res.status(500).send('Failed to generate MP4');
        }
    } else {
        serveVideoFile(filepath, res, ext, req);
    }
})

module.exports = router;
