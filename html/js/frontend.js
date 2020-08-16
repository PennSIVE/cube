window.$ = window.jQuery = require('jquery');

const electron = require('electron');
const { dialog } = electron.remote;
const { ipcRenderer } = electron;
const uuidv4 = require('uuid').v4;
let formData;
let rsyncFiles = [];

function addContainer(json) {
    let isDocker = isNaN(json.id); // hacky way to tell if it's a docker container or qsub job/singularity container
    let title = json.name;
    let message = `<div id="p${json.id}">${json.state}</div>
    <div class="btn-group w-100 btn-group-sm" role="group" aria-label="Job controls">
        <button type="button" ${isDocker ? 'data-runtime="docker"' : 'data-runtime="singularity"'} data-id="${json.id}" data-target="#outputModal" data-toggle="modal" class="btn btn-outline-success">View output</button>
        <button type="button" class="btn btn-outline-danger" data-dismiss="toast" onclick="deleteContainer(event, '${json.id}')">Delete</button>
    </div>`;
    // insert button after appended to dom
    let date = new Date(json.age);
    let id = json.id;
    let autohide = false;
    if (id === undefined) {
        id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        autohide = true;
    }
    let formatted = date.toLocaleDateString('en-US', { year: '2-digit', month: '2-digit', day: '2-digit' }) + ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    let html = `<div class="toast" role="alert" aria-live="assertive" aria-atomic="true" ${autohide ? '' : 'data-autohide="false"'} id="${id}">
    <div class="toast-header">
    <img class="bd-placeholder-img rounded mr-2" width="20" height="20" src="${isDocker ?
            __dirname + '/images/docker.svg' :
            'https://sylabs.io/assets/svg/singularity-logo.svg'}" />
    <strong class="mr-auto">${title}</strong>
    <small class="text-muted">${formatted}</small>
    </div>
    <div class="toast-body" id="status" style="max-height:200px;overflow-y:scroll;">
    ${message}
    </div>
</div>`;
    document.getElementById('toaster').innerHTML = html + document.getElementById('toaster').innerHTML;
    $('.toast').toast('show');
}

function saveUsername(e) {
    e.preventDefault();
    let uname = document.getElementById('username');
    uname.classList.remove('text-danger');
    ipcRenderer.send('asynchronous-message', { type: 'saveUsername', username: uname.innerText });
    ipcRenderer.send('asynchronous-message', { type: 'singularityPs' });
}
function saveRefreshInterval(e) {
    e.preventDefault();
    let interval = document.getElementById('refreshInterval').innerText * 1000;
    ipcRenderer.send('asynchronous-message', { type: 'saveRefreshInterval', interval: interval });
}

function selectDir(e) {
    e.preventDefault();
    const id = e.target.id;
    const path = dialog.showOpenDialog({
        properties: ['openDirectory']
    });
    path.then(values => {
        if (values.filePaths[0] !== undefined) {
            e.target.classList = 'is-valid custom-file-input';
            document.getElementById(id + '-help').innerText = 'You selected ' + values.filePaths[0];
            formData.bindMounts.push({
                id: id,
                hostPath: values.filePaths[0],
                containerPath: null,
                remote: false
            });
        } else {
            e.target.classList = 'is-invalid custom-file-input';
        }
    });
}

function addBindMount() {
    let rand = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let html = `<div class="mt-2 data-option" id="upload-data-select${rand}">
                Add data, code into environment
                <div class="input-group">
                <div class="custom-file input-group-prepend d-none" id="${rand}-file-picker-container">
                    <input type="file" class="custom-file-input" id="${rand}-file-picker" onclick="selectDir(event)" webkitdirectory directory multiple>
                    <label class="custom-file-label" for="${rand}-file-picker">Choose directory</label>
                </div>
                <div class="custom-file input-group-prepend" id="${rand}-file-input-container">
                    <input type="text" class="form-control rounded-0" id="${rand}-file-input" placeholder="Path on host">
                </div>
                <div class="input-group-prepend">
                    <span class="input-group-text">&rarr;</span>
                </div>
                <input type="text" aria-label="Container path" placeholder="Path in container" class="form-control container_path" data-key="${rand}-file-input" id="${rand}_container_path">
                <div class="input-group-append">
                    <span class="input-group-text">
                    <button type="button" class="close" onclick="this.parentElement.parentElement.parentElement.parentElement.remove()">
                        <span aria-hidden="true">&times;</span>
                    </button>
                    </span>
                </div>
                </div>
                <div class="custom-control custom-switch pl-0">
                <label class="mr-3 pr-4" for="${rand}-switch">Remote path</label>
                <input type="checkbox" class="custom-control-input" id="${rand}-switch" onchange=" if (this.checked) {
                    document.getElementById('${rand}-file-picker-container').classList.remove('d-none');
                    document.getElementById('${rand}-file-input-container').classList.add('d-none');
                    document.getElementById('${rand}_container_path').dataset.key = '${rand}-file-picker';
                } else {
                    document.getElementById('${rand}-file-picker-container').classList.add('d-none');
                    document.getElementById('${rand}-file-input-container').classList.remove('d-none');
                    document.getElementById('${rand}_container_path').dataset.key = '${rand}-file-input';
                }
                ">
                <label class="custom-control-label" for="${rand}-switch">Local path</label>
                </div>
                <small id="${rand}-file-picker-help" class="text-success">&nbsp;</small>
            </div>`;
    $('#bind-mounts').append(html);
}

function createDeployment(e) {
    e.preventDefault();
    $('#configModal').modal('hide');
    $('#deployments-tab').tab('show');
    formData['machine'] = document.getElementById('machine-select').value;
    formData['cmd'] = document.getElementById('cmd').value;
    formData['gpu'] = (document.getElementById('ngpus') === undefined) ? '' : document.getElementById('ngpus').value;
    formData['tag'] = document.getElementById('tag-select').value;
    let uuid = uuidv4();
    let deployment = {
        uuid: uuid,
        org: formData.org,
        image: formData.image,
        tag: formData.tag,
        machine: formData.machine,
        cmd: formData.cmd,
        cpu: formData.cpu,
        mem: formData.mem,
        gpu: formData.gpu,
        indexVariable: formData.indexVariable,
        tasks: formData.tasks,
        bindMounts: []
    };
    // loop over all the bind mount paths (in the container)
    $('.container_path').each(function (i, e) {
        let k = e.getAttribute('data-key'); // references the bind mount path on the host
        if (k.includes('file-picker')) { // if selectDir was used
            for (let i = 0; i < formData.bindMounts.length; i++) {
                if (k === formData.bindMounts[i].id) {
                    formData.bindMounts[i].containerPath = e.value;
                    deployment.bindMounts.push(formData.bindMounts[i]);
                    break;
                }
            }
        } else if (document.getElementById(k).value.length > 0) { // if it's just a text box + it has a value
            deployment.bindMounts.push({
                hostPath: document.getElementById(k).value,
                containerPath: e.value,
                remote: true
            });
        }
    });
    // save
    ipcRenderer.send('asynchronous-message', {
        type: 'saveDeployment',
        deployment: deployment
    });
    // add to DOM
    addDeployment(deployment);
}

function addDeployment(deployment) {
    let remoteToSync = 0;
    for (let index = 0; index < deployment.bindMounts.length; index++) {
        if (deployment.bindMounts[index].remote === false) {
            remoteToSync++;
        }
    }
    let rand = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let html = `<div class="card mb-2">
                <div class="card-body">
                <h5 class="card-title">${deployment.machine} deployment</h5>
                <h6 class="card-subtitle mb-2 text-muted">${deployment.org}/${deployment.image}:${deployment.tag}</h6>
                <p class="card-text">Run <code>${deployment.cmd}</code> in ${deployment.image}:${deployment.tag} on ${deployment.machine}${deployment.bindMounts.length > 0 ? ' with ' + deployment.bindMounts.length + ' bind mounts:' : '.'}</p>
                ${deployment.bindMounts.length > 0 ? '<ul>' : ''}
                ${deployment.bindMounts.map((item, i) => `
                    <li><code class="bind-mount-path" data-button="${rand}">${item.hostPath}</code> &rarr; <code>${item.containerPath}</code></li>
                `).join('')}
                ${deployment.bindMounts.length > 0 ? '</ul>' : ''}
                <button type="button" id="${rand}" onclick="createContainer(event, '${deployment.uuid}')" class="btn btn-primary" data-tosync="${remoteToSync}" ${remoteToSync > 0 ? 'disabled' : ''}>Create container</button>
                <button type="button" class="btn btn-danger" onclick="deleteDeployment(event, '${deployment.uuid}')">Delete deployment</button>
                <!-- <a href="#" class="card-link">More info</a> -->
                <!-- more info shows commands you would have to enter to create container -->
                </div>
            </div>`;
    $('#deployments').append(html);
}

function addRsyncTransfer(obj) {
    if (obj.progress === undefined) {
        return;
    }
    // if we've already added it, just update
    if (rsyncFiles.includes(obj.path)) {
        let $el = $('#progress-of' + obj.path.replace(/\//g, '-'));
        $el.css('width', obj.progress.percent + '%');
        $el.text(`${obj.path} (${obj.progress.speed})`);
    } else {
        rsyncFiles.push(obj.path);
        $('#rsync-transfers').append(`
    <div class="progress rounded-0">
    <div class="progress-bar br-0" id="progress-of${obj.path.replace(/\//g, '-')}" role="progressbar" aria-valuemin="0" aria-valuemax="100">${obj.path}</div>
    </div>
    `);
    }
}
function removeRsyncTransfer(obj) {
    const index = rsyncFiles.indexOf(obj.path);
    if (index > -1) {
        rsyncFiles.splice(index, 1);
    }
    $('#progress-of' + obj.path.replace(/\//g, '-')).parent().remove();
    $('.bind-mount-path').each(function (i, e) {
        let button = $('#' + $(e).data('button'));
        let newVal = button.data('tosync') - 1;
        button.data('tosync', newVal)
        if (newVal === 0) {
            button.prop('disabled', false);
        }
    })
}

function createContainer(e, id) {
    e.preventDefault();
    ipcRenderer.send('asynchronous-message', { type: 'run', uuid: id });
}
function deleteContainer(e, id) {
    if (confirm('This action can not be undone')) {
        ipcRenderer.send('asynchronous-message', { type: 'deleteContainer', uuid: id });
    } else {
        e.preventDefault();
        e.stopPropagation();
    }
}
function deleteDeployment(e, id) {
    e.preventDefault();
    $(e.target).parent().parent().remove();
    ipcRenderer.send('asynchronous-message', { type: 'deleteDeployment', uuid: id });
}

function machineSelect(e) {
    e.preventDefault();
    let val = $(this).val();
    if (val === 'cubic') {
        formData.machine = val;
        $('#pmacs-options').html('');
        $('#cubic-options').html(`<div id="ncpus" style="-webkit-app-region: no-drag;">
            <label for="cpu-range">Number of CPUs <span id="cpu-readout" class="text-success">1</span></label>
            <input type="range" class="custom-range" id="cpu-range" min="1" max="64" step="1" value="1" onchange="$('#cpu-readout').text(event.target.value); formData.cpu = event.target.value;">
        </div>
        <div id="nmem" style="-webkit-app-region: no-drag;">
            <label for="mem-range">Memory <span id="mem-readout" class="text-success">8</span>GB</label>
            <input type="range" class="custom-range" id="mem-range" min="1" max="1024" step="1" value="8" onchange="$('#mem-readout').text(event.target.value); formData.mem = event.target.value;">
        </div>
        <select class="custom-select" aria-describedby="gpuHelpBlock" id="ngpus">
            <option value="" selected>No GPUs</option>
            <option value="-l V100">1 V100 GPU (optimized for TF)</option>
            <option value="-l gpu">1 GPU</option>
            <option value="-l gpu=2">2 GPUs</option>
        </select>
        <small id="gpuHelpBlock" class="form-text text-muted">
            See <a href="https://cbica-wiki.uphs.upenn.edu/wiki/index.php/GPU_Computing" target="_blank">here</a> for additional information on CUBICs GPUs.
        </small>
        `);
    } else if (val === 'pmacs') {
        formData.machine = val;
        $('#cubic-options').html('');
        $('#pmacs-options').html(`<div id="ncpus" style="-webkit-app-region: no-drag;">
            <label for="cpu-range">Number of CPUs <span id="cpu-readout" class="text-success">1</span></label>
            <input type="range" class="custom-range" id="cpu-range" min="1" max="50" step="1" value="1" onchange="$('#cpu-readout').text(event.target.value); formData.cpu = event.target.value;">
        </div>
        <div id="nmem" style="-webkit-app-region: no-drag;">
            <label for="mem-range">Memory <span id="mem-readout" class="text-success">8</span>GB</label>
            <input type="range" class="custom-range" id="mem-range" min="1" max="512" step="1" value="8" onchange="$('#mem-readout').text(event.target.value); formData.mem = event.target.value;">
        </div>`);
    } else {
        formData.machine = 'local';
        $('#cubic-options').html('');
        $('#pmacs-options').html('');
    }
}
$('#configModal').on('show.bs.modal', function (event) {
    let button = $(event.relatedTarget);
    let modal = $(this);
    let fullName = button.data('org') + '/' + button.data('image');
    modal.find('.modal-title').text('Configure ' + fullName)
    $('#array-job').html(`<div class="custom-control custom-checkbox">
    <input type="checkbox" class="custom-control-input" id="array-job-check" onchange="
        $('#array-job-container').toggleClass('d-none');
        if (!this.checked) {
        formData.tasks = null;
        formData.indexVariable = 'TASK_ID';
        }
    ">
    <label class="custom-control-label" for="array-job-check">Array job</label>
    </div>
    <div class="row d-none" id="array-job-container">
    <div class="col-6">
        <div class="form-group">
        <label for="array-job-env">Index variable</label>
        <input type="text" class="form-control form-control-sm" id="array-job-env" value="TASK_ID" oninput="formData.indexVariable = this.value">
        </div>
    </div>
    <div class="col-6">
        <div class="form-group">
        <label for="array-job-count">Number of jobs</label>
        <input type="number" class="form-control form-control-sm" id="array-job-count" oninput="formData.tasks = this.value">
        </div>
    </div>
    </div>`);
    $('#bind-mounts').html('');
    addBindMount();
    // add tag option
    $('#tags').html(`<label for="tag-select">Select version</label><select class="custom-select mb-2" name="tag-select" id="tag-select" required>
    ${button.data('tags').split(',').map((item, i) => `
    <option value="${item}">${item}</option>
    `).join('')}
</select>`)
    // special case for freesurfer
    if (fullName === 'pennsive/freesurfer') {
        // todo add to bindmounts
        $('#bind-mounts').prepend(`
    <div class="custom-file">
    <input type="file" class="custom-file-input" id="freesurfer-lic" oninput="
        if (this.dataset.formDataBindMounts === undefined ) {
            formData.bindMounts.push({hostPath: this.files[0].path, containerPath: '/usr/local/freesurfer/license.txt' });
            this.dataset.formDataBindMounts = 'true';
        } else {
            for (let index = 0; index < formData.bindMounts.length; index++) {
            if (formData.bindMounts[index].containerPath === '/usr/local/freesurfer/license.txt') {
                formData.bindMounts[index].hostPath = this.files[0].path;
                break;
            }
            }
        } console.log(formData.bindMounts); ">
    <label class="custom-file-label" for="customFile">Choose license</label>
    </div>
    `)
    }
    // add machine option
    if (fullName === 'pennsive/rstudio') {
        $('#machine-option').html('<p>R Studio is only available for local creation</p><input type="hidden" name="machine-select" id="machine-select" value="local"/>')
    } else {
        $('#machine-option').html(
            `<label for="machine-select">Select machine</label>
    <select class="custom-select" name="machine-select" id="machine-select" required>
    <option value="local">My computer</option>
    <option value="cubic">CUBIC</option>
    <option value="pmacs">PMACS</option>
    </select>`);
        $('#machine-select').on('change', machineSelect);
    }
    if (button.data('cmd') !== undefined) {
        $('#cmd').val(button.data('cmd'));
    } else {
        $('#cmd').val('');
    }
    // add tag option
    $('#tag-option').html(button.data('tags'));
    formData = {
        type: 'run',
        org: button.data('org'),
        image: button.data('image'),
        tag: null,
        cmd: null,
        machine: null,
        bindMounts: [],
        // cubic defaults
        cpu: 1,
        mem: 8,
        indexVariable: 'TASK_ID',
        tasks: null
    };
});
$('#outputModal').on('show.bs.modal', function (event) {
    let $button = $(event.relatedTarget);
    $('#stdout').text('');
    $('#stderr').text('');
    ipcRenderer.send('asynchronous-message', { type: 'getOutput', id: $button.data('id'), runtime: $button.data('runtime') });
});

$('#backupModal').on('show.bs.modal', function (event) {
    let $button = $(event.relatedTarget);
    let times = [];
    let now = Math.floor(new Date().getTime() / 1000);
    let rounded = Math.floor(now / (15 * 60)) * (15 * 60); // round down to nearest 15m
    for (let n = 0; n < 4; n++) {
        times.push(rounded - (n * 900));
    }
    times.push(
        Math.floor(now / (60 * 60)) * (60 * 60) - (3600 * 2)
    );
    times.push(
        Math.floor(now / (60 * 60)) * (60 * 60) - (3600 * 16)
    );
    times.push(
        Math.floor(now / (60 * 60)) * (60 * 60) - (3600 * 40)
    );
    times.push(
        Math.floor(now / (60 * 60)) * (60 * 60) - (3600 * 88)
    );
    times.push(
        Math.floor(now / (60 * 60)) * (60 * 60) - (3600 * 184)
    );
    $('#backups-avail').html(times.map((time) => `
        <option value="${new Date(time * 1000).toString()}">${new Date(time * 1000).toLocaleDateString()} ${new Date(time * 1000).toLocaleTimeString()}</option>
    `).join(''));
    $('#backup-path').val($button.data('path'));
});

function dataTab(opts) {
    let tbody = '';
    Array.from(opts.files).forEach((item, i) => tbody += `
    <tr>
    <td><code>${item}</code></td>
    <td>
        <p>Local path (${opts.stats[item].size})</p>
        <p>Last changed ${opts.stats[item].ctime.toLocaleDateString('en-US', { year: '2-digit', month: '2-digit', day: '2-digit' })} ${opts.stats[item].ctime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</p>
    </td>
    <td>
    <div class="dropleft">
    <button class="btn btn-secondary dropdown-toggle" type="button" id="dropdown${i}" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
        Actions
    </button>
    <div class="dropdown-menu" aria-labelledby="dropdown${i}">
        <a class="dropdown-item" href="#">Stop syncing</a>
        <a class="dropdown-item" href="#">Stop and remove from remote</a>
        <a class="dropdown-item" href="#" data-path="${item}" data-target="#backupModal" data-toggle="modal">Restore from backup</a>
    </div>
    </div>
    </td>
    </tr>
    `);
    opts.remote.forEach((item, i) => tbody += `
    <tr>
    <td><code>${item.hostPath}</code></td>
    <td><p>Remote path on ${item.host.toUpperCase()}</p></td>
    <td>
    </td>
    </tr>
    `);
    $('#data-content').html(`
    <table class="table table-borderless">
        <thead class="thead-dark">
            <tr>
            <th scope="col">Path</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
            </tr>
        </thead>
        <tbody>
        ${tbody}
        </tbody>
    </table>
    `);
}

function restoreBackup() {
    ipcRenderer.send('asynchronous-message', { type: 'restoreBackup', path: $('#backup-path').val(), when: $('#backups-avail').find(":selected").val() });
}

ipcRenderer.on('asynchronous-message', (event, json) => {
    if (json.type === 'log') {
        let status = document.getElementById('status');
        if (json.data === -1) {
            return;
        }
        status.innerText += json.data;
        status.parentNode.scrollTop = status.parentNode.scrollHeight;
    } else if (json.type === 'addContainer') {
        addContainer(json);
    } else if (json.type === 'updateContainer') {
        $('#p' + json.id).html(json.state);
    } else if (json.type === 'containerFinished' && json.notified !== true) {
        new Notification(`Job #${json.id} complete`);
    } else if (json.type === 'setUser') {
        $('#username').text(json.user).removeClass('text-danger');
    } else if (json.type === 'setRefreshInterval') {
        $('#refreshInterval').text(Math.round(json.interval / 1000));
    } else if (json.type === 'addDeployment') {
        addDeployment(json);
    } else if (json.type === 'syncNeeded') {
        $('.bind-mount-path').each((x) => {
            if (x.innerText === json.path) {
                let button = $('#' + x.data('button'));
                let remaining = button.data('tosync') + 1;
                button.data('tosync', remaining);
                button.prop('disabled', true);
            }
        });
    } else if (json.type === 'syncDone') {
        $('.bind-mount-path').each((x) => {
            if (x.innerText === json.path) {
                let button = $('#' + x.data('button'));
                let remaining = button.data('tosync') - 1;
                button.data('tosync', remaining);
                if (remaining === 0) {
                    button.prop('disabled', false);
                }
            }
        });
    } else if (json.type === 'alert') {
        let level = (json.level === undefined) ? 'warning' : json.level;
        $('#alerts').html(`
            <div class="alert alert-${level} alert-dismissible fade show" role="alert">
            ${json.message}
            <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                <span aria-hidden="true">&times;</span>
            </button>
            </div>`);
    } else if (json.type === 'clearAlert') {
        $('#alerts').html('');
    } else if (json.type === 'rsync') {
        addRsyncTransfer(json);
    } else if (json.type === 'rsyncComplete') {
        removeRsyncTransfer(json);
    } else if (json.type === 'stdout') {
        $('#stdout').text(json.output);
    } else if (json.type === 'stderr') {
        $('#stderr').text(json.output);
    } else if (json.type === 'remakeDataTab') {
        dataTab(json);
    }

});

document.getElementById('form').addEventListener('submit', createDeployment);
document.getElementById('save-username').addEventListener('click', saveUsername);
document.getElementById('refreshInterval').addEventListener('input', saveRefreshInterval);
