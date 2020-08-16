const Rsync = require('rsync');
const exec = require('child_process').exec;
const rsync = {

    watcher: undefined,
    watched: new Set(),
    fileStats: {},

    progress: (d) => {
        let x = d.split(/(\s+)/).filter(function (e) { return e.trim().length > 0; });
        // example of x:
        // [
        //   '7070782',
        //   '100%',
        //   '6.31MB/s',
        //   '0:00:01',
        //   '(xfer#102,',
        //   'to-check=92/202)'
        // ]
        if (x.length === 6 && x[4].substring(0, 5) !== '(xfer#') {
            let f = x[5].substring(9, x[5].length - 1);
            return {
                percent: 100 - ((f.split('/')[0] / f.split('/')[1]) * 100),
                speed: x[2]
            }
        } else {
            return undefined;
        }
    },

    transfer: (state, win, path) => {
        if (path === undefined || state.data.user === 'nobody') {
            return;
        }
        const rsync = new Rsync()
            .shell('ssh')
            .flags('az')
            .progress()
            .source(path)
            .set('timeout', '10')
            .exclude(['.git', '.DS_Store'])
            .set('rsync-path', `mkdir -p ~/.cubedata${path} && rsync`) // https://stackoverflow.com/a/22908437/2624391
            .destination(`${state.data.user}@cubic-login:~/.cubedata${path}`);

        rsync.execute(
            function (error, code, cmd) {
                // we're done
                if (code === 0) { // success!
                    win.webContents.send('asynchronous-message', { type: 'rsyncComplete', path: path });
                    state.data.syncNeeded.delete(path);
                    // win.webContents.send('asynchronous-message', { type: 'alert', message: `Connected to ${state.data.cloud}`, level: 'success' });
                } else {
                    win.webContents.send('asynchronous-message', { type: 'alert', message: 'No remote connection', level: 'warning' });
                }
            }, function (data) {
                // parse progress
                win.webContents.send('asynchronous-message', { type: 'rsync', path: path, progress: module.exports.progress(data.toString()) })
            }
        )

    },
    downloadAndRestoreBackup: (state, win, path, timeStr) => {
        if (path === undefined || state.data.user === 'nobody') {
            return;
        }
        const rsync = new Rsync()
            .shell('ssh')
            .flags('az')
            .progress()
            .source(`${state.data.user}@cubic-login:~/.cubedata${path}`)
            .set('timeout', '10')
            .exclude(['.git', '.DS_Store'])
            .destination(path);

        rsync.execute(
            function (error, code, cmd) {
                if (code === 0) {
                    win.webContents.send('asynchronous-message', { type: 'rsyncComplete', path: path });
                    state.data.syncNeeded.delete(path);
                    // win.webContents.send('asynchronous-message', { type: 'alert', message: `Connected to ${state.data.cloud}`, level: 'success' });
                    // overwrite original with backup and add to watched list
                    const restore = exec(`ssh -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ${state.data.user}@cubic-login "mv ~/.cubedata${path}/.snapshots/${timeStr} ~/.cubedata${path}"`);
                    restore.on('exit', (code) => {
                        module.exports.watcher.add(path);
                        win.webContents.send('asynchronous-message', { type: 'alert', message: "<strong>Success!</strong> Restored " + path + " from " + timeStr, level: 'success' });
                    });
                } else {
                    win.webContents.send('asynchronous-message', { type: 'alert', message: 'No remote connection', level: 'warning' });
                }
            }, function (data) {
                win.webContents.send('asynchronous-message', { type: 'rsync', path: path, progress: module.exports.progress(data.toString()) })
            }
        )
    },
    interval: (state, win, loop) => {
        for (let i = 0; i < state.data.syncNeeded.size; i++) {
            module.exports.transfer(state, win, state.data.syncNeeded[i]);
        }
        win.webContents.send('asynchronous-message', { type: 'remakeDataTab', files: module.exports.watched, notSynced: state.data.syncNeeded, stats: module.exports.fileStats, remote: state.findRemoteMounts() });
        if (loop) {
            setTimeout(() => module.exports.interval(state, win, true), 900000) // = 15 mins
        }
    }

}
module.exports = rsync;