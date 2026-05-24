const express = require('express');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const crypto = require('crypto');
const { spawn } = require('child_process');

var router = express.Router();

const storage = require('./storage.json');

// Store temp MP4s on the external drive (not tmpfs /tmp) to avoid RAM exhaustion.
// storage.rootpath is /mnt/cctv on Pi.
const tempDir = path.join(storage.rootpath, 'tmp', 'simple-nvr-mp4');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
const generationPromises = new Map();

// Extracted clips directory (short clips created by the /api-clip endpoint)
const CLIPS_DIR = path.join(storage.rootpath, 'tmp', 'simple-nvr-clips');
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
const clipPromises = new Map();

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
        // Video is stream-copied (fast). Audio is re-encoded to AAC for iPhone/Safari compatibility.
        // -movflags +faststart is intentionally omitted: it requires a second full read-and-rewrite
        // of the temp file (potentially 100-300 MB on Pi), causing significant delay and potential
        // memory pressure. The server already supports byte-range requests so Safari can locate
        // the moov atom at the end of the file without faststart.
        const ffmpeg = spawn('ffmpeg', ['-i', mkvPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', '-y', tempMp4Tmp]);

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

// Cleanup function for extracted clips (10 min inactivity)
function cleanupClipFiles() {
    if (!fs.existsSync(CLIPS_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(CLIPS_DIR);
    for (const file of files) {
        if (!file.endsWith('.mp4')) continue;
        const filePath = path.join(CLIPS_DIR, file);
        try {
            const stats = fs.statSync(filePath);
            if (now - stats.mtime.getTime() > 10 * 60 * 1000) {
                fs.unlinkSync(filePath);
                console.log(`Cleaned up old clip: ${filePath}`);
            }
        } catch (err) {
            console.log(`Error checking clip file ${filePath}:`, err);
        }
    }
}

cleanupClipFiles();
setInterval(cleanupClipFiles, 60 * 1000);

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

            const fullStream = fs.createReadStream(filePath)
                .on("error", function (err) {
                    console.log('stream error', err);
                    res.send(err);
                });
            // Destroy the ReadStream when the client disconnects so the file
            // descriptor is closed immediately — preventing deleted-but-open
            // inode leaks on tmpfs / the external disk.
            res.on('close', () => fullStream.destroy());
            return fullStream.pipe(res);
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
                    console.log('stream error', err);
                    res.send(err);
                });
            // Destroy the ReadStream when the client disconnects so the file
            // descriptor is closed immediately — preventing deleted-but-open
            // inode leaks on the external disk.
            res.on('close', () => stream.destroy());
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

// Clip extraction endpoint
// GET /api-clip?src=<relative-mkv-path>&start=<seconds>&duration=<seconds>
// Extracts a short MP4 clip from any MKV (including output.mkv 24h files).
// The clip is cached in CLIPS_DIR and served as a download attachment.
router.get('/api-clip', async (req, res) => {
    const { src, start, duration } = req.query;

    if (!src || start == null || duration == null) {
        return res.status(400).send('Missing required parameters: src, start, duration');
    }

    const startSec = parseFloat(start);
    const durSec = parseFloat(duration);

    if (isNaN(startSec) || startSec < 0) {
        return res.status(400).send('Invalid start time (must be >= 0)');
    }
    if (isNaN(durSec) || durSec <= 0 || durSec > 3600) {
        return res.status(400).send('Invalid duration (must be 1–3600 seconds)');
    }

    // Security: resolve the source path within storage.rootpath to prevent path traversal.
    const resolvedRoot = path.resolve(storage.rootpath);
    const mkvPath = path.resolve(resolvedRoot, src);
    if (!mkvPath.startsWith(resolvedRoot + path.sep)) {
        return res.status(403).send('Forbidden');
    }
    if (!mkvPath.endsWith('.mkv')) {
        return res.status(400).send('Source must be an MKV file');
    }
    if (!fs.existsSync(mkvPath)) {
        return res.status(404).send('Source clip not found');
    }

    // Stable cache key: hash of absolute path + start + duration
    const clipId = crypto.createHash('sha1')
        .update(`${mkvPath}|${startSec}|${durSec}`)
        .digest('hex').slice(0, 16);
    const outPath = path.join(CLIPS_DIR, `${clipId}.mp4`);

    // Generate clip if not cached; coalesce concurrent requests for the same clip.
    if (!fs.existsSync(outPath)) {
        if (!clipPromises.has(outPath)) {
            const promise = new Promise((resolve, reject) => {
                // -ss before -i: fast keyframe seek (slightly less accurate but much faster
                // on large 24h files). -t limits output to exactly durSec seconds.
                // +faststart rewrites moov atom to front of the small output file so the
                // clip is immediately playable when shared via WhatsApp / iMessage.
                const args = [
                    '-hide_banner', '-loglevel', 'error',
                    '-ss', String(startSec),
                    '-i', mkvPath,
                    '-t', String(durSec),
                    '-c:v', 'copy',
                    '-c:a', 'aac', '-b:a', '128k',
                    '-movflags', '+faststart',
                    '-y', outPath
                ];
                console.log(`Extracting clip: ${path.basename(mkvPath)} @${startSec}s for ${durSec}s → ${path.basename(outPath)}`);
                const ff = spawn('ffmpeg', args);
                ff.on('error', reject);
                ff.on('close', code => {
                    if (code === 0) resolve();
                    else reject(new Error(`ffmpeg exited with code ${code}`));
                });
            });
            clipPromises.set(outPath, promise);
            promise.finally(() => clipPromises.delete(outPath));
        }

        try {
            await clipPromises.get(outPath);
        } catch (err) {
            console.error('Clip extraction failed:', err.message);
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
            return res.status(500).send('Clip extraction failed');
        }
    } else {
        // Touch mtime so the periodic cleanup does not evict a recently requested clip.
        try { fs.utimesSync(outPath, new Date(), new Date()); } catch (_) {}
    }

    let clipStats;
    try {
        clipStats = fs.statSync(outPath);
    } catch (_) {
        return res.status(500).send('Clip unavailable after generation');
    }

    // Human-readable download filename: clip-HH-MM-SS-<dur>s.mp4
    const pad2 = n => String(Math.floor(n)).padStart(2, '0');
    const hh = Math.floor(startSec / 3600);
    const mm = Math.floor((startSec % 3600) / 60);
    const ss = Math.floor(startSec % 60);
    const downloadName = `clip-${pad2(hh)}-${pad2(mm)}-${pad2(ss)}-${Math.round(durSec)}s.mp4`;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', clipStats.size);

    const clipStream = fs.createReadStream(outPath);
    res.on('close', () => clipStream.destroy());
    clipStream.pipe(res);
});

module.exports = router;
