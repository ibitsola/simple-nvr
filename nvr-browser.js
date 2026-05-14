const path = require('path');
require('dotenv').config();
const fsAsync = require('fs').promises;

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
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Europe/London'
    });
    
    return formatter.format(date);
}

// set view engine
app.set('view engine', 'ejs');
app.set('views', 'views');

// initialise the video-serving code
app.use(require('./video-file-server'));

app.use(express.static('public'));

app.get('*.:ext', async (req, res, next) => {
    const filetype = req.params.ext;
    const route = `${req.params['0']}.${filetype}`.split('/').filter(x => x.length > 0);

    const breadcrumbs = [];
    const currentParts = [];
    for (let i = 0; i < route.length; i++) {
        const folder = route[i];
        breadcrumbs.push({
            name: folder,
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
        breadcrumbs.push({
            name: folder,
            route: '/' + [...currentParts, folder].join('/')
        })
        currentParts.push(folder);
    }

    const directory = path.join(storage.rootpath, ...route);
    const folderItems = (await fsAsync.readdir(directory, { withFileTypes: true }))
        .map(dirent => {
            const name = dirent.name;
            const isDirectory = dirent.isDirectory();
            let displayName = name;
            if (!isDirectory && name.endsWith('.mkv')) {
                displayName = parseVideoDisplayName(name);
            }
            return {
                name,
                route: `/${[...route, name].join('/')}`,
                displayName,
                isDirectory
            };
        });
    const locations = [];
    for (let i = 0; i < folderItems.length; i++) {
        const folderItem = folderItems[i];
        locations.push({
            name: folderItem.name,
            route: folderItem.route,
            displayName: folderItem.displayName
        })
    }

    res.render('folder', {
        pageTitle: 'Cameras',
        route: breadcrumbs,
        locations: locations
    })
})

app.listen(port, () => {
    console.log(`*** Server listening on port ${port} ***`);
})
