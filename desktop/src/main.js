const getTauriApi = () => {
    try {
        return window.__TAURI__;
    } catch (e) {
        return null;
    }
};

let appWindow = null;
let listen = null;

function loadConfig() {
    config = {
        apiKey: localStorage.getItem('dropzone_key'),
        serverUrl: localStorage.getItem('dropzone_url'),
        ownerName: localStorage.getItem('dropzone_owner')
    };
}
let config = {};
loadConfig();

let onboardingScreen, mainScreen, dropArea, statusText;

// Maps file extension → { bg, color }
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
    if (diff < 10)  return 'just now';
    if (diff < 60)  return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
    return Math.floor(diff / 86400) + 'd ago';
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
            const response = await fetch(`${url}/auth/verify?key=${key}`);
            if (response.ok) {
                localStorage.setItem('dropzone_key', key);
                localStorage.setItem('dropzone_url', url);
                const data = await response.json();
                localStorage.setItem('dropzone_owner', data.owner);
                config.ownerName = data.owner;
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

    // QR code
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
}

function showSettings() {
    mainScreen.classList.add('hidden');
    document.getElementById('settings').classList.remove('hidden');

    document.getElementById('s-owner').textContent = config.ownerName || '—';

    // Mask API key: show first 8 chars then ••••
    const key = config.apiKey || '';
    document.getElementById('s-key').textContent =
        key.length > 8 ? key.slice(0, 8) + '-••••-••••-••••' : key || '—';

    // Strip protocol for display
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
        const res = await fetch(`${config.serverUrl}/api/files`, {
            headers: { 'X-API-KEY': config.apiKey }
        });
        if (!res.ok) return;

        const text  = await res.text();
        const files = text ? JSON.parse(text) : [];
        const list  = document.getElementById('file-list');
        list.innerHTML = '';

        (files || []).slice(0, 8).forEach(f => {
            const { bg, color } = getExtStyle(f.file_name);
            const ext = getExtLabel(f.file_name);
            const size = formatSize(f.file_size);
            const ago  = f.uploaded_at ? timeAgo(f.uploaded_at) : '';
            const meta = [size, ago].filter(Boolean).join(' · ');

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
                const blob = await fetch(`${config.serverUrl}/api/files/${f.id}`, {
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
    const statusText = document.getElementById('status-text');
    const dropArea   = document.getElementById('drop-area');
    if (statusText) statusText.innerText = "Uploading…";
    if (dropArea) dropArea.classList.add('active');

    let progressBar = document.getElementById('upload-progress');
    if (!progressBar) {
        progressBar = document.createElement('div');
        progressBar.id = 'upload-progress';
        progressBar.innerHTML = '<div id="upload-progress-fill"></div>';
        dropArea.appendChild(progressBar);
    }
    const fill = document.getElementById('upload-progress-fill');
    fill.style.width = '0%';

    const fs = window.__TAURI__.fs;

    for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        const fileName = path.split(/[\\/]/).pop();
        try {
            const fileBytes = await fs.readFile(path);
            const blob = new Blob([fileBytes]);
            const form = new FormData();
            form.append('file', blob, fileName);

            await fetch(`${config.serverUrl}/api/upload`, {
                method: 'POST',
                headers: { 'X-API-KEY': config.apiKey },
                body: form
            });
        } catch (err) {
            console.error("File read error:", err);
        }
        fill.style.width = ((i + 1) / paths.length * 100) + '%';
    }

     if (statusText) statusText.innerText = "Done!";
     if (dropArea) dropArea.classList.remove('active');
     setTimeout(() => { if (progressBar) progressBar.remove(); }, 800);
     if (statusText) setTimeout(() => { statusText.innerText = "or click to pick one from your computer"; }, 2000);    loadRecentFiles();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}