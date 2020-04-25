const Rsync = require('rsync');
const rsync = {

    transfer: function (state, win, path) {
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
            .destination(`${state.data.user}@cbica-cluster:~/.cubedata${path}`);

        const progress = (d) => {
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
        };

        rsync.execute(
            function (error, code, cmd) {
                // we're done
                if (code === 0) { // success!
                    win.webContents.send('asynchronous-message', { type: 'rsyncComplete', path: path });
                    const index = state.data.syncNeeded.indexOf(path);
                    if (index > -1) {
                        state.data.syncNeeded.splice(index, 1);
                    }
                    win.webContents.send('asynchronous-message', { type: 'clearAlert' });
                } else {
                    win.webContents.send('asynchronous-message', { type: 'alert', message: `<strong>ssh ${state.data.user}@cbica-cluster</strong> failed; Unable to connect to CUBIC.` });
                }
            }, function (data) {
                // parse progress
                win.webContents.send('asynchronous-message', { type: 'rsync', path: path, progress: progress(data.toString()) })
            }
        )

        return;
    },
    interval: function(state, win, loop = true) {
        for (let i = 0; i < state.data.syncNeeded.length; i++) {
            module.exports.transfer(state, win, state.data.syncNeeded[i]);
        }
        if (loop) {
            setTimeout(() => module.exports.interval(state, win), 900000) // = 15 mins
        }
    }

}
module.exports = rsync;