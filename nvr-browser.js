const path = require('path');
require('dotenv').config();
const fsAsync = require('fs').promises;
const fs = require('fs');

const express = require('express');
const app = express();
const basicAuth = require('express-basic-auth');

const viewerUsername = process.env.CCTV_VIEWER_USERNAME;
const viewerPassword = process.env.CCTV_VIEWER_PASSWORD;

if (!viewerUsername || !viewerPassword) {
    console.error('Missing CCTV_VIEWER_USERNAME or CCTV_VIEWER_PASSWORD environment variable');
    process.exit(1);
}

app.use(basicAuth({
    users: { [viewerUsername]: viewerPassword },
    challenge: true
}));
const storage = require('./storage.json');

const port = 3000;

function parseVideoDisplayName(filename) {
    if (filename === 'output.mkv') {
        return 'Full day recording';
    }
    const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}) (\d{2}) (\d{2})\.mkv$/);
    if (!match) return filename;
    
    // Parse filename timestamp as UTC
    const year = match[1];
    const month = match[2];
    const day = match[3];
    const hour = match[4];
    const minute = match[5];
    const second = match[6];
    
    const utcDateString = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
    const date = new Date(utcDateString);
    
    if (isNaN(date.getTime())) return filename;
    
    // Convert to Europe/London timezone (handles BST/GMT automatically)
    const formatter = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Europe/London'
    });
    
    return formatter.format(date);
}

function parseDayFolderDisplayName(folderName, route) {
    if (!/^\d{2}$/.test(folderName)) return folderName;
    if (route.length < 3) return folderName;
    const year = route[route.length - 2];
    const month = route[route.length - 1];
    if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month)) return folderName;
    const date = new Date(`${year}-${month}-${folderName}T00:00:00Z`);
    if (Number.isNaN(date.valueOf())) return folderName;
    const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    const monthName = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    const dayNumber = date.getUTCDate();
    return `${weekday} ${dayNumber} ${monthName}`;
}

// set view engine
app.set('view engine', 'ejs');
app.set('views', 'views');

// initialise the video-serving code
app.use(require('./video-file-server'));

app.use(express.static('public'));

// Serve event assets (flat + per-day thumbnails) from the events base directory
// Use /events-static to avoid conflicting with the /events page route and *.:ext catch-all
try {
  const eventCfg = require('./event-detection.json');
  if (eventCfg && eventCfg.eventLogPath) {
    app.use('/events-static', express.static(path.dirname(eventCfg.eventLogPath)));
  }
} catch (err) {
  // config missing -> leave routes untouched
}

// Event Log route
app.get('/events', async (req, res) => {
  function readJsonl(data) {
    return data.split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  }

  // Canonical dedup key: camera + UTC timestamp + type.
  // Deliberately does NOT use eventId so that a flat-log entry (no eventId) and a
  // per-day entry (has eventId) for the same real event share the same key.
  function canonicalKey(e) {
    const ts = e.timestampUtc || e.timestamp || '';
    return `${e.camera || ''}|${ts}|${e.type || ''}`;
  }

  // Higher score = richer / prefer to keep
  function richness(e) {
    let score = 0;
    if (e.eventId) score += 4;
    if (e.eventDateLocal) score += 2;
    if (e.originalClipPath || e.dailyClipPath) score += 1;
    return score;
  }

  // Extract a YYYY-MM-DD string for grouping
  function getEventDate(e) {
    if (e.eventDateLocal) return e.eventDateLocal;
    if (e.timestampLocalDisplay) {
      const m = e.timestampLocalDisplay.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    }
    const ts = e.timestampUtc || e.timestamp;
    return ts ? ts.slice(0, 10) : 'unknown';
  }

  const byKey = new Map(); // canonical key -> best event seen so far

  function mergeEvent(e) {
    const key = canonicalKey(e);
    const existing = byKey.get(key);
    if (!existing || richness(e) > richness(existing)) {
      byKey.set(key, e);
    }
  }

  try {
    const cfg = require('./event-detection.json');
    const eventsBaseDir = path.dirname(cfg.eventLogPath);

    // Per-day logs first — they are the richer, canonical source
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
            const dayLog = path.join(eventsBaseDir, year.name, month.name, day.name, 'events.jsonl');
            if (fs.existsSync(dayLog)) {
              for (const e of readJsonl(await fsAsync.readFile(dayLog, 'utf8'))) {
                mergeEvent(e);
              }
            }
          }
        }
      }
    } catch (err) {
      // no per-day logs yet; ignore
    }

    // Flat legacy log — only adds entries not already covered by per-day logs
    if (fs.existsSync(cfg.eventLogPath)) {
      for (const e of readJsonl(await fsAsync.readFile(cfg.eventLogPath, 'utf8'))) {
        mergeEvent(e); // per-day events already have higher richness and will win ties
      }
    }

    // Sort all deduplicated events newest first
    const allEvents = [...byKey.values()];
    allEvents.sort((a, b) => new Date(b.timestampUtc || b.timestamp) - new Date(a.timestampUtc || a.timestamp));

    // Decorate with thumbnailUrl and videoHref
    for (const event of allEvents) {
      event.thumbnailUrl = null;
      if (event.thumbnailPath) {
        const rel = path.relative(eventsBaseDir, event.thumbnailPath);
        if (!rel.startsWith('..')) {
          event.thumbnailUrl = '/events-static/' + rel.split(path.sep).join('/');
        }
      }

      const originalClip = event.originalClipPath || event.clipPath;
      const dailyClip = event.dailyClipPath ||
        (originalClip ? path.join(path.dirname(originalClip), 'output.mkv') : null);

      let videoHref = null;
      let usingDailyFallback = false;
      let clipToUse = null;
      if (originalClip && fs.existsSync(originalClip)) {
        clipToUse = originalClip;
      } else if (dailyClip && fs.existsSync(dailyClip)) {
        clipToUse = dailyClip;
        usingDailyFallback = true;
      }
      if (clipToUse) {
        const rel = path.relative(storage.rootpath, clipToUse);
        if (!rel.startsWith('..')) {
          videoHref = '/' + rel.split('/').map(encodeURIComponent).join('/');
        }
      }

      event.videoHref = videoHref;
      event.usingDailyFallback = usingDailyFallback;
    }

    // Group by local date, newest date first
    const groupMap = new Map();
    for (const e of allEvents) {
      const d = getEventDate(e);
      if (!groupMap.has(d)) groupMap.set(d, []);
      groupMap.get(d).push(e);
    }

    const groupedEvents = [...groupMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([dateKey, evs]) => {
        const parts = dateKey.split('-');
        const label = parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : dateKey;
        return { label, events: evs };
      });

    res.render('event-log', { pageTitle: 'Event Log', groupedEvents });
  } catch (err) {
    console.log('Event log not available:', err.message);
    res.render('event-log', { pageTitle: 'Event Log', groupedEvents: [] });
  }
});

app.get('*.:ext', async (req, res, next) => {
    const filetype = req.params.ext;
    const route = `${req.params['0']}.${filetype}`.split('/').filter(x => x.length > 0);

    const breadcrumbs = [];
    const currentParts = [];
    for (let i = 0; i < route.length; i++) {
        const folder = route[i];
        const isLastItem = i === route.length - 1;
        let displayName = folder;
        
        if (isLastItem && folder.endsWith('.mkv')) {
            displayName = parseVideoDisplayName(folder);
        }
        
        breadcrumbs.push({
            name: folder,
            displayName: displayName,
            route: '/' + [...currentParts, folder].join('/')
        })
        currentParts.push(folder);
    }

    const filename = route[route.length - 1];
    res.render('video', {
        pageTitle: parseVideoDisplayName(filename),
        videoUrl: `/api/${req.params['0']}.${filetype}`,
        route: breadcrumbs
    })
})

app.get('*', async (req, res, next) => {
    const route = req.params['0'].split('/').filter(x => x.length > 0);

    const breadcrumbs = [];
    const currentParts = [];
    for (let i = 0; i < route.length; i++) {
        const folder = route[i];
        let displayName = folder;
        
        if (route.length >= 3 && i === route.length - 1 && /^\d{2}$/.test(folder)) {
            displayName = parseDayFolderDisplayName(folder, route.slice(0, i));
        }
        
        breadcrumbs.push({
            name: folder,
            displayName: displayName,
            route: '/' + [...currentParts, folder].join('/')
        })
        currentParts.push(folder);
    }

    const directory = path.join(storage.rootpath, ...route);
    // 'tmp' contains internal working storage (MP4 cache, event frames, extracted clips)
    // and must never appear as a camera/folder option in the UI.
    const ignoreNames = new Set(['raw', 'lost+found', 'test.txt', 'files.txt', 'tmp']);
    const folderItems = (await fsAsync.readdir(directory, { withFileTypes: true }))
        .filter(dirent => !ignoreNames.has(dirent.name))
        .map(dirent => {
            const name = dirent.name;
            const isDirectory = dirent.isDirectory();
            const type = isDirectory ? 'folder' : (name.endsWith('.mkv') ? 'video' : 'file');
            let displayName = name;

            if (type === 'video') {
                displayName = parseVideoDisplayName(name);
            } else if (type === 'folder' && route.length >= 3) {
                displayName = parseDayFolderDisplayName(name, route);
            }

            return {
                name,
                route: `/${[...route, name].join('/')}`,
                type,
                isDirectory,
                displayName
            };
        })
        .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            // Sort directories newest-first (reverse alpha/numeric) so days, months, years show
            // most-recent at the top. Videos already sort newest-first via the same reverse compare.
            if (a.isDirectory) return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
            return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
        });
    
    const locations = [];
    for (let i = 0; i < folderItems.length; i++) {
        const folderItem = folderItems[i];
        locations.push({
            name: folderItem.name,
            route: folderItem.route,
            type: folderItem.type,
            displayName: folderItem.displayName
        })
    }

    res.render('folder', {
        pageTitle: 'CCTV Viewer',
        route: breadcrumbs,
        locations: locations
    })
})

app.listen(port, () => {
    console.log(`*** Server listening on port ${port} ***`);
})
