const express = require('express');
const path = require('path');
const fs = require('fs');

var router = express.Router();

const storage = require('./storage.json');

router.get('/api/*.:ext', (req, res, next) => {
    // const location = req.params.location;
    // const year = req.params.year;
    // const month = req.params.month;
    // const day = req.params.day;
    // const filename = req.params.filename;
    const ext = req.params.ext;
    const parts = `${req.params['0']}.${ext}`.split('/').filter(x => x.length > 0);


    // https://stackoverflow.com/a/24977085/10159640
    var filepath = path.join(storage.rootpath, ...parts);
    fs.stat(filepath, function (err, stats) {
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

        const contentType = ext === 'mkv' ? 'video/x-matroska' : `video/${ext}`;

        // Some players/browser checks request metadata without a Range header.
        // Serve the full file in that case instead of returning 416.
        if (!range) {
            res.writeHead(200, {
                "Accept-Ranges": "bytes",
                "Content-Length": videoSize,
                "Content-Type": contentType,
            });

            return fs.createReadStream(filepath)
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
        const end = Math.min(requestedEnd, videoSize - 1);

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

        var stream = fs.createReadStream(filepath, { start: start, end: end })
            .on("open", function () {
                stream.pipe(res);
            }).on("error", function (err) {
                console.log('stream error', err)
                res.send(err);
            });
    });
})

module.exports = router;
