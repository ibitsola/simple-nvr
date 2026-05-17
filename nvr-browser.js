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
try {
  const eventCfg = require('./event-detection.json');
  if (eventCfg && eventCfg.eventLogPath) {
    app.use('/events', express.static(path.dirname(eventCfg.eventLogPath)));
  }
} catch (err) {
  // config missing -> leave routes untouched
}

// Event Log route
app.get('/events', async (req, res) => {
  const events = [];
  const seen = new Set();

  function dedupeKey(e) {
    return e.eventId || `${e.timestampUtc || e.timestamp}|${e.type}|${e.clipPath || ''}|${e.thumbnailPath || ''}`;
  }

  function readJsonl(data) {
    return data.split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  }

  try {
    const cfg = require('./event-detection.json');
    const eventsBaseDir = path.dirname(cfg.eventLogPath);

    // Backward compat: read old flat log
    if (fs.existsSync(cfg.eventLogPath)) {
      for (const e of readJsonl(await fsAsync.readFile(cfg.eventLogPath, 'utf8'))) {
        const key = dedupeKey(e);
        if (!seen.has(key)) { seen.add(key); events.push(e); }
      }
    }

    // Read per-day logs: eventsBaseDir/YYYY/MM/DD/events.jsonl
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
                const key = dedupeKey(e);
                if (!seen.has(key)) { seen.add(key); events.push(e); }
              }
            }
          }
        }
      }
    } catch (err) {
      // no per-day logs yet; ignore
    }

    events.sort((a, b) => new Date(b.timestampUtc || b.timestamp) - new Date(a.timestampUtc || a.timestamp));

    for (const event of events) {
      // thumbnailUrl: relative to eventsBaseDir, served by static middleware at /events
      event.thumbnailUrl = null;
      if (event.thumbnailPath) {
        const rel = path.relative(eventsBaseDir, event.thumbnailPath);
        if (!rel.startsWith('..')) {
          event.thumbnailUrl = '/events/' + rel.split(path.sep).join('/');
        }
      }

      // videoHref: original 5-min clip → daily output.mkv → null
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
          videoHref = '/' + rel.split(path.sep).join('/');
        }
      }

      event.videoHref = videoHref;
      event.usingDailyFallback = usingDailyFallback;
    }
  } catch (err) {
    console.log('Event log not available:', err.message);
  }
  res.render('event-log', { pageTitle: 'Event Log', events });
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
    const ignoreNames = new Set(['raw', 'lost+found', 'test.txt', 'files.txt']);
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
            if (a.isDirectory) return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
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
