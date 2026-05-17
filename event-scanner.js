const path = require('path');
const fs = require('fs');
const fsAsync = require('fs').promises;
const crypto = require('crypto');
const { spawn } = require('child_process');
require('dotenv').config();

let config = {};
let scannerState = {};
const SCANNER_STATE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const DETECTOR_TIMEOUT_MS = 120 * 1000;
const DEBUG_DETECTOR_MIN_CONFIDENCE = 0.01;

// Initialize configuration
async function loadConfig(options = {}) {
    try {
        const prepareWhenDisabled = Boolean(options.prepareWhenDisabled);
        const configPath = path.join(__dirname, 'event-detection.json');
        const configData = await fsAsync.readFile(configPath, 'utf8');
        config = JSON.parse(configData);
        console.log('✓ Event detection config loaded');
        
        config.maxFramesPerClip = Number(config.maxFramesPerClip || 8);
        config.sampleEverySeconds = Number(config.sampleEverySeconds || 30);
        config.minConfidence = Number(config.minConfidence || 0.5);
        config.classes = config.classes || ['person', 'cat'];
        config.tempFrameDir = config.tempFrameDir || '/tmp/simple-nvr-events';
        config.pythonExecutable = config.pythonExecutable || 'python3';
        config.pythonDetectorPath = config.pythonDetectorPath || 'scripts/detect-events.py';
        config.yoloModel = config.yoloModel || 'yolov8n.pt';
        config.retentionDays = Number(config.retentionDays || 30);
        config.classConfidence = config.classConfidence || {};

        if (!path.isAbsolute(config.pythonDetectorPath)) {
            config.pythonDetectorPath = path.join(__dirname, config.pythonDetectorPath);
        }

        if (!config.enabled && !prepareWhenDisabled) {
            console.log('ℹ Event detection is disabled in config');
            return false;
        }

        // Ensure directories exist
        await fsAsync.mkdir(path.dirname(config.eventLogPath), { recursive: true });
        await fsAsync.mkdir(config.thumbnailDir, { recursive: true });
        await fsAsync.mkdir(config.tempFrameDir, { recursive: true });

        if (!config.enabled) {
            console.log('ℹ Event detection is disabled in config; continuing for manual clip scan');
        }
        
        return true;
    } catch (err) {
        console.error('✗ Failed to load event detection config:', err.message);
        return false;
    }
}

// Load or initialize scanner state
async function loadState() {
    try {
        const statePath = path.join(path.dirname(config.eventLogPath), 'scanner-state.json');
        const stateData = await fsAsync.readFile(statePath, 'utf8');
        scannerState = JSON.parse(stateData);
    } catch (err) {
        // File doesn't exist yet, start with empty state
        scannerState = {
            lastScan: 0,
            processedClips: {}
        };
    }

    pruneScannerState();
}

// Save scanner state
async function saveState() {
    try {
        pruneScannerState();
        const statePath = path.join(path.dirname(config.eventLogPath), 'scanner-state.json');
        await fsAsync.writeFile(statePath, JSON.stringify(scannerState, null, 2));
    } catch (err) {
        console.error('✗ Failed to save scanner state:', err.message);
    }
}

function pruneScannerState() {
    if (!scannerState.processedClips) {
        scannerState.processedClips = {};
        return;
    }

    const cutoff = Date.now() - SCANNER_STATE_RETENTION_MS;
    for (const [clipPath, entry] of Object.entries(scannerState.processedClips)) {
        const processedAt = entry && entry.processedAt ? new Date(entry.processedAt).getTime() : 0;
        if (!processedAt || processedAt < cutoff) {
            delete scannerState.processedClips[clipPath];
        }
    }
}

function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const { timeoutMs, ...spawnOptions } = options;
        const child = spawn(command, args, spawnOptions);
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timeout = timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
            }, timeoutMs)
            : null;

        if (child.stdout) {
            child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        }
        if (child.stderr) {
            child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        }

        child.on('error', err => {
            if (timeout) clearTimeout(timeout);
            reject(err);
        });
        child.on('close', code => {
            if (timeout) clearTimeout(timeout);
            if (timedOut) {
                const err = new Error(`${command} timed out after ${timeoutMs}ms`);
                err.code = 'ETIMEDOUT';
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            if (code !== 0) {
                const err = new Error(`${command} exited with code ${code}: ${stderr.trim()}`);
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

function clipHash(clipPath) {
    return crypto.createHash('sha1').update(clipPath).digest('hex').slice(0, 16);
}

async function extractSampledFrames(clipPath, frameDir) {
    await fsAsync.rm(frameDir, { recursive: true, force: true });
    await fsAsync.mkdir(frameDir, { recursive: true });

    const outputPattern = path.join(frameDir, 'frame_%05d.jpg');
    const fps = `fps=1/${config.sampleEverySeconds}`;
    const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', clipPath,
        '-vf', fps,
        '-frames:v', String(config.maxFramesPerClip),
        '-q:v', '3',
        outputPattern
    ];

    await runCommand('ffmpeg', args);
    const frames = (await fsAsync.readdir(frameDir))
        .filter(file => /^frame_\d{5}\.jpg$/.test(file))
        .sort()
        .map(file => path.join(frameDir, file));

    return frames;
}

async function runPythonDetector(frameDir, options = {}) {
    const minConfidence = options.includeAllClasses
        ? DEBUG_DETECTOR_MIN_CONFIDENCE
        : config.minConfidence;
    const args = [
        config.pythonDetectorPath,
        '--frame-dir', frameDir,
        '--min-confidence', String(minConfidence),
        '--sample-every-seconds', String(config.sampleEverySeconds),
        '--classes', ...(config.classes || ['person', 'cat']),
        '--model', config.yoloModel
    ];

    if (options.includeAllClasses) {
        args.push('--include-all-classes');
    }

    const { stdout } = await runCommand(config.pythonExecutable, args, { timeoutMs: DETECTOR_TIMEOUT_MS });
    try {
        return JSON.parse(stdout);
    } catch (err) {
        throw new Error(`Python detector returned invalid JSON: ${stdout.slice(0, 500)}`);
    }
}

async function createThumbnail(clipPath, detection, thumbnailDir) {
    if (!detection.framePath) return null;

    const dir = thumbnailDir || config.thumbnailDir;
    await fsAsync.mkdir(dir, { recursive: true });
    const safeType = String(detection.type || 'event').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
    const frameTimestamp = String(detection.frameTimestampSeconds || 0).replace(/[^0-9]/g, '_');
    const basename = `${clipHash(clipPath)}-${safeType}-${frameTimestamp}.jpg`;
    const thumbnailPath = path.join(dir, basename);
    // Resize to ~300px wide and compress as JPEG for display/storage.
    // YOLO inference already ran on the full-size extracted frame above.
    await runCommand('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', detection.framePath,
        '-vf', 'scale=300:-1',
        '-q:v', '5',
        '-y',
        thumbnailPath
    ]);
    return thumbnailPath;
}

function confidenceThreshold(type) {
    if (config.classConfidence && config.classConfidence[type] !== undefined) {
        return Number(config.classConfidence[type]);
    }
    return config.minConfidence;
}

function dedupeDetections(detections) {
    const byType = new Map();

    for (const detection of detections) {
        if (!detection || !config.classes.includes(detection.type)) continue;
        if (Number(detection.confidence) < confidenceThreshold(detection.type)) continue;

        const existing = byType.get(detection.type);
        if (!existing || Number(detection.confidence) > Number(existing.confidence)) {
            byType.set(detection.type, detection);
        }
    }

    return Array.from(byType.values());
}

async function writeJsonFile(filePath, value) {
    await fsAsync.writeFile(filePath, JSON.stringify(value, null, 2));
}

function getDebugDir(clipPath) {
    return path.join(path.dirname(config.eventLogPath), 'debug', clipHash(clipPath));
}

async function detectEventsInClip(clipPath, options = {}) {
    const debug = Boolean(options.debug);
    const debugDir = debug ? getDebugDir(clipPath) : null;

    if (config.mockMode) {
        // Mock a sample event (one per clip) for testing
        console.log('(mock) Scanning:', clipPath);
        return {
            detections: [{
                type: 'cat',
                confidence: 0.82,
                colour: 'unknown',
                frameTimestampSeconds: 0,
                thumbnailPath: null
            }],
            failed: false
        };
    }

    const frameDir = debug ? debugDir : path.join(config.tempFrameDir, clipHash(clipPath));

    try {
        if (debug) {
            await fsAsync.rm(debugDir, { recursive: true, force: true });
            await fsAsync.mkdir(debugDir, { recursive: true });
        }

        const frames = await extractSampledFrames(clipPath, frameDir);
        if (frames.length === 0) {
            console.log('ℹ No frames extracted:', clipPath);
            const emptyResult = { detections: [] };
            if (debug) {
                await writeJsonFile(path.join(debugDir, 'raw-detections.json'), emptyResult);
                await writeJsonFile(path.join(debugDir, 'deduped-detections.json'), []);
            }
            return { detections: [], failed: false, debugDir };
        }

        const detectorResult = await runPythonDetector(frameDir, { includeAllClasses: debug });
        if (debug) {
            await writeJsonFile(path.join(debugDir, 'raw-detections.json'), detectorResult);
        }

        const deduped = dedupeDetections(detectorResult.detections || []);

        const clipFileDate = parseClipTimestamp(path.basename(clipPath));
        const clipDateLocal = localDateString(clipFileDate || new Date());
        const [tYear, tMonth, tDay] = clipDateLocal.split('-');
        const dayThumbnailDir = path.join(
            path.dirname(config.eventLogPath), tYear, tMonth, tDay, 'thumbnails'
        );

        for (const detection of deduped) {
            detection.thumbnailPath = await createThumbnail(clipPath, detection, dayThumbnailDir);
            detection.colour = detection.colour || 'unknown';
        }

        if (debug) {
            await writeJsonFile(path.join(debugDir, 'deduped-detections.json'), deduped);
        }

        return { detections: deduped, failed: false, debugDir };
    } catch (err) {
        const isDetectorTimeout = err.code === 'ETIMEDOUT';
        const phase = isDetectorTimeout ? 'Python detector timed out' : 'Clip detection failed';
        console.warn(`⚠ ${phase}; skipping clip: ${clipPath}`);
        console.warn(`  ${err.message}`);
        if (debug && debugDir) {
            await writeJsonFile(path.join(debugDir, 'debug-error.json'), { error: err.message }).catch(() => {});
        }
        return { detections: [], failed: true, error: err.message, debugDir };
    } finally {
        if (!debug) {
            await fsAsync.rm(frameDir, { recursive: true, force: true }).catch(() => {});
        }
    }
}

function getDisplayType(type) {
    if (type === 'cat' || type === 'dog') return 'Animal';
    if (!type) return 'Unknown';
    return type.charAt(0).toUpperCase() + type.slice(1);
}

function makeEventId(camera, timestampUtc, type, clipPath) {
    return crypto.createHash('sha1')
        .update(`${camera}|${timestampUtc}|${type}|${clipPath}`)
        .digest('hex')
        .slice(0, 16);
}

function getDayEventLogPath(eventDateLocal) {
    const [year, month, day] = eventDateLocal.split('-');
    return path.join(path.dirname(config.eventLogPath), year, month, day, 'events.jsonl');
}

async function isDuplicateEvent(dayLogPath, eventId) {
    try {
        const data = await fsAsync.readFile(dayLogPath, 'utf8');
        const lines = data.split('\n').filter(l => l.trim());
        for (const line of lines) {
            try { if (JSON.parse(line).eventId === eventId) return true; } catch (e) { /* skip */ }
        }
        return false;
    } catch (err) {
        return false;
    }
}

// Log event to per-day JSONL file; skip duplicates
async function logEvent(event) {
    try {
        const dateKey = event.eventDateLocal || new Date().toISOString().slice(0, 10);
        const dayLogPath = getDayEventLogPath(dateKey);
        await fsAsync.mkdir(path.dirname(dayLogPath), { recursive: true });

        if (event.eventId && await isDuplicateEvent(dayLogPath, event.eventId)) {
            return false; // duplicate
        }

        const eventLine = JSON.stringify(event) + '\n';
        await fsAsync.appendFile(dayLogPath, eventLine);
        return true; // logged
    } catch (err) {
        console.error('✗ Failed to log event:', err.message);
        return false;
    }
}

// Parse UTC timestamp from MKV filename and convert to Europe/London local time
function parseClipTimestamp(filename) {
    const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}) (\d{2}) (\d{2})\.mkv$/);
    if (!match) return null;
    
    const utcDateStr = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
    const utcDate = new Date(utcDateStr);
    
    if (isNaN(utcDate.getTime())) return null;
    
    return utcDate;
}

function formatLocalDisplay(date) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Europe/London'
    });

    return formatter.format(date);
}

function localDateString(date) {
    return new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        timeZone: 'Europe/London'
    }).format(date);
}

function getEventTimestamps(filename, detection) {
    const clipStart = parseClipTimestamp(filename);
    const offsetSeconds = Number(detection.frameTimestampSeconds || 0);
    const eventDate = clipStart
        ? new Date(clipStart.getTime() + offsetSeconds * 1000)
        : new Date();

    return {
        timestampUtc: eventDate.toISOString(),
        timestampLocalDisplay: formatLocalDisplay(eventDate),
        eventDateLocal: localDateString(eventDate)
    };
}

// Scan clips in a single day directory.
// Returns { found, skipped, scanned, eventsLogged, duplicatesSkipped }.
async function scanDirectory(dirPath, options = {}) {
    const debug = Boolean(options.debug);
    const stats = { found: 0, skipped: 0, scanned: 0, eventsLogged: 0, duplicatesSkipped: 0 };
    try {
        const files = await fsAsync.readdir(dirPath);
        const allMkvFiles = files.filter(f => f.endsWith('.mkv'));
        stats.found = allMkvFiles.length;
        if (stats.found === 0) return stats;

        // Only scan output.mkv when no individual 5-minute clips exist for this day
        const hasRegularClips = allMkvFiles.some(f => f !== 'output.mkv');

        for (const file of allMkvFiles) {
            const clipPath = path.join(dirPath, file);

            if (file === 'output.mkv' && hasRegularClips) {
                console.log(`  → Skip output.mkv (individual clips exist): ${dirPath}`);
                stats.skipped++;
                continue;
            }

            if (scannerState.processedClips[clipPath]) {
                stats.skipped++;
                continue;
            }

            console.log(`  → Scanning: ${file}`);
            const scanResult = await detectEventsInClip(clipPath, { debug });
            const detections = scanResult.detections;

            for (const detection of detections) {
                const timestamps = getEventTimestamps(file, detection);
                const eventId = makeEventId(config.camera, timestamps.timestampUtc, detection.type, clipPath);
                const event = {
                    eventId,
                    timestampUtc: timestamps.timestampUtc,
                    timestampLocalDisplay: timestamps.timestampLocalDisplay,
                    timestamp: timestamps.timestampUtc,
                    eventDateLocal: timestamps.eventDateLocal,
                    camera: config.camera,
                    type: detection.type,
                    displayType: getDisplayType(detection.type),
                    confidence: detection.confidence,
                    colour: detection.colour || 'unknown',
                    frameTimestampSeconds: Number(detection.frameTimestampSeconds || 0),
                    originalClipPath: clipPath,
                    clipPath: clipPath,
                    dailyClipPath: path.join(path.dirname(clipPath), 'output.mkv'),
                    thumbnailPath: detection.thumbnailPath || null
                };

                const logged = await logEvent(event);
                if (logged) {
                    stats.eventsLogged++;
                    console.log(`    ✓ ${event.type} (${Math.round(event.confidence * 100)}%) at ${event.timestampLocalDisplay}`);
                } else {
                    stats.duplicatesSkipped++;
                }
            }

            scannerState.processedClips[clipPath] = {
                processedAt: new Date().toISOString(),
                eventCount: detections.length,
                failed: scanResult.failed || false,
                error: scanResult.error || null
            };

            stats.scanned++;
            if (stats.scanned % 10 === 0) {
                await saveState();
            }
        }

        if (stats.scanned > 0) {
            await saveState();
        }

        return stats;
    } catch (err) {
        console.error('✗ Directory scan failed:', err.message);
        return stats;
    }
}

// Main scanner loop
async function startScanner() {
    const enabled = await loadConfig();
    if (!enabled) {
        process.exit(0);
    }
    
    await loadState();
    
    console.log('✓ Event scanner initialized');
    console.log(`  Camera: ${config.camera}`);
    console.log(`  Classes: ${config.classes.join(', ')}`);
    console.log(`  Event log: ${config.eventLogPath}`);
    console.log(`  Scan interval: ${config.scanIntervalSeconds}s`);
    
    // Run initial scan
    await performScan();
    
    // Schedule recurring scans
    setInterval(performScan, config.scanIntervalSeconds * 1000);
}

// Delete per-day event folders older than retentionDays
async function cleanupOldEvents() {
    const retentionDays = config.retentionDays;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = localDateString(cutoff); // YYYY-MM-DD in Europe/London
    const eventsBaseDir = path.dirname(config.eventLogPath);
    let deleted = 0;

    try {
        const years = (await fsAsync.readdir(eventsBaseDir, { withFileTypes: true }))
            .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name));
        for (const year of years) {
            const months = (await fsAsync.readdir(path.join(eventsBaseDir, year.name), { withFileTypes: true }))
                .filter(d => d.isDirectory() && /^\d{2}$/.test(d.name));
            for (const month of months) {
                const days = (await fsAsync.readdir(path.join(eventsBaseDir, year.name, month.name), { withFileTypes: true }))
                    .filter(d => d.isDirectory() && /^\d{2}$/.test(d.name));
                for (const day of days) {
                    const dateKey = `${year.name}-${month.name}-${day.name}`;
                    if (dateKey < cutoffStr) {
                        const dayDir = path.join(eventsBaseDir, year.name, month.name, day.name);
                        await fsAsync.rm(dayDir, { recursive: true, force: true });
                        console.log(`✓ Deleted old event folder: ${dateKey}`);
                        deleted++;
                    }
                }
            }
        }
    } catch (err) {
        console.warn('⚠ Event retention cleanup failed:', err.message);
    }

    if (deleted > 0) {
        console.log(`✓ Retention cleanup: ${deleted} old event day folder(s) removed (retention: ${retentionDays} days)`);
    }
    return deleted;
}

async function performScan() {
    const cameraDir = path.join(config.rootpath, config.camera);
    const totals = { found: 0, skipped: 0, scanned: 0, eventsLogged: 0, duplicatesSkipped: 0 };
    console.log(`\n--- Scan started: ${new Date().toISOString()} ---`);

    try {
        const years = (await fsAsync.readdir(cameraDir, { withFileTypes: true }))
            .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name));
        for (const year of years) {
            const months = (await fsAsync.readdir(path.join(cameraDir, year.name), { withFileTypes: true }))
                .filter(d => d.isDirectory() && /^\d{2}$/.test(d.name));
            for (const month of months) {
                const days = (await fsAsync.readdir(path.join(cameraDir, year.name, month.name), { withFileTypes: true }))
                    .filter(d => d.isDirectory() && /^\d{2}$/.test(d.name));
                for (const day of days) {
                    const dayPath = path.join(cameraDir, year.name, month.name, day.name);
                    const result = await scanDirectory(dayPath);
                    totals.found += result.found;
                    totals.skipped += result.skipped;
                    totals.scanned += result.scanned;
                    totals.eventsLogged += result.eventsLogged;
                    totals.duplicatesSkipped += result.duplicatesSkipped;
                }
            }
        }
    } catch (err) {
        console.error('✗ Scan failed:', err.message);
    }

    console.log(`--- Scan complete: found ${totals.found}, skipped ${totals.skipped}, scanned ${totals.scanned}, events logged ${totals.eventsLogged}, duplicates skipped ${totals.duplicatesSkipped} ---`);
    scannerState.lastScan = Date.now();
    await saveState();
    await cleanupOldEvents();
}

async function scanSingleClip(clipPath, options = {}) {
    const scanResult = await detectEventsInClip(clipPath, { debug: options.debug });
    const detections = scanResult.detections;
    const file = path.basename(clipPath);

    for (const detection of detections) {
        const timestamps = getEventTimestamps(file, detection);
        const eventId = makeEventId(config.camera, timestamps.timestampUtc, detection.type, clipPath);
        const event = {
            eventId,
            timestampUtc: timestamps.timestampUtc,
            timestampLocalDisplay: timestamps.timestampLocalDisplay,
            timestamp: timestamps.timestampUtc,
            eventDateLocal: timestamps.eventDateLocal,
            camera: config.camera,
            type: detection.type,
            displayType: getDisplayType(detection.type),
            confidence: detection.confidence,
            colour: detection.colour || 'unknown',
            frameTimestampSeconds: Number(detection.frameTimestampSeconds || 0),
            originalClipPath: clipPath,
            clipPath: clipPath,
            dailyClipPath: path.join(path.dirname(clipPath), 'output.mkv'),
            thumbnailPath: detection.thumbnailPath || null
        };

        await logEvent(event);
    }

    console.log(`✓ Manual clip scan complete: ${detections.length} event(s)`);
    if (options.debug && scanResult.debugDir) {
        console.log(`✓ Debug output: ${scanResult.debugDir}`);
    }
}

// Start scanner
async function main() {
    const debug = process.argv.includes('--debug');

    const clipArgIndex = process.argv.indexOf('--clip');
    if (clipArgIndex !== -1) {
        const clipPath = process.argv[clipArgIndex + 1];
        if (!clipPath) {
            throw new Error('Usage: node event-scanner.js --clip /path/to/clip.mkv [--debug]');
        }
        await loadConfig({ prepareWhenDisabled: true });
        await loadState();
        await scanSingleClip(path.resolve(clipPath), { debug });
        return;
    }

    const dateArgIndex = process.argv.indexOf('--date');
    if (dateArgIndex !== -1) {
        const dateStr = process.argv[dateArgIndex + 1];
        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            throw new Error('Usage: node event-scanner.js --date YYYY-MM-DD [--debug]');
        }
        await loadConfig({ prepareWhenDisabled: true });
        await loadState();
        const [year, month, day] = dateStr.split('-');
        const dayPath = path.join(config.rootpath, config.camera, year, month, day);
        if (!fs.existsSync(dayPath)) {
            throw new Error(`Day directory not found: ${dayPath}`);
        }
        console.log(`Manual day scan: ${dateStr} — ${dayPath}`);
        const result = await scanDirectory(dayPath, { debug });
        console.log(`Scan complete: found ${result.found}, skipped ${result.skipped}, scanned ${result.scanned}, events logged ${result.eventsLogged}, duplicates skipped ${result.duplicatesSkipped}`);
        await saveState();
        return;
    }

    await startScanner();
}

main().catch(err => {
    console.error('✗ Fatal error:', err);
    process.exit(1);
});
