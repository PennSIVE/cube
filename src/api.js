const exec = require('child_process').exec;
const api = {
    request: function(json, state, win, docker, singularity, rsync) {
        if (json.type === 'run') {
            for (let i = 0; i < state.data.deployments.length; i++) {
                const deployment = state.data.deployments[i];
                if (deployment.uuid === json.uuid) {
                    if (deployment.machine === 'local') {
                        docker.run(deployment, state, win);
                    } else {
                        singularity.run(deployment, state, win);
                    }
                    break;
                }
    
            }
        } else if (json.type === 'deleteContainer') {
            // it's going to be in one of these
            if (state.data.docker.containers[json.uuid] !== undefined) {
                docker.removeContainer(state.data.docker.containers[json.uuid].id);
                delete state.data.docker.containers[json.uuid];
            }
            if (state.data.singularity.containers[json.uuid] !== undefined) {
                singularity.removeContainer(state.data.user, state.data.singularity.containers[json.uuid].id);
                delete state.data.singularity.containers[json.uuid];
            }
            state.save();
        } else if (json.type === 'saveUsername') {
            state.data.user = json.username;
            state.save();
        } else if (json.type === 'saveDeployment') {
            state.data.deployments.push(json.deployment);
            for (let index = 0; index < json.deployment.bindMounts.length; index++) {
                const mount = json.deployment.bindMounts[index];
                if (mount.remote === false) { // need to upload path, watch for updates
                    rsync.watcher.add(mount.hostPath);
                    rsync.transfer(state, win, mount.hostPath);   
                }
            }
            state.save();
        } else if (json.type === 'saveRefreshInterval') {
            state.data.refreshInterval = json.interval;
            state.save();
        } else if (json.type === 'deleteDeployment') {
            for (let index = 0; index < state.data.deployments.length; index++) {
                if (state.data.deployments[index].uuid === json.uuid) {
                    state.data.deployments.splice(index, 1); // delete array element
                }
            }
            state.save();
        } else if (json.type === 'getOutput') {
            if (json.runtime === 'docker') {
                const logs = exec(`docker logs ${json.id}`);
                logs.stdout.on('data', function (data) {
                    module.exports.stdoutFrontend(win, data, json.id);
                });
                logs.stderr.on('data', function (data) {
                    module.exports.stderrFrontend(win, data, json.id);
                });
            } else if (json.runtime === 'singularity') {
                const stdoutLogs = exec(`ssh -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ${state.data.user}@cubic-login "cat \\$HOME/.cubedata/.stdout.${json.id}"`);
                stdoutLogs.stdout.on('data', function (data) {
                    module.exports.stdoutFrontend(win, data, json.id);
                });
                const stderrLogs = exec(`ssh -oStrictHostKeyChecking=no -o ConnectTimeout=10 -oCheckHostIP=no -oUserKnownHostsFile=/dev/null ${state.data.user}@cubic-login "cat \\$HOME/.cubedata/.stderr.${json.id}"`);
                stderrLogs.stdout.on('data', function (data) {
                    module.exports.stderrFrontend(win, data, json.id);
                });
            }
        } else if (json.type === 'singularityPs') {
            singularity.ps(state, win);
        } else if (json.type === 'restoreBackup') {
            // temporarily remove file from watched (so it isn't accidentally re uploaded), re-download, then watch re-downloaded file
            rsync.watcher.unwatch(json.path);
            let d = new Date(json.when);
            rsync.downloadAndRestoreBackup(state, win, json.path,
                `${d.getFullYear()}_${(d.getMonth() + 1).toString().padStart(2, '0')}_${(d.getDate()).toString().padStart(2, '0')}-${d.getHours().toString().padStart(2, '0')}.${d.getMinutes().toString().padStart(2, '0')}`);
        }
    },
    stdoutFrontend: function(win, output, id) {
        win.webContents.send('asynchronous-message', { type: 'stdout', output: output, id: id });
    },
    stderrFrontend: function(win, output, id) {
        win.webContents.send('asynchronous-message', { type: 'stderr', output: output, id: id });
    }
}

module.exports = api