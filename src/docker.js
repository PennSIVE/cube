const exec = require('child_process').exec;
const shortid = require('shortid');

const docker = {
    run: function(opts, state, win) {
        let command = 'docker run -d';
        for (let i = 0; i < opts.bindMounts.length; i++) {
            const mount = opts.bindMounts[i];
            command += ' -v ' + mount.local + ':' + mount.container;
        }
        // handle special containers
        if (opts.image === 'rstudio') {
            command += ' -p 80:8787 -e DISABLE_AUTH=true';
        }
        if (opts.tasks !== null && opts.tasks !== undefined) {
            let sid = shortid.generate();
            for (let i = 1; i <= Number(opts.tasks); i++) {
                exec(`${command} -e ${opts.indexVariable}=${i} --name job-${sid}-${i} ${opts.org}/${opts.image}:${opts.tag} ${opts.cmd}`);
            }
        } else {
            command += ` ${opts.org}/${opts.image}:${opts.tag} ${opts.cmd}`
            const docker = exec(command);
            docker.stdout.on('data', d => module.exports.ps(state, win));
        }
    },
    ps: function(state, win) {
        const ps = exec("docker ps -a --format '{{json .}}'");
        ps.stdout.on('data', function (data) {
            let arrayJobs = {};
            let containers = {};
            let response = data.split(/\r?\n/);
            // get current containers
            for (let i = 0; i < response.length; i++) {
                try {
                    const container = JSON.parse(response[i].trim());
                    if (container.Names.substring(0, 4) === 'job-') { // is array job
                        let parts = container.Names.split('-')
                        if (arrayJobs[parts[1]] === undefined) {
                            arrayJobs[parts[1]] = [{
                                id: parts[1],
                                name: container.Names + ' (' + container.Image + ')',
                                state: container.Status,
                                age: new Date(container.CreatedAt)
                            }];   
                        } else {
                            arrayJobs[parts[1]].push({
                                id: parts[1],
                                name: container.Names + ' (' + container.Image + ')',
                                state: container.Status,
                                age: new Date(container.CreatedAt)
                            });
                        }
                    } else {
                        containers[container.ID] = {
                            id: container.ID,
                            name: container.Names + ' (' + container.Image + ')',
                            state: container.Status,
                            age: new Date(container.CreatedAt)
                        };
                    }
                } catch (e) {
                    // console.log('todo', e);
                }
            }
            // get array job containers
            for (const key in arrayJobs) {
                if (arrayJobs.hasOwnProperty(key)) {
                    const jobs = arrayJobs[key];
                    containers[jobs[0].id] = {
                        id: jobs[0].id,
                        name: `Array job ${jobs[0].id}`,
                        state: `<p class="text-right mb-0"><span class="badge badge-primary">${jobs.length} tasks</span></p><p class="mt-0">Running...</p>`,
                        age: jobs[0].age
                    }
                }
            }
            for (const key in containers) {
                if (containers.hasOwnProperty(key)) {
                    if (Object.keys(state.data.docker.containers).includes(key)) { // just need to update container
                        win.webContents.send('asynchronous-message', { type: 'updateContainer', ...containers[key] });
                        delete state.data.docker.containers[key];
                    } else { // new container
                        state.addContainerFrontend(win, containers[key]);
                    }
                }
            }
            for (const key in state.data.docker.containers) {
                if (state.data.docker.containers.hasOwnProperty(key)) {
                    win.webContents.send('asynchronous-message', { type: 'containerFinished', ...state.data.docker.containers[key] });
                    state.data.docker.containers[key].state = 'Finished running';
                    state.data.docker.containers[key].notified = true;
                    win.webContents.send('asynchronous-message', { type: 'updateContainer', ...state.data.docker.containers[key] });
                    containers[key] = state.data.docker.containers[key];
                    delete state.data.docker.containers[key];
                }
            }
            state.data.docker.containers = containers;
            state.save();
        });
    },
    removeContainer: function(id) {
        exec(`docker rm -f ${id}`)
    },
    refreshInterval: function(state, win) {
        if (win !== undefined) { // if the app is active
            module.exports.ps(state, win); // this is always only one window
        }
        if (state.data.refreshInterval < 10000) { // min refresh interval is 10s
            state.data.refreshInterval = 10000;
        }
        setTimeout(() => { module.exports.refreshInterval(state, win) }, state.data.refreshInterval);
    }
}

module.exports = docker;