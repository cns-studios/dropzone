const getTauriApi = () => {
    try {
        return window.__TAURI__;
    } catch (e) {
        return null;
    }
};

// Generic HTTP wrapper that uses Tauri HTTP client (no CORS) when available
async function httpRequest(url, options = {}) {
    const tauri = getTauriApi();
    
    // Try Tauri HTTP client first (bypasses CORS completely)
    if (tauri && tauri.http) {
        try {
            const headers = options.headers || {};
            const body = options.body;
            
            const response = await tauri.http.fetch(url, {
                method: options.method || 'GET',
                headers,
                body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
            });
            
            // Convert Tauri response to Fetch-like response object
            return {
                ok: response.status >= 200 && response.status < 300,
                status: response.status,
                async json() {
                    return JSON.parse(response.data);
                },
                async text() {
                    return response.data;
                },
                async blob() {
                    const encoder = new TextEncoder();
                    return new Blob([encoder.encode(response.data)]);
                },
                data: response.data,
                headers: response.headers || {},
            };
        } catch (e) {
            console.log("Tauri HTTP failed, trying fetch:", e);
        }
    }
    
    // Fallback to standard fetch
    return fetch(url, options);
}

let appWindow = null;
let listen = null;

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB

const DURATIONS = [
    { value: '24h', label: '24 hours' },
    { value: '7d',  label: '7 days'   },
    { value: '30d', label: '30 days'  },
    { value: '90d', label: '90 days'  },
];

function loadConfig() {
    config = {
        apiKey: localStorage.getItem('dropzone_key'),
        serverUrl: localStorage.getItem('dropzone_url'),
        ownerName: localStorage.getItem('dropzone_owner'),
        duration: localStorage.getItem('dropzone_duration') || '7d',
    };
}
let config = {};
loadConfig();

let onboardingScreen, mainScreen, dropArea, statusText;

const EXT_COLORS = {
    pdf:  { bg: '#fde8e8', color: '#c0392b' },
    zip:  { bg: '#e8f0fd', color: '#2b5cc0' },
    gz:   { bg: '#e8f0fd', color: '#2b5cc0' },
    tar:  { bg: '#e8f0fd', color: '#2b5cc0' },
    png:  { bg: '#fdf4e8', color: '#c07a2b' },
    jpg:  { bg: '#fdf4e8', color: '#c07a2b' },
    jpeg: { bg: '#fdf4e8', color: '#c07a2b' },
    gif:  { bg: '#fdf4e8', color: '#c07a2b' },
    webp: { bg: '#fdf4e8', color: '#c07a2b' },
    rs:   { bg: '#f0e8fd', color: '#7a2bc0' },
    js:   { bg: '#fdfce8', color: '#b0900a' },
    ts:   { bg: '#e8f4fd', color: '#2b7ac0' },
    go:   { bg: '#e8fdfc', color: '#0a9b9b' },
    py:   { bg: '#e8f4fd', color: '#2b5cc0' },
    sh:   { bg: '#e8fde8', color: '#2b8c2b' },
    txt:  { bg: '#f0ece6', color: '#8a8078' },
    md:   { bg: '#f0ece6', color: '#8a8078' },
};

function getExtStyle(filename) {
    const parts = filename.split('.');
    const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
    return EXT_COLORS[ext] || { bg: '#f0ece6', color: '#8a8078' };
}

function getExtLabel(filename) {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toUpperCase().slice(0, 4) : '?';
}

function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function timeAgo(dateStr) {
    const diff = Math.floor((Date.now() - new Date(dateStr)) / 1000);
    const abs = Math.abs(diff);

    if (abs < 10) return 'just now';

    if (diff < 0) {
        if (abs < 60) return 'in ' + abs + 's';
        if (abs < 3600) return 'in ' + Math.floor(abs / 60) + ' min';
        if (abs < 86400) return 'in ' + Math.floor(abs / 3600) + ' hr';
        return 'in ' + Math.floor(abs / 86400) + 'd';
    }

    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
    return Math.floor(diff / 86400) + 'd ago';
}

async function verifyKey(url, key) {
    try {
        const response = await httpRequest(`${url}/desktop/auth/verify?key=${key}`, {
            method: 'GET'
        });
        if (response.ok) {
            const data = await response.json();
            return { ok: true, data };
        }
        return { ok: false };
    } catch (e) {
        console.error(e);
        throw e;
    }
}

async function init() {
    onboardingScreen = document.getElementById('onboarding');
    mainScreen       = document.getElementById('main-drop');
    dropArea         = document.getElementById('drop-area');
    statusText       = document.getElementById('status-text');

    document.getElementById('btn-save').addEventListener('click', async () => {
        const key = document.getElementById('api-key').value.trim();
        let url   = document.getElementById('server-url').value.trim();

        if (!key || !url) {
            alert("Please fill all fields");
            return;
        }

        if (url.endsWith('/')) url = url.slice(0, -1);

        try {
            const result = await verifyKey(url, key);
            if (result.ok) {
                localStorage.setItem('dropzone_key', key);
                localStorage.setItem('dropzone_url', url);
                localStorage.setItem('dropzone_owner', result.data.owner);
                config.ownerName = result.data.owner;
                showMain();
            } else {
                alert("Invalid API Key");
            }
        } catch (e) {
            console.error(e);
            alert("Server unreachable: " + url);
        }
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
        localStorage.clear();
        window.location.reload();
    });

    const tauri = getTauriApi();

    if (tauri) {
        console.log("Tauri V2 Context Detected");
        try {
            appWindow = tauri.window.getCurrentWindow();
            listen    = tauri.event.listen;
            setupTauriListeners();
        } catch (err) {
            console.error("Error setting up Tauri hooks:", err);
        }
    } else {
        console.warn("Tauri context NOT detected. Running in standard browser mode.");
    }

    if (config.apiKey && config.serverUrl) {
        showMain();
    } else {
        showOnboarding();
    }
}

function showOnboarding() {
    if (!onboardingScreen) return;
    onboardingScreen.classList.remove('hidden');
    mainScreen.classList.add('hidden');
    document.getElementById('settings').classList.add('hidden');
}

function showMain() {
    if (!mainScreen) return;
    onboardingScreen.classList.add('hidden');
    document.getElementById('settings').classList.add('hidden');
    mainScreen.classList.remove('hidden');
    loadConfig();

    
    const qrDiv = document.getElementById('qrcode');
    if (qrDiv) {
        qrDiv.innerHTML = '';
        if (window.QRCode) {
            new QRCode(qrDiv, {
                text: JSON.stringify({
                    protocol:   "dropzone-v1",
                    server_url: config.serverUrl,
                    api_key:    config.apiKey,
                    owner:      config.ownerName
                }),
                width:      128,
                height:     128,
                colorDark:  "#2c2825",
                colorLight: "#ffffff"
            });
        }
    }

    loadRecentFiles();

    const ownerLabel = document.getElementById('owner-label');
    if (ownerLabel) ownerLabel.textContent = config.ownerName ? config.ownerName + "'s Dropzone" : 'Dropzone';

    document.getElementById('btn-settings').addEventListener('click', showSettings);
    document.getElementById('btn-back').addEventListener('click', () => {
        document.getElementById('settings').classList.add('hidden');
        mainScreen.classList.remove('hidden');
    });

    const pickerContainer = document.getElementById('duration-picker');
    if (pickerContainer) {
        pickerContainer.innerHTML = DURATIONS.map(d =>
            `<button class="dur-btn${config.duration === d.value ? ' active' : ''}"
                     data-value="${d.value}">${d.label}</button>`
        ).join('');
        pickerContainer.querySelectorAll('.dur-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                config.duration = btn.dataset.value;
                localStorage.setItem('dropzone_duration', config.duration);
                pickerContainer.querySelectorAll('.dur-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });
    }
}

function showSettings() {
    mainScreen.classList.add('hidden');
    document.getElementById('settings').classList.remove('hidden');

    document.getElementById('s-owner').textContent = config.ownerName || '—';

    
    const key = config.apiKey || '';
    document.getElementById('s-key').textContent =
        key.length > 8 ? key.slice(0, 8) + '-••••-••••-••••' : key || '—';

    
    const url = config.serverUrl || '';
    document.getElementById('s-url').textContent =
        url.replace(/^https?:\/\//, '') || '—';
}

async function setupTauriListeners() {
    window.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape' && appWindow) {
            await appWindow.hide();
        }
    });

    if (listen) {
        await listen('tauri://drag-drop', (event) => {
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
                uploadFiles(paths);
            }
        });
    }
}

async function loadRecentFiles() {
    if (!config.apiKey || !config.serverUrl) return;

    try {
        const res = await httpRequest(`${config.serverUrl}/desktop/files`, {
           headers: { 'X-API-KEY': config.apiKey }

        });
        if (!res.ok) return;

        const text  = await res.text();
        const files = text ? JSON.parse(text) : [];
        const list  = document.getElementById('file-list');
        list.innerHTML = '';

        (files || []).slice(0, 8).forEach(f => {
            const { bg, color } = getExtStyle(f.file_name);
            const ext  = getExtLabel(f.file_name);
            const size = formatSize(f.file_size);
            const ago  = f.uploaded_at ? timeAgo(f.uploaded_at) : '';
            const exp  = f.expires_at  ? 'expires ' + timeAgo(f.expires_at) : '';
            const meta = [size, ago, exp].filter(Boolean).join(' · ');
            const item = document.createElement('div');
            item.className = 'file-item';
            item.innerHTML = `
                <div class="file-ext" style="background:${bg};color:${color};">${ext}</div>
                <div class="file-info">
                    <div class="file-name">${f.file_name}</div>
                    <div class="file-meta">${meta}</div>
                </div>
                <button class="file-dl" title="Download">
                    <svg viewBox="0 0 24 24"><path d="M12 3v11M12 14l-4-4M12 14l4-4M4 20h16"/></svg>
                </button>`;

            item.querySelector('.file-dl').addEventListener('click', async () => {
                const blob = await httpRequest(`${config.serverUrl}/api/files/${f.id}`, {
                    headers: { 'X-API-KEY': config.apiKey }
                }).then(r => r.blob());
                const url = URL.createObjectURL(blob);
                const a   = document.createElement('a');
                a.href = url; a.download = f.file_name; a.click();
                URL.revokeObjectURL(url);
            });

            list.appendChild(item);
        });
    } catch (e) {
        console.error("Failed to load files:", e);
    }
}


async function uploadFiles(paths) {
    const statusText  = document.getElementById('status-text');
    const dropArea    = document.getElementById('drop-area');
    const fs          = window.__TAURI__.fs;

    if (statusText) statusText.innerText = 'Uploading…';
    if (dropArea)   dropArea.classList.add('active');

    let progressBar = document.getElementById('upload-progress');
    if (!progressBar) {
        progressBar = document.createElement('div');
        progressBar.id = 'upload-progress';
        progressBar.innerHTML = '<div id="upload-progress-fill"></div>';
        dropArea.appendChild(progressBar);
    }
    const fill = document.getElementById('upload-progress-fill');
    fill.style.width = '0%';

    for (let i = 0; i < paths.length; i++) {
        const path     = paths[i];
        const fileName = path.split(/[\\/]/).pop();

        try {
            const fileBytes  = await fs.readFile(path);
            const totalSize  = fileBytes.byteLength;
            const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

            if (statusText) statusText.innerText = `Uploading ${fileName}…`;

            const initRes = await httpRequest(`${config.serverUrl}/desktop/upload/init`, {
                method:  'POST',
                headers: { 'X-API-KEY': config.apiKey, 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    file_name:    fileName,
                    file_size:    totalSize,
                    total_chunks: totalChunks,
                    chunk_size:   CHUNK_SIZE,
                }),
            });
            if (!initRes.ok) throw new Error('Init failed: ' + await initRes.text());
            const { session_id } = await initRes.json();

            for (let ci = 0; ci < totalChunks; ci++) {
                const start  = ci * CHUNK_SIZE;
                const end    = Math.min(start + CHUNK_SIZE, totalSize);
                const chunk  = fileBytes.slice(start, end);

                const form = new FormData();
                form.append('session_id',  session_id);
                form.append('chunk_index', String(ci));
                form.append('chunk',       new Blob([chunk]), 'chunk');

                const chunkRes = await httpRequest(`${config.serverUrl}/desktop/upload/chunk`, {
                    method:  'POST',
                    headers: { 'X-API-KEY': config.apiKey },
                    body:    form,
                });
                if (!chunkRes.ok) throw new Error('Chunk upload failed at index ' + ci);

                const fileProgress  = (ci + 1) / totalChunks;
                const totalProgress = (i + fileProgress) / paths.length;
                fill.style.width = (totalProgress * 100) + '%';
            }

            const completeRes = await httpRequest(`${config.serverUrl}/desktop/upload/complete`, {
                method:  'POST',
                headers: { 'X-API-KEY': config.apiKey, 'Content-Type': 'application/json' },
                body:    JSON.stringify({ session_id, confirmed: true }),
            });
            if (!completeRes.ok) throw new Error('Complete failed');

            if (statusText) statusText.innerText = `Assembling ${fileName}…`;
            await pollAssemblyStatus(session_id);

            const finalRes = await httpRequest(`${config.serverUrl}/desktop/upload/finalize`, {
                method:  'POST',
                headers: { 'X-API-KEY': config.apiKey, 'Content-Type': 'application/json' },
                body:    JSON.stringify({ session_id, duration: config.duration }),
            });
            if (!finalRes.ok) throw new Error('Finalize failed');

        } catch (err) {
            console.error('Upload error for', fileName, ':', err);
            if (statusText) statusText.innerText = `Error uploading ${fileName}`;
        }
    }

    if (statusText) statusText.innerText = 'Done!';
    if (dropArea)   dropArea.classList.remove('active');
    setTimeout(() => { if (progressBar) progressBar.remove(); }, 800);
    setTimeout(() => {
        if (statusText) statusText.innerText = 'Drop a file, or click to pick one';
    }, 2000);
    loadRecentFiles();
}

async function pollAssemblyStatus(sessionID) {
    const maxAttempts = 60; // 30s max
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
            const res  = await httpRequest(`${config.serverUrl}/desktop/upload/status/${sessionID}`, {
                headers: { 'X-API-KEY': config.apiKey },
            });
            const data = await res.json();
            if (data.status === 'done') return;
            if (data.status && data.status.startsWith('error:')) {
                throw new Error(data.status);
            }
        } catch (e) {
            throw e;
        }
    }
    throw new Error('Assembly timed out');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}