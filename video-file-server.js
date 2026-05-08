const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

var router = express.Router();

const storage = require('./storage.json');

const tempDir = path.join(os.tmpdir(), 'simple-nvr-mp4');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
const tempFiles = new Map(); // tempMp4 => timeoutId

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
}

router.get('/api/*.:ext', (req, res, next) => {
    const ext = req.params.ext;
    const parts = `${req.params['0']}.${ext}`.split('/').filter(x => x.length > 0);

    var filepath = path.join(storage.rootpath, ...parts);

    if (ext === 'mp4') {
        const mkvPath = filepath.replace(/\.mp4$/, '.mkv');
        if (!fs.existsSync(mkvPath)) {
            return res.status(404).send('Corresponding MKV not found');
        }
        const relativePath = path.relative(storage.rootpath, filepath);
        const tempMp4 = path.join(tempDir, Buffer.from(relativePath).toString('base64').replace(/=+$/, '') + '.mp4');

        const serve = () => serveVideoFile(tempMp4, res, 'mp4', req);

        if (fs.existsSync(tempMp4)) {
            // reset timeout
            if (tempFiles.has(tempMp4)) {
                clearTimeout(tempFiles.get(tempMp4));
            }
            const timeoutId = setTimeout(() => {
                fs.unlink(tempMp4, (err) => {
                    if (!err) console.log(`Deleted temp MP4: ${tempMp4}`);
                    tempFiles.delete(tempMp4);
                });
            }, 5 * 60 * 1000);
            tempFiles.set(tempMp4, timeoutId);
            serve();
        } else {
            console.log(`Generating temp MP4: ${tempMp4} from ${mkvPath}`);
            const ffmpeg = spawn('ffmpeg', ['-i', mkvPath, '-c', 'copy', '-y', tempMp4]);
            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    console.log(`Temp MP4 created: ${tempMp4}`);
                    const timeoutId = setTimeout(() => {
                        fs.unlink(tempMp4, (err) => {
                            if (!err) console.log(`Deleted temp MP4: ${tempMp4}`);
                            tempFiles.delete(tempMp4);
                        });
                    }, 5 * 60 * 1000);
                    tempFiles.set(tempMp4, timeoutId);
                    serve();
                } else {
                    console.error(`FFmpeg failed for ${tempMp4}`);
                    res.status(500).send('Failed to generate MP4');
                }
            });
        }
    } else {
        serveVideoFile(filepath, res, ext, req);
    }
})

module.exports = router;
