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

        // Merge optional local override file (not committed to git).
        // Any key in event-detection.local.json overwrites the same key in the base config.
        // Example: { "enabled": true, "pythonExecutable": "/home/user/simple-nvr-yolo/bin/python3" }
        const localConfigPath = path.join(__dirname, 'event-detection.local.json');
        try {
            const localData = await fsAsync.readFile(localConfigPath, 'utf8');
            const localConfig = JSON.parse(localData);
            Object.assign(config, localConfig);
            console.log('✓ Local config override applied (event-detection.local.json)');
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn('⚠ Failed to load event-detection.local.json:', err.message);
            }
            // ENOENT is expected — local override file is optional
        }
        
        config.maxFramesPerClip = Number(config.maxFramesPerClip || 8);
        config.sampleEverySeconds = Number(config.sampleEverySeconds || 30);
        config.minConfidence = Number(config.minConfidence || 0.5);
        config.classes = config.classes || ['person', 'cat'];
        // tempFrameDir defaults to a subdirectory of the recording rootpath so
        // extracted frames land on the external disk, not tmpfs /tmp.
        config.tempFrameDir = config.tempFrameDir || path.join(config.rootpath, 'tmp', 'simple-nvr-events');
        config.pythonExecutable = config.pythonExecutable || 'python3';
        config.pythonDetectorPath = config.pythonDetectorPath || 'scripts/detect-events.py';
        config.yoloModel = config.yoloModel || 'yolov8n.pt';
        config.retentionDays = Number(config.retentionDays || 30);
        config.classConfidence = config.classConfidence || {};
        config.yoloImageSize = Number(config.yoloImageSize || 640);
        config.pythonTimeoutMs = Number(config.pythonTimeoutMs || DETECTOR_TIMEOUT_MS);
        // scanLookbackDays: how many days back the automatic scan covers (0 = today only,
        // 1 = today + yesterday, etc.).  Use != null so that 0 is a valid value.
        config.scanLookbackDays = config.scanLookbackDays != null ? Number(config.scanLookbackDays) : 1;
        const motionCfg = config.motionDetection || {};
        config.motionDetection = {
            enabled: Boolean(motionCfg.enabled),
            logMotionEvents: Boolean(motionCfg.logMotionEvents),
            minChangedAreaPercent: Number(motionCfg.minChangedAreaPercent || 0.05),
            minMotionBlobPixels: Number(motionCfg.minMotionBlobPixels || 50),
            maxMotionBlobPercent: Number(motionCfg.maxMotionBlobPercent || 5.0),
        };

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

// Load or initialize scanner state.
// Sets scannerState._isNewState = true when the file did not previously exist
// (fresh install / first deployment) so the caller can seed the state.
async function loadState() {
    try {
        const statePath = path.join(path.dirname(config.eventLogPath), 'scanner-state.json');
        const stateData = await fsAsync.readFile(statePath, 'utf8');
        scannerState = JSON.parse(stateData);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('⚠ Failed to load scanner state (will reinitialise):', err.message);
        }
        // File doesn't exist yet (or was unreadable) — start with empty state.
        scannerState = {
            lastScan: 0,
            processedClips: {},
            _isNewState: true
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
        '--model', config.yoloModel,
        '--imgsz', String(config.yoloImageSize)
    ];

    if (options.includeAllClasses) {
        args.push('--include-all-classes');
    }
    if (config.motionDetection && config.motionDetection.enabled) {
        args.push('--motion-detection-enabled');
        args.push('--motion-min-area-percent', String(config.motionDetection.minChangedAreaPercent));
        args.push('--motion-min-blob-pixels', String(config.motionDetection.minMotionBlobPixels));
        args.push('--motion-max-blob-percent', String(config.motionDetection.maxMotionBlobPercent));
    }

    const { stdout } = await runCommand(config.pythonExecutable, args, { timeoutMs: config.pythonTimeoutMs });
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
            if (detectorResult.motionAnalysis) {
                await writeJsonFile(path.join(debugDir, 'motion-analysis.json'), detectorResult.motionAnalysis);
            }
        }

        // If motion detection ran and found no activity, skip YOLO results entirely
        const motionEnabled = config.motionDetection && config.motionDetection.enabled;
        if (motionEnabled && detectorResult.motionDetected === false) {
            if (debug) {
                await writeJsonFile(path.join(debugDir, 'deduped-detections.json'), []);
            }
            return { detections: [], motionSkipped: true, failed: false, debugDir };
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

        // Motion fallback: YOLO ran but found nothing classifiable; log a generic motion event.
        // Only runs when motionDetection.logMotionEvents is explicitly enabled in config.
        // Disabled by default — generic motion events tend to be noisy (flies, headlights, etc.).
        const logMotionEvents = config.motionDetection && config.motionDetection.logMotionEvents;
        if (deduped.length === 0 && motionEnabled && logMotionEvents && detectorResult.motionDetected === true) {
            const motionFallback = {
                type: 'motion',
                confidence: 1.0,
                colour: 'unknown',
                framePath: detectorResult.bestMotionFramePath || null,
                frameTimestampSeconds: Number(detectorResult.bestMotionFrameTimestampSeconds || 0),
            };
            motionFallback.thumbnailPath = await createThumbnail(clipPath, motionFallback, dayThumbnailDir);
            deduped.push(motionFallback);
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

        // Only scan output.mkv when no individual 5-minute clips exist for this day.
        // When regular clips exist, output.mkv is a concatenated copy — skip it to avoid
        // double-counting.  When it is the only file (clips were already deleted after
        // concatenation), scan it as the best available source for that day.
        const hasRegularClips = allMkvFiles.some(f => f !== 'output.mkv');
        if (hasRegularClips && allMkvFiles.includes('output.mkv')) {
            console.log(`  ℹ output.mkv skipped in ${dirPath} (${allMkvFiles.length - 1} individual clip(s) present)`);
        }

        for (const file of allMkvFiles) {
            const clipPath = path.join(dirPath, file);

            if (file === 'output.mkv' && hasRegularClips) {
                stats.skipped++;
                continue;
            }

            if (file === 'output.mkv' && !hasRegularClips) {
                console.log(`  ℹ Scanning output.mkv in ${dirPath} (no individual clips found — using concatenated day file)`);
            }

            if (!options.ignoreState && scannerState.processedClips[clipPath]) {
                stats.skipped++;
                continue;
            }

            console.log(`  → Scanning: ${clipPath}`);
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

// On first startup (no scanner-state.json), mark all existing clips in the lookback
// window as already processed so they are not automatically backfilled.
// New clips created after this point will be picked up by the normal scan loop.
async function seedScannerState() {
    const cameraDir = path.join(config.rootpath, config.camera);
    const lookbackCutoff = new Date();
    lookbackCutoff.setDate(lookbackCutoff.getDate() - config.scanLookbackDays);
    const cutoffStr = localDateString(lookbackCutoff);
    const now = new Date().toISOString();
    let seeded = 0;
    try {
        const years = (await fsAsync.readdir(cameraDir, { withFileTypes: true }))
            .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name));
        for (const year of years) {
            if (year.name < cutoffStr.slice(0, 4)) continue;
            const months = (await fsAsync.readdir(path.join(cameraDir, year.name), { withFileTypes: true }))
                .filter(d => d.isDirectory() && /^\d{2}$/.test(d.name));
            for (const month of months) {
                if (`${year.name}-${month.name}` < cutoffStr.slice(0, 7)) continue;
                const days = (await fsAsync.readdir(path.join(cameraDir, year.name, month.name), { withFileTypes: true }))
                    .filter(d => d.isDirectory() && /^\d{2}$/.test(d.name));
                for (const day of days) {
                    const dateKey = `${year.name}-${month.name}-${day.name}`;
                    if (dateKey < cutoffStr) continue;
                    const dayPath = path.join(cameraDir, year.name, month.name, day.name);
                    try {
                        const files = await fsAsync.readdir(dayPath);
                        for (const file of files.filter(f => f.endsWith('.mkv'))) {
                            const clipPath = path.join(dayPath, file);
                            if (!scannerState.processedClips[clipPath]) {
                                scannerState.processedClips[clipPath] = {
                                    processedAt: now,
                                    eventCount: 0,
                                    skippedAtBoot: true
                                };
                                seeded++;
                            }
                        }
                    } catch (e) { /* skip unreadable directories */ }
                }
            }
        }
    } catch (err) {
        console.warn('⚠ Bootstrap state seed failed (non-fatal):', err.message);
    }
    console.log(`  ${seeded} existing clip(s) marked as pre-existing — will not be automatically scanned`);
}

// Main scanner loop
async function startScanner() {
    const enabled = await loadConfig();
    if (!enabled) {
        process.exit(0);
    }

    await loadState();

    const isNewState = scannerState._isNewState === true;
    delete scannerState._isNewState;

    console.log('\nAutomatic scan mode');
    console.log(`  Lookback window: ${config.scanLookbackDays} day(s)`);
    console.log(`  Camera: ${config.camera}`);
    console.log(`  Classes: ${config.classes.join(', ')}`);
    console.log(`  Event log: ${config.eventLogPath}`);
    console.log(`  Scan interval: ${config.scanIntervalSeconds}s`);

    if (isNewState) {
        console.log('\n  No scanner state found — initialising from current time (no automatic backfill)');
        console.log('  Use: node event-scanner.js --date YYYY-MM-DD  to backfill historical clips manually');
        await seedScannerState();
        await saveState();
        console.log('✓ Scanner state initialised');
    } else {
        console.log('✓ Event scanner initialised');
    }

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

    // Compute lookback window in Europe/London local date strings (YYYY-MM-DD).
    // scanLookbackDays: 1 → today + yesterday; 0 → today only.
    const lookbackCutoff = new Date();
    lookbackCutoff.setDate(lookbackCutoff.getDate() - config.scanLookbackDays);
    const cutoffStr = localDateString(lookbackCutoff);
    const todayStr = localDateString(new Date());
    console.log(`\n--- Scan started: ${new Date().toISOString()} (scanning ${cutoffStr} → ${todayStr}, lookbackDays=${config.scanLookbackDays}) ---`);

    try {
        const years = (await fsAsync.readdir(cameraDir, { withFileTypes: true }))
            .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name));
        for (const year of years) {
            // Skip entire year if it is before the cutoff year
            if (year.name < cutoffStr.slice(0, 4)) continue;
            const months = (await fsAsync.readdir(path.join(cameraDir, year.name), { withFileTypes: true }))
                .filter(d => d.isDirectory() && /^\d{2}$/.test(d.name));
            for (const month of months) {
                // Skip entire month if YYYY-MM is before cutoff
                if (`${year.name}-${month.name}` < cutoffStr.slice(0, 7)) continue;
                const days = (await fsAsync.readdir(path.join(cameraDir, year.name, month.name), { withFileTypes: true }))
                    .filter(d => d.isDirectory() && /^\d{2}$/.test(d.name));
                for (const day of days) {
                    const dateKey = `${year.name}-${month.name}-${day.name}`;
                    if (dateKey < cutoffStr) {
                        // Outside lookback window — silently skip
                        continue;
                    }
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
        const result = await scanDirectory(dayPath, { debug, ignoreState: true });
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
