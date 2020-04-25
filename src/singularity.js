const exec = require('child_process').exec;
const singularity = {
    previousExitCode: null,
    run: function (opts, state, win) {
        let escapeShell = (cmd) => {
            return cmd.replace(/(["'$`\\])/g, '\\$1');
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

        const singularity = exec(`ssh -X -Y -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ${state.data.user}@cubic-login "printf '${command}' > \\$TMPDIR/script.sh && qsub -terse \\$TMPDIR/script.sh"`);
        singularity.stdout.on('data', function (jobId) {
            // win.webContents.send('asynchronous-message', { type: 'jobId', id: jobId });
            module.exports.ps(state, win);
        });
    },
    ps: function (state, win) {
        if (state.data.user === 'nobody') {
            // console.log('todo tell user their not signed in');
            return;
        }
        const ps = exec('ssh -X -Y -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ' + state.data.user + '@cubic-login "qstat"');
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
                if (data[index] === state.data.user) { // we have found the user column; use to orient relative distance to other columns
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
                        || data[taskIdIndex + 3] === state.data.user) { // hit the user column again if we add +3
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
                    if (Object.keys(state.data.singularity.containers).includes(key)) { // just need to update container
                        win.webContents.send('asynchronous-message', { type: 'updateContainer', ...containers[key] });
                        delete state.data.singularity.containers[key];
                    } else { // new container
                        state.addContainerFrontend(win, containers[key]);
                    }

                }
            }
            for (const key in state.data.singularity.containers) {
                if (state.data.singularity.containers.hasOwnProperty(key)) {
                    win.webContents.send('asynchronous-message', { type: 'containerFinished', ...state.data.singularity.containers[key] });
                    state.data.singularity.containers[key].state = 'Finished running';
                    state.data.singularity.containers[key].notified = true;
                    win.webContents.send('asynchronous-message', { type: 'updateContainer', ...state.data.singularity.containers[key] });
                    containers[key] = state.data.singularity.containers[key];
                }
            }

            state.data.singularity.containers = containers;
            state.save();
        });
        ps.on('exit', (code) => {
            if (code === 255) {
                win.webContents.send('asynchronous-message', { type: 'alert', message: `<strong>ssh ${state.data.user}@cbica-cluster</strong> failed; Unable to connect to CUBIC.` });
            } else {
                win.webContents.send('asynchronous-message', { type: 'clearAlert' });
                if (module.exports.previousCode === 255) {
                    require('./rsync.js').interval(state, win, false);
                }
            }
            module.exports.previousExitCode = code;
        });
    },
    refreshInterval: function (state, win) {
        if (win !== undefined) { // if the app is active
            module.exports.ps(state, win); // this is always only one window
        }
        if (state.data.refreshInterval < 10000) { // min refresh interval is 10s
            state.data.refreshInterval = 10000;
        }
        setTimeout(() => { module.exports.refreshInterval(state, win) }, state.data.refreshInterval);
    },
    removeContainer: function (id) {
        exec('ssh -X -Y -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ' + state.data.user + '@cubic-login "qdel ' + id + '"')
    }
}

module.exports = singularity;