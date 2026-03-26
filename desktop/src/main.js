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

async function init() {
    onboardingScreen = document.getElementById('onboarding');
    mainScreen = document.getElementById('main-drop');
    dropArea = document.getElementById('drop-area');
    statusText = document.getElementById('status-text');

    document.getElementById('btn-save').addEventListener('click', async () => {
        const key = document.getElementById('api-key').value.trim();
        let url = document.getElementById('server-url').value.trim();

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
            listen = tauri.event.listen;
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
}

function showMain() {
    if (!mainScreen) return;
    onboardingScreen.classList.add('hidden');
    mainScreen.classList.remove('hidden');
    loadConfig();

    const qrDiv = document.getElementById('qrcode');
    if (qrDiv) {
        qrDiv.innerHTML = '';
        if (window.QRCode) {
            new QRCode(qrDiv, {
                text: JSON.stringify({
                    protocol: "dropzone-v1",
                    server_url: config.serverUrl,
                    api_key: config.apiKey,
                    owner: config.ownerName
                }),
                width: 128,
                height: 128,
                colorDark : "#000000",
                colorLight : "#ffffff"
            });
        }
    }
    loadRecentFiles();
    document.getElementById('owner-label').textContent = config.ownerName || '';
    document.getElementById('btn-settings').addEventListener('click', showSettings);

    function showSettings() {
        mainScreen.classList.add('hidden');
        document.getElementById('settings').classList.remove('hidden');
        document.getElementById('s-owner').textContent = config.ownerName || '—';
        document.getElementById('s-key').textContent = config.apiKey || '—';
        document.getElementById('s-url').textContent = config.serverUrl || '—';
    }

    document.getElementById('btn-back').addEventListener('click', () => {
        document.getElementById('settings').classList.add('hidden');
        mainScreen.classList.remove('hidden');
    });
}

async function setupTauriListeners() {
    window.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape' && appWindow) {
            await appWindow.hide();
        }
    });

    if (listen) {
        await listen('tauri://drag-drop', (event) => {
            console.log("File drop detected:", event);
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
                uploadFiles(paths);
            }
        });
    }
}

async function loadRecentFiles() {
    if (!config.apiKey || !config.serverUrl) return;
    const res = await fetch(`${config.serverUrl}/api/files`, {
        headers: { 'X-API-KEY': config.apiKey }
    });
    if (!res.ok) return;

    const text = await res.text();
    const files = text ? JSON.parse(text) : [];

    const list = document.getElementById('file-list');
    list.innerHTML = '';
    (files || []).slice(0, 8).forEach(f => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = `
            <span class="file-name">${f.file_name}</span>
            <a class="file-dl" href="${config.serverUrl}/api/files/${f.id}"
               download="${f.file_name}"
               onclick="this.setAttribute('href', this.href); return true;">↓</a>`;
        item.querySelector('.file-dl').addEventListener('click', async (e) => {
            e.preventDefault();
            const blob = await fetch(`${config.serverUrl}/api/files/${f.id}`, {
                headers: { 'X-API-KEY': config.apiKey }
            }).then(r => r.blob());
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = f.file_name; a.click();
            URL.revokeObjectURL(url);
        });
        list.appendChild(item);
    });
}

async function uploadFiles(paths) {
    statusText.innerText = "Uploading...";
    dropArea.classList.add('active');
    
    const fs = window.__TAURI__.fs; 

    for (const path of paths) {
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
    }
    statusText.innerText = "Done!";
    dropArea.classList.remove('active');
    loadRecentFiles();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}