const storage = require('electron-json-storage');
const _ = require('lodash');
const state = {
    data: {
        user: 'nobody',
        singularity: {
            containers: {}
        },
        docker: {
            containers: {}
        },
        deployments: [],
        refreshInterval: 90000,
        syncNeeded: new Set()
    },

    save: function() {
        let serializable = _.cloneDeep(state.data);
        serializable.syncNeeded = Array.from(serializable.syncNeeded)
        storage.set('state', serializable, function (error) {
            if (error) throw error;
        });
    },

    refreshWindowState: function(win, callbacks) {
        storage.has('state', function (error, hasKey) {
            if (error) throw error;
            if (hasKey) {
                storage.get('state', function (error, object) {
                    if (error) throw error;
                    // be careful objects got serialized correctly...
                    object.syncNeeded = new Set(Array.from(object.syncNeeded))
                    state.data = object;
                    win.webContents.send('asynchronous-message', { type: 'setUser', user: state.data.user });
                    win.webContents.send('asynchronous-message', { type: 'setRefreshInterval', interval: state.data.refreshInterval });
                    const files = [];
                    for (const key in state.data.deployments) {
                        if (state.data.deployments.hasOwnProperty(key) && state.data.deployments[key] !== null) {
                            win.webContents.send('asynchronous-message', Object.assign({ type: 'addDeployment' }, state.data.deployments[key]));
                            const mounts = state.data.deployments[key].bindMounts;
                            for (let i = 0; i < mounts.length; i++) {
                                const mount = mounts[i];
                                const file = mount.hostPath;
                                if (!files.includes(file) && mount.remote === false) {
                                    callbacks.rsync.watcher.add(file);
                                    callbacks.rsync.transfer(state, win, file);
                                    files.push(file);
                                }
                            }
                        }
                    }
                    let merged = {...state.data.docker.containers, ...state.data.singularity.containers};
                    for (const key in merged) {
                        if (merged.hasOwnProperty(key)) {
                            state.addContainerFrontend(win, merged[key]);
                        }
                    }
                    callbacks.docker.refreshInterval(state, win);
                    callbacks.singularity.refreshInterval(state, win);
                    callbacks.rsync.interval(state, win, true);
                });
            } else {
                callbacks.singularity.ps(state, win);
                callbacks.docker.ps(state, win);
            }
        });
    },

    addContainerFrontend: function(win, container) {
        win.webContents.send('asynchronous-message', Object.assign({ type: 'addContainer' }, container));
    },

    findRemoteMounts: function() {
        let mounts = [];
        for (let i = 0; i < module.exports.data.deployments.length; i++) {
            const deployment = module.exports.data.deployments[i];
            for (let j = 0; j < deployment.bindMounts.length; j++) {
                const mount = deployment.bindMounts[j];
                if (mount.remote) {
                    mounts.push({
                        hostPath: mount.hostPath,
                        host: deployment.machine
                    });
                }
            }
        }
        return mounts;
    }
}

module.exports = state;