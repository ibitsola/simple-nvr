const path = require('path');
const fs = require('fs');
const fsAsync = require('fs').promises;
require('dotenv').config();

let config = {};
let scannerState = {};

// Initialize configuration
async function loadConfig() {
    try {
        const configPath = path.join(__dirname, 'event-detection.json');
        const configData = await fsAsync.readFile(configPath, 'utf8');
        config = JSON.parse(configData);
        console.log('✓ Event detection config loaded');
        
        if (!config.enabled) {
            console.log('ℹ Event detection is disabled in config');
            return false;
        }
        
        // Ensure directories exist
        await fsAsync.mkdir(path.dirname(config.eventLogPath), { recursive: true });
        await fsAsync.mkdir(config.thumbnailDir, { recursive: true });
        
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
}

// Save scanner state
async function saveState() {
    try {
        const statePath = path.join(path.dirname(config.eventLogPath), 'scanner-state.json');
        await fsAsync.writeFile(statePath, JSON.stringify(scannerState, null, 2));
    } catch (err) {
        console.error('✗ Failed to save scanner state:', err.message);
    }
}

// Placeholder detection function
// In Phase 2, this will be replaced with actual YOLO/OpenCV detection
async function detectEventsInClip(clipPath) {
    // PHASE 2: Replace this with real YOLO/OpenCV detection
    // For now, return empty array (no false positives)
    // 
    // Future implementation should:
    // 1. Extract frames from MKV using ffmpeg
    // 2. Run YOLO inference on sampled frames
    // 3. Filter detections by minConfidence
    // 4. Extract bounding boxes as thumbnails
    // 5. Return array of { type, confidence, timestamp, thumbnailPath }
    
    if (config.mockMode) {
    // Mock a sample event (one per clip) for testing
    console.log('(mock) Scanning:', clipPath);
    const now = new Date().toISOString();
    return [{
        type: 'cat',
        confidence: 0.82,
        colour: 'unknown',
        timestamp: now,
        thumbnailPath: null
    }];
    }
    
    return [];
}

// Log event to JSONL file
async function logEvent(event) {
    try {
        const eventLine = JSON.stringify(event) + '\n';
        await fsAsync.appendFile(config.eventLogPath, eventLine);
        console.log('✓ Event logged:', event.type, 'at', event.timestamp);
    } catch (err) {
        console.error('✗ Failed to log event:', err.message);
    }
}

// Parse UTC timestamp from MKV filename and convert to Europe/London local time
function parseClipTimestamp(filename) {
    const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}) (\d{2}) (\d{2})\.mkv$/);
    if (!match) return null;
    
    const utcDateStr = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
    const utcDate = new Date(utcDateStr);
    
    if (isNaN(utcDate.getTime())) return null;
    
    // Return ISO 8601 string with Europe/London timezone offset
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
    
    const localStr = formatter.format(utcDate);
    // localStr is in format: DD/MM/YYYY, HH:mm:ss
    // We need to handle BST offset manually
    const offset = utcDate.toLocaleString('en-GB', { timeZone: 'Europe/London' }) < utcDate.toLocaleString('en-GB', { timeZone: 'UTC' }) ? '+01:00' : '+00:00';
    
    return utcDate.toISOString();
}

// Scan clips in directory
async function scanDirectory(dirPath) {
    try {
        const files = await fsAsync.readdir(dirPath);
        let scanned = 0;
        
        for (const file of files) {
            if (!file.endsWith('.mkv')) continue;
            
            const clipPath = path.join(dirPath, file);
            
            // Skip if already processed
            if (scannerState.processedClips[clipPath]) {
                continue;
            }
            
            // Run detection
            const detections = await detectEventsInClip(clipPath);
            
            // Log any detected events
            for (const detection of detections) {
                const event = {
                    timestamp: parseClipTimestamp(file),
                    camera: config.camera,
                    type: detection.type,
                    confidence: detection.confidence,
                    colour: detection.colour || 'unknown',
                    clipPath: clipPath,
                    thumbnailPath: detection.thumbnailPath || null
                };
                
                await logEvent(event);
            }
            
            // Mark as processed
            scannerState.processedClips[clipPath] = {
                processedAt: new Date().toISOString(),
                eventCount: detections.length
            };
            
            scanned++;
            
            // Save state periodically
            if (scanned % 10 === 0) {
                await saveState();
            }
        }
        
        if (scanned > 0) {
            console.log(`✓ Scanned ${scanned} new clips`);
            await saveState();
        }
        
        return scanned;
    } catch (err) {
        console.error('✗ Directory scan failed:', err.message);
        return 0;
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

async function performScan() {
    const cameraDir = path.join(config.rootpath, config.camera);
    
    try {
        // Scan YYYY/MM/DD directory structure
        const years = await fsAsync.readdir(cameraDir);
        
        for (const year of years) {
            const yearPath = path.join(cameraDir, year);
            const yearStats = await fsAsync.stat(yearPath);
            if (!yearStats.isDirectory()) continue;
            
            const months = await fsAsync.readdir(yearPath);
            for (const month of months) {
                const monthPath = path.join(yearPath, month);
                const monthStats = await fsAsync.stat(monthPath);
                if (!monthStats.isDirectory()) continue;
                
                const days = await fsAsync.readdir(monthPath);
                for (const day of days) {
                    const dayPath = path.join(monthPath, day);
                    const dayStats = await fsAsync.stat(dayPath);
                    if (!dayStats.isDirectory()) continue;
                    
                    await scanDirectory(dayPath);
                }
            }
        }
    } catch (err) {
        console.error('✗ Scan failed:', err.message);
    }
    
    scannerState.lastScan = Date.now();
}

// Start scanner
startScanner().catch(err => {
    console.error('✗ Fatal error:', err);
    process.exit(1);
});
