const getTauriApi = () => {
    try {
        return window.__TAURI__;
    } catch (e) {
        return null;
    }
};

let appWindow = null;
let listen = null;

let config = {
    apiKey: localStorage.getItem('dropzone_key'),
    serverUrl: localStorage.getItem('dropzone_url')
};

let onboardingScreen, mainScreen, dropArea, statusText;

async function init() {
    console.log("Initializing Dropzone UI...");
    
    onboardingScreen = document.getElementById('onboarding');
    mainScreen = document.getElementById('main-drop');
    dropArea = document.getElementById('drop-area');
    statusText = document.getElementById('status-text');

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
    
    const qrDiv = document.getElementById('qrcode');
    if (qrDiv) {
        qrDiv.innerHTML = '';
        if (window.QRCode) {
            new QRCode(qrDiv, {
                text: JSON.stringify({
                    protocol: "dropzone-v1",
                    server_url: config.serverUrl,
                    api_key: config.apiKey
                }),
                width: 128,
                height: 128,
                colorDark : "#000000",
                colorLight : "#ffffff"
            });
        }
    }
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
            config = { apiKey: key, serverUrl: url };
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

async function uploadFiles(paths) {
    if (!statusText || !dropArea) return;
    
    statusText.innerText = "Uploading...";
    dropArea.classList.add('active');
    
    console.log("Preparing to upload:", paths);
    
    setTimeout(() => {
        statusText.innerText = "Ready to sync";
        dropArea.classList.remove('active');
    }, 2000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}