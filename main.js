const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require("electron-updater");
const fixPath = require('fix-path');
const chokidar = require('chokidar');
const prettyBytes = require('pretty-bytes');
const path = require('path');
const state = require('./src/state.js');
const api = require('./src/api.js');
const docker = require('./src/docker.js');
const singularity = require('./src/singularity.js');
const rsync = require('./src/rsync.js');
let win = undefined;


function init() {
    delete process.env.DISPLAY; // req'd so ssh connection terminates when executing single commands e.g. ssh user@cubic cmd
    singularity.rsyncInstance = rsync;
    let watcher = chokidar.watch([], {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true
    });
    watcher.on('all', (event, fn, stats) => {
        if (!event.includes("Dir")) {
            fn = path.dirname(fn)
        }
        if (!rsync.watched.has(fn)) {
            rsync.watched.add(fn);
        }
        if (!state.data.syncNeeded.has(fn)) {
            state.data.syncNeeded.add(fn);   
        }
        rsync.fileStats[fn] = stats;
        rsync.fileStats[fn].size = prettyBytes(rsync.fileStats[fn].size);
        win.webContents.send('asynchronous-message', { type: 'remakeDataTab', files: rsync.watched, notSynced: state.data.syncNeeded, stats: rsync.fileStats });
    });
    rsync.watcher = watcher;
    fixPath();
    createWindow();
    autoUpdater.checkForUpdatesAndNotify();
}

function createWindow() {
    // Create the browser window.
    win = new BrowserWindow({
        width: 880,
        height: 900,
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            nodeIntegration: true
        }
    });
    win.loadFile('html/index.html');
    win.webContents.on('did-finish-load', () => {
        state.refreshWindowState(win, {
            singularity: singularity,
            docker: docker,
            rsync: rsync
        });
    });
    win.webContents.on('new-window', function (e, url) {
        // https://stackoverflow.com/a/32427579/2624391
        e.preventDefault();
        shell.openExternal(url);
    });
}

// Quit when all windows are closed.
app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit();
    }
    win = undefined;
});

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

ipcMain.on('asynchronous-message', (event, json) => {
    api.request(json, state, win, docker, singularity, rsync);
});

app.whenReady().then(init);
