const { app, BrowserWindow, ipcMain, shell } = require('electron');
const {autoUpdater} = require("electron-updater");
const storage = require('electron-json-storage');
const exec = require('child_process').exec;
const Rsync = require('rsync');
const fixPath = require('fix-path');
const chokidar = require('chokidar');
const watcher = chokidar.watch([], {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true
});

let win = undefined;
let state = {
    user: 'nobody',
    singularity: {
        containers: {}
    },
    docker: {
        containers: {}
    },
    deployments: [],
    refreshInterval: 90000,
    syncNeeded: []
};

function init() {
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
        refreshWindowState();
    });
    win.webContents.on('new-window', function(e, url) {
        // https://stackoverflow.com/a/32427579/2624391
        e.preventDefault();
        shell.openExternal(url);
    });
}

function refreshWindowState() {
    storage.has('state', function (error, hasKey) {
        if (error) throw error;
        if (hasKey) {
            storage.get('state', function (error, object) {
                if (error) throw error;
                state = object;
                win.webContents.send('asynchronous-message', { type: 'setUser', user: state.user });
                win.webContents.send('asynchronous-message', { type: 'setRefreshInterval', interval: state.refreshInterval });
                for (const key in state.deployments) {
                    if (state.deployments.hasOwnProperty(key)) {
                        win.webContents.send('asynchronous-message', Object.assign({ type: 'addDeployment' }, state.deployments[key]));
                        const mounts = state.deployments[key].bindMounts;
                        for (let i = 0; i < mounts.length; i++) {
                            const mount = mounts[i];
                            const file = mount.local;
                            if (!Object.keys(watcher.getWatched()).includes(file)) {
                                watcher.add(file);
                                rsync(file);
                            }
                        }
                    }
                }
                let merged = {...state.docker.containers, ...state.singularity.containers};
                for (const key in merged) {
                    if (merged.hasOwnProperty(key)) {
                        addContainerFrontend(merged[key]);
                    }
                }
                watcher.on('change', (path) => {
                    state.syncNeeded.push(path);
                });
                refreshInterval();
                syncInterval();
            });
        } else {
            singularityPs();
            dockerPs();
        }
    });
}

function saveState() {
    storage.set('state', state, function (error) {
        if (error) throw error;
    });
}

function dockerPs() {
    const ps = exec("docker ps --format '{{json .}}'");
    ps.stdout.on('data', function (data) {
        let containers = {};
        let response = data.split(/\r?\n/);
        // get current containers
        for (let i = 0; i < response.length; i++) {
            try {
                const container = JSON.parse(response[i].trim());
                containers[container.ID] = {
                    id: container.ID,
                    name: container.Names + ' (' + container.Image + ')',
                    state: container.Status,
                    age: new Date(container.CreatedAt)
                };
            } catch (e) {
                // console.log('todo', e);
            }
        }
        for (const key in containers) {
            if (containers.hasOwnProperty(key)) {
                if (Object.keys(state.docker.containers).includes(key)) { // just need to update container
                    updateContainerFrontend(containers[key]);
                    delete state.docker.containers[key];
                } else { // new container
                    addContainerFrontend(containers[key]);
                }
            }
        }
        for (const key in state.docker.containers) {
            if (state.docker.containers.hasOwnProperty(key)) {
                containerFinishedFrontend(state.docker.containers[key]);
                state.docker.containers[key].state = 'Finished running';
                state.docker.containers[key].notified = true;
                updateContainerFrontend(state.docker.containers[key]);
                containers[key] = state.docker.containers[key];
                delete state.docker.containers[key];
            }
        }
        state.docker.containers = containers;
        saveState();
    });
}
function singularityPs() {
    if (state.user === 'nobody') {
        console.log('todo tell user their not signed in');
        return;
    }
    const ps = exec('ssh -X -Y -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ' + state.user + '@cubic-login "qstat"');
    ps.stdout.on('data', function (data) {
        let containers = {};
        // qstat will return *something* like
        // job-ID  prior   name       user         state submit/start at     queue                          slots ja-task-ID 
        // -----------------------------------------------------------------------------------------------------------------
        // 5949719 0.00000 singularit robertft     qw    03/30/2020 22:34:32 all.q@2115fmn006.bicic.local       1        
        // 5949720 0.00000 singularit robertft     qw    03/30/2020 22:34:35                                    1        
        // so split by whitespace, like
        data = data.split(/(\s+)/).filter(function (e) { return e.trim().length > 0; });
        // ["job-ID", "prior", "name", "user", "state", "submit/start", "at", "queue", "slots", "ja-task-ID",
        //  "--------------------------------------------------…-------------------------------------------------",
        //  "5949719", "0.00000", "singularit", "robertft", "qw", "03/30/2020", "22:34:32", "all.q@2115fmn006.bicic.local", "1",
        //  "5949720", "0.00000", "singularit", "robertft", "qw", "03/30/2020", "22:34:35", "1"]
        data = data.slice(11);
        for (let index = 0; index < data.length; index++) {
            if (data[index] === state.user) { // we have found the user column; use to orient relative distance to other columns
                const id = data[index - 3];
                let prettyState = data[index + 1];
                if (prettyState === 'r') {
                    prettyState = 'Running...'
                } else if (prettyState === 'qw') {
                    prettyState = 'Queued...'
                } else if (prettyState === 'hqw') {
                    prettyState = 'Waiting for another job to finish'
                }
                let taskIdIndex = index + 4; // this will be either queue or slots column depending on if its running
                if (isNaN(data[taskIdIndex])) { // if it contains non-numeric chars, its the queue column
                    taskIdIndex += 2; // +2 brings us to ja-task-ID column
                    // prettyState += `<p class="text-primary mt-0"><small>${data[taskIdIndex]} total tasks</small></p>`;
                } else { // it is the slots column
                    taskIdIndex += 1; // +1 brings us to the ja-task-ID column
                }
                if (data[taskIdIndex] === undefined // if we went too far past and hit end of array or
                    || data[taskIdIndex + 3] === state.user) { // hit the user column again if we add +3
                    prettyState = `<p>${prettyState}</p>`
                } else {
                    prettyState = `<p class="text-right mb-0"><span class="badge badge-primary">${data[taskIdIndex]} tasks</span></p><p class="mt-0">${prettyState}</p>`
                }

                containers[id] = {
                    id: id,
                    name: `CUBIC job #${id}`,
                    state: prettyState,
                    age: new Date(data[index + 2] + ' ' + data[index + 3])
                }
            }
        }
        for (const key in containers) {
            if (containers.hasOwnProperty(key)) {
                if (Object.keys(state.singularity.containers).includes(key)) { // just need to update container
                    updateContainerFrontend(containers[key]);
                    delete state.singularity.containers[key];
                } else { // new container
                    addContainerFrontend(containers[key]);
                }
                
            }
        }
        for (const key in state.singularity.containers) {
            if (state.singularity.containers.hasOwnProperty(key)) {
                containerFinishedFrontend(state.singularity.containers[key]);
                state.singularity.containers[key].state = 'Finished running';
                state.singularity.containers[key].notified = true;
                updateContainerFrontend(state.singularity.containers[key]);
                containers[key] = state.singularity.containers[key];
            }
        }

        state.singularity.containers = containers;
        saveState();
    });
    ps.on('exit', (code) => {
        if (code === 255) {
            alertFrontend(`<strong>ssh ${state.user}@cbica-cluster</strong> failed; Unable to connect to CUBIC.`)
        } else {
            clearAlertFrontend();
        }
    });
}
function dockerRun(opts) {
    let command = 'docker run --rm ';
    for (let i = 0; i < opts.bindMounts.length; i++) {
        const mount = opts.bindMounts[i];
        command += ' -v ' + mount.local + ':' + mount.container;
    }
    // handle special containers
    if (opts.image === 'rstudio') {
        command += ' -d -p 80:8787 -e DISABLE_AUTH=true';
    }
    command += (' ' + opts.org + '/' + opts.image + ':' + opts.tag + ' ' + opts.cmd)
    const docker = exec(command);
    docker.stdout.on('data', d => dockerPs());
}
function singularityRun(opts) {
    let escapeShell = (cmd) => {
        return cmd.replace(/(["'$`\\])/g,'\\$1');
    };
    let command = 'singularity exec';
    for (let i = 0; i < opts.bindMounts.length; i++) {
        const mount = opts.bindMounts[i];
        command += ` -B ~/.cubedata${mount.local}:${mount.container}`;
    }
    command += ` /cbica/home/robertft/singularity_images/${opts.image}_${opts.tag}.sif ${escapeShell(opts.cmd)}`;
    let sgeOpts = `#$ -o \\$HOME/.cubedata/.stdout.\\$JOB_ID\\n#$ -e \\$HOME/.cubedata/.stderr.\\$JOB_ID\\n#$ -l h_vmem=${opts.mem}G\\n#$ -pe threaded ${opts.cpu}\\n`;
    if (opts.tasks !== null && opts.tasks !== undefined) {
        sgeOpts += `#$ -t 1-${opts.tasks}\\nexport ${opts.indexVariable}=\\\$SGE_TASK_ID\\n`;
    }
    command = sgeOpts + command;

    const singularity = exec(`ssh -X -Y -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ${state.user}@cubic-login "printf '${command}' > \\$TMPDIR/script.sh && qsub -terse \\$TMPDIR/script.sh"`);
    singularity.stdout.on('data', function (jobId) {
        // win.webContents.send('asynchronous-message', { type: 'jobId', id: jobId });
        singularityPs();
    });
}

function rsync(path) {
    if (path === undefined || state.user === 'nobody') {
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
        .destination(`${state.user}@cbica-cluster:~/.cubedata${path}`);

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
                const index = state.syncNeeded.indexOf(path);
                if (index > -1) {
                    state.syncNeeded.splice(index, 1);
                }
                clearAlertFrontend();
            } else {
                alertFrontend(`<strong>ssh ${state.user}@cbica-cluster</strong> failed; Unable to connect to CUBIC.`)
            }
        }, function (data) {
            // parse progress
            win.webContents.send('asynchronous-message', { type: 'rsync', path: path, progress: progress(data.toString()) })
        }
    )

    return;
}

function addContainerFrontend(container) {
    win.webContents.send('asynchronous-message', Object.assign({ type: 'addContainer' }, container));
}
function updateContainerFrontend(container) {
    win.webContents.send('asynchronous-message', Object.assign({ type: 'updateContainer' }, container));
}
function containerFinishedFrontend(container) {
    if (container.notified === undefined || container.notified === false) {
        // console.log(container.notified, containerFinishedFrontend.caller.toString());
        win.webContents.send('asynchronous-message', Object.assign({ type: 'containerFinished' }, container));   
    }
}
function alertFrontend(message) {
    win.webContents.send('asynchronous-message', { type: 'alert', message: message });
}
function clearAlertFrontend() {
    win.webContents.send('asynchronous-message', { type: 'clearAlert' });
}
function stdoutFrontend(output, id) {
    win.webContents.send('asynchronous-message', { type: 'stdout', output: output, id: id });
}
function stderrFrontend(output, id) {
    win.webContents.send('asynchronous-message', { type: 'stderr', output: output, id: id });
}

// Quit when all windows are closed.
app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});


ipcMain.on('asynchronous-message', (event, json) => {
    // todo refactor as yaml/json config
    if (json.type === 'run') {
        for (let i = 0; i < state.deployments.length; i++) {
            const deployment = state.deployments[i];
            if (deployment.uuid === json.uuid) {
                if (deployment.machine === 'local') {
                    dockerRun(deployment);
                } else {
                    singularityRun(deployment);
                }
            }

        }
    } else if (json.type === 'deleteContainer') {
        // it's going to be in one of these
        delete state.docker.containers[json.id];
        delete state.singularity.containers[json.id];
        saveState();
    } else if (json.type === 'saveUsername') {
        state.user = json.username;
        saveState();
    } else if (json.type === 'saveDeployment') {
        state.deployments.push(json.deployment);
        for (let index = 0; index < json.deployment.bindMounts.length; index++) {
            const mount = json.deployment.bindMounts[index];
            watcher.add(mount.local);
            rsync(mount.local);
        }
        saveState();
    } else if (json.type === 'saveRefreshInterval') {
        state.refreshInterval = json.interval;
        saveState();
    } else if (json.type === 'deleteDeployment') {
        for (let index = 0; index < state.deployments.length; index++) {
            if (state.deployments[index].uuid === json.uuid) {
                delete state.deployments[index].uuid;
            }
        }
        saveState();
    } else if (json.type === 'getOutput') {
        if (json.runtime === 'docker') {
            const logs = exec(`docker logs ${json.id}`);
            logs.stdout.on('data', function (data) {
                stdoutFrontend(data, json.id);
            });
            logs.stderr.on('data', function (data) {
                stderrFrontend(data, json.id);
            });
        } else if (json.runtime === 'singularity') {
            const stdoutLogs = exec(`ssh -X -Y -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ${state.user}@cubic-login "cat \\$HOME/.cubedata/.stdout.${json.id}"`);
            stdoutLogs.stdout.on('data', function (data) {
                stdoutFrontend(data, json.id);
            });
            const stderrLogs = exec(`ssh -X -Y -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ${state.user}@cubic-login "cat \\$HOME/.cubedata/.stderr.${json.id}"`);
            stderrLogs.stdout.on('data', function (data) {
                stderrFrontend(data, json.id);
            });
        }
    } else if (json.type === 'singularityPs') {
        singularityPs();
    }
});


function refreshInterval() {
    if (BrowserWindow.getAllWindows().length > 0) { // if the app is active
        singularityPs();
        dockerPs();
    }
    if (state.refreshInterval < 10000) { // min refresh interval is 10s
        state.refreshInterval = 10000;
    }
    setTimeout(refreshInterval, state.refreshInterval);
}
function syncInterval() {
    for (let i = 0; i < state.syncNeeded.length; i++) {
        rsync(state.syncNeeded[i]);
    }
    setTimeout(syncInterval, 900000) // = 15 mins
};



app.whenReady().then(init);