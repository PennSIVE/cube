const exec = require('child_process').exec;
const dns = require('dns');

const updateHost = () => {
    dns.lookup('cubic-login', function (err, res) {
        if (res !== undefined) {
            module.exports.host = 'cubic'
        } else {
            dns.lookup('takim', function (err, res) {
                if (res !== undefined) {
                    module.exports.host = 'pmacs'
                } else {
                    module.exports.host = null;
                }
            });
        }
    });
    return undefined;
}


const singularity = {
    previousExitCode: null,
    previousOutput: false,
    rsyncInstance: null,
    host: updateHost(), // undefined == unknown, null == not connected to either VPN, 'cubic' == UPHS VPN, 'pmacs' == PMACS VPN
    run: function (opts, state, win) {
        let escapeShell = (cmd) => {
            return cmd.replace(/(["'$`\\])/g, '\\$1');
        };
        let command = (opts.entrypoint) ? 'singularity exec' : 'singularity run';
        for (let i = 0; i < opts.bindMounts.length; i++) {
            const mount = opts.bindMounts[i];
            command += ` -B ~/.cubedata${mount.hostPath}:${mount.containerPath}`;
        }
        let singularity;
        if (module.exports.host === 'cubic') {
            command += ` /cbica/home/robertft/singularity_images/${opts.image}_${opts.tag}.sif ${escapeShell(opts.cmd)}`;
            let sgeOpts = `#$ -o \\$HOME/.cubedata/.stdout.\\$JOB_ID\\n#$ -e \\$HOME/.cubedata/.stderr.\\$JOB_ID\\n#$ -l h_vmem=${opts.mem}G\\n#$ -pe threaded ${opts.cpu}\\n`;
            if (typeof opts.gpu === 'string' && opts.gpu.length > 0) {
                sgeOpts += `#$ ${opts.gpu}\\n`;
            }
            if (opts.tasks !== null && opts.tasks !== undefined) {
                sgeOpts += `#$ -t 1-${opts.tasks}\\nexport ${opts.indexVariable}=\\\$SGE_TASK_ID\\n`;
            }
            command = sgeOpts + command;

            singularity = exec(`ssh -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ${state.data.user}@cubic-login "printf '${command}' > \\$TMPDIR/script.sh && qsub -terse \\$TMPDIR/script.sh"`);
        } else if (module.exports.host === 'pmacs') {
            command += ` /project/taki3/singularity_images/${opts.image}_${opts.tag}.sif ${escapeShell(opts.cmd)}`;
            let memMb = opts.mem * 1000;
            let lsfOpts = `#BSUB -o \\$HOME/.cubedata/.stdout.\\$JOB_ID\\n#BSUB -e \\$HOME/.cubedata/.stderr.\\$JOB_ID\\n#BSUB -R "rusage[mem=${memMb}]"\\n#BSUB -n ${opts.cpu}\\n`;
            if (opts.tasks !== null && opts.tasks !== undefined) {
                lsfOpts += `#BSUB -J "job[1-${opts.tasks}]%1"\\nexport ${opts.indexVariable}=\\\$LSB_JOBINDEX\\n`;
            }
            command = lsfOpts + command;

            singularity = exec(`ssh -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ${state.data.user}@takim "printf '${command}' > \\$TMPDIR/script.sh && bsub \\$TMPDIR/script.sh"`);
        } else {
            return;
        }
        singularity.stdout.on('data', function (jobId) {
            // some jobs complete almost instantaneously so need to add then call ps right after
            // note: need to check if bsub has terse option
            let job = {
                id: jobId,
                name: `${module.exports.host.toUpperCase()} job #${jobId}`,
                state: "Queued...",
                age: new Date()
            }
            state.addContainerFrontend(win, job);
            state.data.singularity.containers[jobId] = job;
            state.save();
            module.exports.ps(state, win);
        });
    },
    ps: function (state, win) {
        if (state.data.user === 'nobody') {
            // console.log('todo tell user their not signed in');
            return;
        }
        updateHost();
        let ps;
        if (module.exports.host === 'cubic') {
            ps = exec('ssh -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ' + state.data.user + '@cubic-login "qstat"');
            ps.stdout.on('data', function (data) {
                module.exports.previousOutput = true;
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
                            // since container now added automatically by run method
                            // this code probably won't execute unless a process started outside of the app
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
        } else if (module.exports.host === 'pmacs') {
            // bjobs format https://www.ibm.com/support/knowledgecenter/en/SSWRJV_10.1.0/lsf_config_ref/lsf.conf.lsb_bjobs_format.5.html
            ps = exec('ssh -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ' + state.data.user + '@takim "bjobs -o \'jobid stat submit_time\'"');
            ps.on('error', (code, err) => console.log(code, err))
            ps.stdout.on('data', function (data) {
                module.exports.previousOutput = true;
                let containers = {};
                data = data.split(/(\s+)/).filter(function (e) { return e.trim().length > 0; });
                // data will look something like: arr ['JOBID', 'STAT', 'SUBMIT_TIME', '5928414', 'RUN', 'Aug', '9', '23:30']
                // cut header
                data.splice(3);
                let index = 0;
                while (index < data.length) {
                    containers[data[index]] = {
                        id: data[index],
                        name: `PMACS job #${data[index]}`,
                        state: data[index + 1],
                        age: new Date(data[index + 2] + ' ' + data[index + 3] + ' ' + data[index + 4])
                    }
                    index += 5
                }

                state.data.singularity.containers = containers;
                state.save();
            });
        } else {
            return;
        }
        ps.on('exit', (code) => {
            if (code === 255) {
                win.webContents.send('asynchronous-message', { type: 'alert', message: 'No remote connection', level: 'warning' });
            } else if (code === 0) {
                win.webContents.send('asynchronous-message', { type: 'alert', message: `Connected to ${module.exports.host.toUpperCase()}`, level: 'success' });
                if (module.exports.previousCode === 255) {
                    module.exports.rsyncInstance.interval(state, win, false);
                }
            }
            module.exports.previousExitCode = code;
            if (module.exports.previousOutput === false) {
                // qstat/bjobs returned no stdout; all previously running jobs must've completed
                let containers = {};
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
            } else {
                // reset so we can check next ps command returns output
                module.exports.previousOutput = false;
            }
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
    removeContainer: function (user, id) {
        exec('ssh -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ' + user + '@cubic-login "qdel ' + id + '"')
    }
}

module.exports = singularity;