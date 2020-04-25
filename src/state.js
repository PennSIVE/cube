const storage = require('electron-json-storage');
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
        syncNeeded: []
    },

    save: function() {
        storage.set('state', state.data, function (error) {
            if (error) throw error;
        });
    },

    refreshWindowState: function(win, watcher, callbacks) {
        storage.has('state', function (error, hasKey) {
            if (error) throw error;
            if (hasKey) {
                storage.get('state', function (error, object) {
                    if (error) throw error;
                    state.data = object;
                    win.webContents.send('asynchronous-message', { type: 'setUser', user: state.data.user });
                    win.webContents.send('asynchronous-message', { type: 'setRefreshInterval', interval: state.data.refreshInterval });
                    for (const key in state.data.deployments) {
                        if (state.data.deployments.hasOwnProperty(key) && state.data.deployments[key] !== null) {
                            win.webContents.send('asynchronous-message', Object.assign({ type: 'addDeployment' }, state.data.deployments[key]));
                            const mounts = state.data.deployments[key].bindMounts;
                            for (let i = 0; i < mounts.length; i++) {
                                const mount = mounts[i];
                                const file = mount.local;
                                if (!Object.keys(watcher.getWatched()).includes(file)) {
                                    watcher.add(file);
                                    callbacks.rsync.transfer(state, win, file);
                                }
                            }
                        }
                    }
                    let merged = {...state.data.docker.containers, ...state.data.singularity.containers};
                    for (const key in merged) {
                        if (merged.hasOwnProperty(key)) {
                            module.exports.addContainerFrontend(win, merged[key]);
                        }
                    }
                    watcher.on('change', (path) => {
                        state.syncNeeded.push(path);
                    });
                    callbacks.docker.refreshInterval(state, win);
                    callbacks.singularity.refreshInterval(state, win);
                    callbacks.rsync.interval(state, win);
                });
            } else {
                callbacks.singularity.ps(state, win);
                callbacks.docker.ps(state, win);
            }
        });
    },

    addContainerFrontend: function(win, container) {
        win.webContents.send('asynchronous-message', Object.assign({ type: 'addContainer' }, container));
    }
}

module.exports = state;