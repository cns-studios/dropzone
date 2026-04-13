import { getTauriApi, httpRequest } from './lib/http.js';
import {
    approveEnrollment,
    downloadDesktopFile,
    listPendingEnrollments,
    listRecentUploads,
    listDesktopFiles,
    lookupFileByCode,
    rejectEnrollment,
    reportFile,
    uploadChunk,
    uploadComplete,
    uploadFinalize,
    uploadInit,
    uploadStatus,
    verifyDesktopKey,
} from './lib/desktopApi.js';
import { beginLoopbackOAuth, verifyLoopbackToken, waitForLoopbackOAuth } from './lib/oauth.js';

let appWindow = null;
let listen = null;
let updateState = {
    checking: false,
    installing: false,
    hasUpdate: false,
    currentVersion: '-',
    latestVersion: '-',
    downloadUrl: null,
    assetName: null,
};
let updateTimer = null;
let toastTimer = null;
let qrDebugTimer = null;
let desktopSocket = null;
let desktopSocketRetryTimer = null;
let enrollmentSocket = null;
let enrollmentSocketRetryTimer = null;
const pressedKeys = new Set();

const UPDATE_INTERVAL_MS = 3 * 60 * 60 * 1000;
const LAST_NOTIFIED_VERSION_KEY = 'dropzone_last_notified_update';

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
        accessToken: localStorage.getItem('dropzone_access_token'),
        serverUrl: localStorage.getItem('dropzone_url'),
        ownerName: localStorage.getItem('dropzone_owner'),
        duration: localStorage.getItem('dropzone_duration') || '7d',
    };
}
let config = {};
loadConfig();

let onboardingScreen, mainScreen, dropArea, statusText;
let recentFilesCache = [];
let recentSearchQuery = '';
let recentSearchOpen = false;
let modalResolver = null;
let pendingEnrollmentsCache = [];

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

function renderPairingQRCodes() {
    const targets = [
        document.getElementById('qrcode'),
        document.getElementById('qrcode-debug'),
    ];

    const payload = JSON.stringify({
        protocol: "dropzone-v1",
        server_url: config.serverUrl,
        api_key: config.apiKey,
        owner: config.ownerName,
    });

    targets.forEach((target) => {
        if (!target) return;
        target.innerHTML = '';
        if (window.QRCode) {
            new QRCode(target, {
                text: payload,
                width: 196,
                height: 196,
                colorDark: "#2c2825",
                colorLight: "#ffffff",
            });
        }
    });
}

function showDebugQrTemporarily() {
    const debugGroup = document.getElementById('qr-debug-group');
    if (!debugGroup) return;

    renderPairingQRCodes();
    debugGroup.classList.remove('hidden');

    if (qrDebugTimer) {
        clearTimeout(qrDebugTimer);
    }

    qrDebugTimer = setTimeout(() => {
        debugGroup.classList.add('hidden');
    }, 5000);
}

function getSearchSvg() {
    return '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
}

function getCloseSvg() {
    return '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
}

function renderRecentFiles() {
    const list = document.getElementById('file-list');
    const empty = document.getElementById('no-results');
    if (!list || !empty) return;

    const query = recentSearchQuery.trim().toLowerCase();
    const files = recentFilesCache.filter(f => {
        if (!query) return true;
        return (f.file_name || '').toLowerCase().includes(query);
    }).slice(0, 8);

    list.innerHTML = '';

    if (files.length === 0) {
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');

    files.forEach(f => {
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
            <button class="file-report" title="Report">
                <svg viewBox="0 0 24 24"><path d="M5 4v16"/><path d="M5 5h11l-2 4 2 4H5"/></svg>
            </button>
            <button class="file-dl" title="Download">
                <svg viewBox="0 0 24 24"><path d="M12 3v11M12 14l-4-4M12 14l4-4M4 20h16"/></svg>
            </button>`;

        item.querySelector('.file-report').addEventListener('click', async () => {
            try {
                const res = await reportFile(config, f.id);
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload.error || 'Failed to report file');
                showToast(payload.message || 'File reported. Thank you.');
            } catch (err) {
                console.error('Report failed:', err);
                showToast(err.message || 'Failed to report file');
            }
        });

        item.querySelector('.file-dl').addEventListener('click', async () => {
            const blob = await downloadDesktopFile(config, f.id).then((r) => r.blob());
            const url = URL.createObjectURL(blob);
            const a   = document.createElement('a');
            a.href = url; a.download = f.file_name; a.click();
            URL.revokeObjectURL(url);
        });

        list.appendChild(item);
    });
}

function getOrCreateApproverDeviceId() {
    const existing = localStorage.getItem('dropzone_device_id');
    if (existing && existing.trim()) {
        return existing.trim();
    }

    const randomPart = Math.random().toString(16).slice(2, 10);
    const generated = `dz-${randomPart}`;
    localStorage.setItem('dropzone_device_id', generated);
    return generated;
}

function setEnrollmentResult(message, isError = false) {
    const result = document.getElementById('enroll-result');
    if (!result) return;
    result.textContent = message;
    result.classList.remove('hidden');
    result.style.color = isError ? '#b84f4f' : '';
}

function renderPendingEnrollments() {
    const list = document.getElementById('enroll-pending-list');
    if (!list) return;

    if (!pendingEnrollmentsCache.length) {
        list.innerHTML = '<div class="enroll-item-meta">No pending device enrollments.</div>';
        return;
    }

    list.innerHTML = '';

    pendingEnrollmentsCache.forEach((item) => {
        const enrollment = item?.enrollment || {};
        const requestDevice = item?.request_device || {};
        const deviceName = requestDevice.device_label || requestDevice.id || enrollment.request_device_id || 'Unknown device';
        const verificationCode = enrollment.verification_code || 'n/a';
        const expiresAt = enrollment.expires_at ? timeAgo(enrollment.expires_at) : 'n/a';
        const enrollmentId = enrollment.id || '';

        const row = document.createElement('div');
        row.className = 'enroll-item';
        row.innerHTML = `
            <div class="enroll-item-top">
                <div class="enroll-item-title">${deviceName}</div>
                <div>
                    <button class="enroll-action enroll-action-approve" title="Approve enrollment request">Approve</button>
                    <button class="enroll-action enroll-action-reject" title="Reject enrollment request">Reject</button>
                </div>
            </div>
            <div class="enroll-item-meta">Code: ${verificationCode}</div>
            <div class="enroll-item-meta">Enrollment ID: ${enrollmentId || 'n/a'}</div>
            <div class="enroll-item-meta">Expires: ${expiresAt}</div>
        `;

        row.querySelector('.enroll-action-approve')?.addEventListener('click', async () => {
            const approverInput = document.getElementById('enroll-approver-device-id');
            const wrappedUkInput = document.getElementById('enroll-wrapped-uk');
            const wrapAlgInput = document.getElementById('enroll-uk-wrap-alg');
            const wrapMetaInput = document.getElementById('enroll-uk-wrap-meta');

            const approverDeviceID = (approverInput?.value || '').trim();
            const wrappedUserKeyB64 = (wrappedUkInput?.value || '').trim();
            const ukWrapAlg = (wrapAlgInput?.value || '').trim();
            const ukWrapMetaRaw = (wrapMetaInput?.value || '').trim();

            if (!approverDeviceID) {
                setEnrollmentResult('Approver device ID is required to approve a request.', true);
                return;
            }
            if (!wrappedUserKeyB64) {
                setEnrollmentResult('Wrapped user key is required to approve a request.', true);
                return;
            }
            if (!ukWrapAlg) {
                setEnrollmentResult('Wrap algorithm is required to approve a request.', true);
                return;
            }

            let ukWrapMeta = {};
            if (ukWrapMetaRaw) {
                try {
                    ukWrapMeta = JSON.parse(ukWrapMetaRaw);
                } catch (_) {
                    setEnrollmentResult('Wrap metadata must be valid JSON.', true);
                    return;
                }
            }
            if (!enrollmentId) {
                setEnrollmentResult('Enrollment ID is missing for this request.', true);
                return;
            }

            try {
                const res = await approveEnrollment(config, enrollmentId, {
                    approver_device_id: approverDeviceID,
                    verification_code: verificationCode,
                    wrapped_user_key_b64: wrappedUserKeyB64,
                    uk_wrap_alg: ukWrapAlg,
                    uk_wrap_meta: ukWrapMeta,
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) {
                    setEnrollmentResult(payload.error || 'Failed to approve enrollment.', true);
                    return;
                }
                setEnrollmentResult('Enrollment approved.');
                await refreshPendingEnrollments();
            } catch (err) {
                console.error('Approve enrollment failed:', err);
                setEnrollmentResult('Failed to approve enrollment.', true);
            }
        });

        row.querySelector('.enroll-action-reject')?.addEventListener('click', async () => {
            const approverInput = document.getElementById('enroll-approver-device-id');
            const approverDeviceID = (approverInput?.value || '').trim();
            if (!approverDeviceID) {
                setEnrollmentResult('Approver device ID is required to reject a request.', true);
                return;
            }
            if (!enrollmentId) {
                setEnrollmentResult('Enrollment ID is missing for this request.', true);
                return;
            }

            try {
                const res = await rejectEnrollment(config, enrollmentId, {
                    approver_device_id: approverDeviceID,
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) {
                    setEnrollmentResult(payload.error || 'Failed to reject enrollment.', true);
                    return;
                }
                setEnrollmentResult('Enrollment rejected.');
                await refreshPendingEnrollments();
            } catch (err) {
                console.error('Reject enrollment failed:', err);
                setEnrollmentResult('Failed to reject enrollment.', true);
            }
        });

        list.appendChild(row);
    });
}

async function refreshPendingEnrollments() {
    if (!config.accessToken) {
        pendingEnrollmentsCache = [];
        renderPendingEnrollments();
        setEnrollmentResult('Sign in with OAuth to manage device enrollments.', true);
        return;
    }

    try {
        const res = await listPendingEnrollments(config);
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
            setEnrollmentResult(payload.error || 'Failed to load pending enrollments.', true);
            return;
        }
        pendingEnrollmentsCache = Array.isArray(payload?.items) ? payload.items : [];
        renderPendingEnrollments();
        setEnrollmentResult(`${pendingEnrollmentsCache.length} pending enrollment(s) loaded.`);
    } catch (err) {
        console.error('Pending enrollments load failed:', err);
        setEnrollmentResult('Failed to load pending enrollments.', true);
    }
}

function setRecentSearchOpen(open) {
    recentSearchOpen = open;

    const label = document.getElementById('recent-label');
    const wrap = document.querySelector('.recent-search');
    const input = document.getElementById('recent-search-input');
    const button = document.getElementById('btn-toggle-search');

    if (label) label.classList.toggle('hidden', open);
    if (wrap) wrap.classList.toggle('is-open', open);
    if (input) {
        input.classList.toggle('visible', open);
        input.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    if (button) {
        button.innerHTML = open ? getCloseSvg() : getSearchSvg();
        button.title = open ? 'Close search' : 'Search uploads';
        button.setAttribute('aria-label', open ? 'Close search' : 'Search uploads');
    }

    if (open && input) {
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    }

    if (!open) {
        recentSearchQuery = '';
        if (input) input.value = '';
        renderRecentFiles();
    }
}

function closeModal(result) {
    const modal = document.getElementById('app-modal');
    if (modal) modal.classList.add('hidden');
    if (modalResolver) {
        const resolve = modalResolver;
        modalResolver = null;
        resolve(result);
    }
}

function showModal({
    title = 'Notice',
    message = '',
    okText = 'OK',
    cancelText = null,
}) {
    const modal = document.getElementById('app-modal');
    const titleEl = document.getElementById('app-modal-title');
    const messageEl = document.getElementById('app-modal-message');
    const okBtn = document.getElementById('app-modal-ok');
    const cancelBtn = document.getElementById('app-modal-cancel');

    if (!modal || !titleEl || !messageEl || !okBtn || !cancelBtn) {
        return Promise.resolve(false);
    }

    titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.textContent = okText;

    if (cancelText) {
        cancelBtn.textContent = cancelText;
        cancelBtn.classList.remove('hidden');
    } else {
        cancelBtn.classList.add('hidden');
    }

    if (modalResolver) {
        modalResolver(false);
        modalResolver = null;
    }

    modal.classList.remove('hidden');

    return new Promise((resolve) => {
        modalResolver = resolve;
    });
}

function bindModalEvents() {
    const modal = document.getElementById('app-modal');
    const okBtn = document.getElementById('app-modal-ok');
    const cancelBtn = document.getElementById('app-modal-cancel');
    const backdrop = modal ? modal.querySelector('.app-modal-backdrop') : null;

    if (okBtn && !okBtn.dataset.bound) {
        okBtn.dataset.bound = '1';
        okBtn.addEventListener('click', () => closeModal(true));
    }

    if (cancelBtn && !cancelBtn.dataset.bound) {
        cancelBtn.dataset.bound = '1';
        cancelBtn.addEventListener('click', () => closeModal(false));
    }

    if (backdrop && !backdrop.dataset.bound) {
        backdrop.dataset.bound = '1';
        backdrop.addEventListener('click', () => closeModal(false));
    }

    if (modal && !modal.dataset.bound) {
        modal.dataset.bound = '1';
        modal.addEventListener('click', (event) => {
            event.stopPropagation();
        });
    }

    if (!document.body.dataset.modalEscBound) {
        document.body.dataset.modalEscBound = '1';
        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                const modalEl = document.getElementById('app-modal');
                if (modalEl && !modalEl.classList.contains('hidden')) {
                    closeModal(false);
                }
            }
        });
    }
}

async function verifyKey(url, key) {
    try {
        const response = await verifyDesktopKey(url, key);
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

    bindModalEvents();

    const oauthBtn = document.getElementById('btn-oauth');
    const toolCodeInput = document.getElementById('tool-code-input');
    const toolCodeLookup = document.getElementById('tool-code-lookup');
    const toolReportInput = document.getElementById('tool-report-input');
    const toolReportSubmit = document.getElementById('tool-report-submit');
    const toolResult = document.getElementById('tool-result');

    const setToolResult = (message, isError = false) => {
        if (!toolResult) return;
        toolResult.textContent = message;
        toolResult.classList.remove('hidden');
        toolResult.style.color = isError ? '#b84f4f' : '';
    };

    toolCodeInput?.addEventListener('input', () => {
        toolCodeInput.value = toolCodeInput.value.replace(/\D/g, '').slice(0, 12);
    });

    toolCodeLookup?.addEventListener('click', async () => {
        const code = (toolCodeInput?.value || '').trim();
        if (!/^\d{12}$/.test(code)) {
            setToolResult('Lookup code must be a 12-digit numeric value.', true);
            return;
        }
        try {
            const res = await lookupFileByCode(config, code);
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
                setToolResult(payload.error || 'Lookup failed.', true);
                return;
            }
            const name = payload.original_name || payload.file_name || 'Unknown file';
            const size = payload.size_bytes ? formatSize(payload.size_bytes) : '';
            setToolResult(`Found: ${name}${size ? ` (${size})` : ''}`);
            if (toolReportInput && payload.id) {
                toolReportInput.value = payload.id;
            }
        } catch (err) {
            console.error('Code lookup failed:', err);
            setToolResult('Code lookup failed.', true);
        }
    });

    toolReportSubmit?.addEventListener('click', async () => {
        const fileId = (toolReportInput?.value || '').trim();
        if (!fileId) {
            setToolResult('Enter a file ID to report.', true);
            return;
        }
        try {
            const res = await reportFile(config, fileId);
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
                setToolResult(payload.error || 'Report failed.', true);
                return;
            }
            setToolResult(payload.message || 'File reported. Thank you.');
        } catch (err) {
            console.error('Report failed:', err);
            setToolResult('Report failed.', true);
        }
    });

    document.getElementById('btn-save').addEventListener('click', async () => {
        const key = document.getElementById('api-key').value.trim();
        let url   = document.getElementById('server-url').value.trim();

        if (!key || !url) {
            await showModal({
                title: 'Missing information',
                message: 'Please fill all fields before continuing.',
            });
            return;
        }

        if (url.endsWith('/')) url = url.slice(0, -1);

        try {
            const result = await verifyKey(url, key);
            if (result.ok) {
                localStorage.setItem('dropzone_key', key);
                localStorage.removeItem('dropzone_access_token');
                localStorage.setItem('dropzone_url', url);
                localStorage.setItem('dropzone_owner', result.data.owner);
                config.apiKey = key;
                config.accessToken = null;
                config.serverUrl = url;
                config.ownerName = result.data.owner;
                showMain();
            } else {
                await showModal({
                    title: 'Authentication failed',
                    message: 'Invalid API key.',
                });
            }
        } catch (e) {
            console.error(e);
            await showModal({
                title: 'Server unreachable',
                message: 'Could not reach: ' + url,
            });
        }
    });

    oauthBtn?.addEventListener('click', async () => {
        let url = 'https://shareit.cns-studios.com';
        if (url.endsWith('/')) url = url.slice(0, -1);

        oauthBtn.disabled = true;
        const originalLabel = oauthBtn.textContent;
        oauthBtn.textContent = 'Opening browser...';

        try {
            const sessionId = await beginLoopbackOAuth(url, tauriInvoke);
            oauthBtn.textContent = 'Waiting for login...';
            const result = await waitForLoopbackOAuth(tauriInvoke, sessionId);
            const verifyPayload = await verifyLoopbackToken(url, result.access_token);

            localStorage.setItem('dropzone_access_token', result.access_token);
            localStorage.removeItem('dropzone_key');
            localStorage.setItem('dropzone_url', url);
            localStorage.setItem('dropzone_owner', verifyPayload.owner || 'Authenticated User');

            config.accessToken = result.access_token;
            config.apiKey = null;
            config.serverUrl = url;
            config.ownerName = verifyPayload.owner || 'Authenticated User';

            showMain();
        } catch (error) {
            console.error('OAuth login failed:', error);
            await showModal({
                title: 'OAuth login failed',
                message: error?.message || 'Could not complete OAuth login. You can still use API key login.',
            });
        } finally {
            oauthBtn.disabled = false;
            oauthBtn.textContent = originalLabel || 'Sign in with CNS account';
        }
    });

    document.getElementById('btn-reset').addEventListener('click', async () => {
        const confirmed = await showModal({
            title: 'Sign out',
            message: 'Are you sure you want to sign out and reset this app on this device?',
            okText: 'Sign out',
            cancelText: 'Cancel',
        });
        if (!confirmed) return;

        disconnectDesktopSocket();
        disconnectEnrollmentSocket();
        localStorage.clear();
        window.location.reload();
    });

    const toast = document.getElementById('update-toast');
    if (toast && !toast.dataset.bound) {
        toast.dataset.bound = '1';
        toast.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toast.classList.remove('visible');
            setTimeout(() => toast.classList.add('hidden'), 300);
        });
    }

    const tauri = getTauriApi();

    if (tauri) {
        console.log("Tauri V2 Context Detected");
        try {
            appWindow = tauri.window.getCurrentWindow();
            listen    = tauri.event.listen;
            setupTauriListeners();
            setupUpdater();
        } catch (err) {
            console.error("Error setting up Tauri hooks:", err);
        }
    } else {
        console.warn("Tauri context NOT detected. Running in standard browser mode.");
    }

    if ((config.apiKey || config.accessToken) && config.serverUrl) {
        showMain();
    } else {
        showOnboarding();
    }
}

function tauriInvoke(command, payload = {}) {
    const tauri = getTauriApi();
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
        throw new Error('Tauri invoke API unavailable');
    }
    return tauri.core.invoke(command, payload);
}

function showToast(message) {
    const toast = document.getElementById('update-toast');
    if (!toast) return;

    toast.textContent = message;
    toast.classList.remove('hidden');
    requestAnimationFrame(() => {
        toast.classList.add('visible');
    });

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.classList.add('hidden'), 300);
    }, 3800);
}

async function sendDesktopNotification(title, body) {
    if (typeof Notification === 'undefined') return;

    try {
        if (Notification.permission === 'granted') {
            new Notification(title, { body });
            return;
        }

        if (Notification.permission !== 'denied') {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                new Notification(title, { body });
            }
        }
    } catch (err) {
        console.warn('Desktop notification failed:', err);
    }
}

function renderUpdaterUi() {
    const appVersion = document.getElementById('s-app-version');
    const status = document.getElementById('s-update-status');
    const btn = document.getElementById('btn-check-update');
    if (!appVersion || !status || !btn) return;

    appVersion.textContent = updateState.currentVersion || '-';

    if (updateState.checking) {
        status.textContent = 'Checking for updates...';
        btn.textContent = 'Checking...';
        btn.disabled = true;
        btn.classList.remove('install');
        return;
    }

    if (updateState.installing) {
        status.textContent = 'Downloading update and preparing installer...';
        btn.textContent = 'Installing...';
        btn.disabled = true;
        btn.classList.add('install');
        return;
    }

    if (updateState.hasUpdate) {
        status.textContent = `Update available: v${updateState.latestVersion}`;
        btn.textContent = 'Download and install';
        btn.disabled = false;
        btn.classList.add('install');
        return;
    }

    status.textContent = 'You are on the latest version.';
    btn.textContent = 'Check for updates';
    btn.disabled = false;
    btn.classList.remove('install');
}

async function checkForUpdates(options = {}) {
    const manual = !!options.manual;

    updateState.checking = true;
    renderUpdaterUi();

    try {
        const info = await tauriInvoke('check_for_updates');

        updateState.currentVersion = info.current_version || updateState.currentVersion;
        updateState.latestVersion = info.latest_version || updateState.latestVersion;
        updateState.hasUpdate = !!info.has_update;
        updateState.downloadUrl = info.download_url || null;
        updateState.assetName = info.asset_name || null;

        if (updateState.hasUpdate) {
            const lastNotified = localStorage.getItem(LAST_NOTIFIED_VERSION_KEY);
            if (lastNotified !== updateState.latestVersion) {
                localStorage.setItem(LAST_NOTIFIED_VERSION_KEY, updateState.latestVersion);
                sendDesktopNotification(
                    'Dropzone update available',
                    `New update available (v${updateState.latestVersion}). Open settings to install.`
                );
                showToast('New update available! Go to Settings to install.');
            } else if (manual) {
                showToast(`Update available: v${updateState.latestVersion}`);
            }
        } else if (manual) {
            showToast('You are already on the latest version.');
        }
    } catch (err) {
        console.error('Update check failed:', err);
        if (manual) showToast('Update check failed. Please try again.');
    } finally {
        updateState.checking = false;
        renderUpdaterUi();
    }
}

async function downloadAndInstallUpdate() {
    if (!updateState.hasUpdate || !updateState.downloadUrl || !updateState.assetName) {
        showToast('No downloadable update was found for this platform.');
        return;
    }

    updateState.installing = true;
    renderUpdaterUi();

    try {
        showToast('Preparing update installer...');
        await tauriInvoke('download_and_install_update', {
            download_url: updateState.downloadUrl,
            asset_name: updateState.assetName,
        });
    } catch (err) {
        console.error('Install update failed:', err);
        const msg = String(err || 'Update install failed');
        showToast(msg.includes('dropzone --update')
            ? 'GUI elevation failed. Run: dropzone --update'
            : 'Update install failed. Please try again.');
        updateState.installing = false;
        renderUpdaterUi();
    }
}

async function setupUpdater() {
    try {
        updateState.currentVersion = await tauriInvoke('app_version');
    } catch (err) {
        console.warn('Unable to read app version via backend:', err);
    }

    const btn = document.getElementById('btn-check-update');
    if (btn && !btn.dataset.bound) {
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
            if (updateState.hasUpdate) {
                downloadAndInstallUpdate();
            } else {
                checkForUpdates({ manual: true });
            }
        });
    }

    renderUpdaterUi();
    checkForUpdates({ manual: false });

    if (updateTimer) clearInterval(updateTimer);
    updateTimer = setInterval(() => {
        checkForUpdates({ manual: false });
    }, UPDATE_INTERVAL_MS);
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

    
    renderPairingQRCodes();
    connectDesktopSocket();
    connectEnrollmentSocket();

    loadRecentFiles();

    const searchButton = document.getElementById('btn-toggle-search');
    const searchInput = document.getElementById('recent-search-input');
    if (searchButton && !searchButton.dataset.bound) {
        searchButton.dataset.bound = '1';
        searchButton.addEventListener('click', () => {
            setRecentSearchOpen(!recentSearchOpen);
        });
    }
    if (searchInput && !searchInput.dataset.bound) {
        searchInput.dataset.bound = '1';
        searchInput.addEventListener('input', () => {
            recentSearchQuery = searchInput.value;
            if (config.accessToken) {
                loadRecentFiles();
            } else {
                renderRecentFiles();
            }
        });
        searchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                setRecentSearchOpen(false);
            }
        });
    }

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

function disconnectDesktopSocket() {
    if (desktopSocketRetryTimer) {
        clearTimeout(desktopSocketRetryTimer);
        desktopSocketRetryTimer = null;
    }
    if (desktopSocket) {
        try {
            desktopSocket.onclose = null;
            desktopSocket.close();
        } catch (_) {
        }
        desktopSocket = null;
    }
}

function disconnectEnrollmentSocket() {
    if (enrollmentSocketRetryTimer) {
        clearTimeout(enrollmentSocketRetryTimer);
        enrollmentSocketRetryTimer = null;
    }
    if (enrollmentSocket) {
        try {
            enrollmentSocket.onclose = null;
            enrollmentSocket.close();
        } catch (_) {
        }
        enrollmentSocket = null;
    }
}

function connectDesktopSocket() {
    disconnectDesktopSocket();

    if (!config.serverUrl || (!config.apiKey && !config.accessToken)) {
        return;
    }

    let wsUrl = '';
    try {
        const base = new URL(config.serverUrl);
        const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${scheme}//${base.host}/desktop/ws`;
        if (config.accessToken) {
            wsUrl += `?token=${encodeURIComponent(config.accessToken)}`;
        } else {
            wsUrl += `?key=${encodeURIComponent(config.apiKey)}`;
        }
    } catch (err) {
        console.error('Invalid server URL for websocket:', err);
        return;
    }

    try {
        desktopSocket = new WebSocket(wsUrl);
    } catch (err) {
        console.error('Failed to create websocket:', err);
        scheduleDesktopSocketReconnect();
        return;
    }

    desktopSocket.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            if (payload?.type === 'new_file') {
                loadRecentFiles();
                showToast('New upload available in your list.');
            }
        } catch (_) {
        }
    };

    desktopSocket.onclose = () => {
        scheduleDesktopSocketReconnect();
    };

    desktopSocket.onerror = () => {
        try {
            desktopSocket?.close();
        } catch (_) {
        }
    };
}

function connectEnrollmentSocket() {
    disconnectEnrollmentSocket();

    if (!config.serverUrl || !config.accessToken) {
        return;
    }

    let wsUrl = '';
    try {
        const base = new URL(config.serverUrl);
        const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${scheme}//${base.host}/desktop/me/devices/ws?token=${encodeURIComponent(config.accessToken)}`;
    } catch (err) {
        console.error('Invalid server URL for enrollment websocket:', err);
        return;
    }

    try {
        enrollmentSocket = new WebSocket(wsUrl);
    } catch (err) {
        console.error('Failed to create enrollment websocket:', err);
        scheduleEnrollmentSocketReconnect();
        return;
    }

    enrollmentSocket.onmessage = () => {
        refreshPendingEnrollments();
    };

    enrollmentSocket.onclose = () => {
        scheduleEnrollmentSocketReconnect();
    };

    enrollmentSocket.onerror = () => {
        try {
            enrollmentSocket?.close();
        } catch (_) {
        }
    };
}

function scheduleDesktopSocketReconnect() {
    if (desktopSocketRetryTimer) {
        clearTimeout(desktopSocketRetryTimer);
    }
    desktopSocketRetryTimer = setTimeout(() => {
        desktopSocketRetryTimer = null;
        connectDesktopSocket();
    }, 4000);
}

function scheduleEnrollmentSocketReconnect() {
    if (enrollmentSocketRetryTimer) {
        clearTimeout(enrollmentSocketRetryTimer);
    }
    enrollmentSocketRetryTimer = setTimeout(() => {
        enrollmentSocketRetryTimer = null;
        connectEnrollmentSocket();
    }, 4000);
}

function showSettings() {
    mainScreen.classList.add('hidden');
    document.getElementById('settings').classList.remove('hidden');

    document.getElementById('s-owner').textContent = config.ownerName || '—';

    
    const key = config.apiKey || '';
    if (config.accessToken) {
        document.getElementById('s-key').textContent = 'OAuth bearer token';
    } else {
        document.getElementById('s-key').textContent =
            key.length > 8 ? key.slice(0, 8) + '-••••-••••-••••' : key || '—';
    }

    
    const url = config.serverUrl || '';
    document.getElementById('s-url').textContent =
        url.replace(/^https?:\/\//, '') || '—';

    const approverInput = document.getElementById('enroll-approver-device-id');
    if (approverInput) {
        approverInput.value = getOrCreateApproverDeviceId();
        if (!approverInput.dataset.bound) {
            approverInput.dataset.bound = '1';
            approverInput.addEventListener('change', () => {
                const nextValue = approverInput.value.trim();
                if (nextValue) {
                    localStorage.setItem('dropzone_device_id', nextValue);
                }
            });
        }
    }

    const wrapAlgInput = document.getElementById('enroll-uk-wrap-alg');
    if (wrapAlgInput && !wrapAlgInput.value.trim()) {
        wrapAlgInput.value = 'x25519-xsalsa20-poly1305';
    }

    const wrapMetaInput = document.getElementById('enroll-uk-wrap-meta');
    if (wrapMetaInput && !wrapMetaInput.value.trim()) {
        wrapMetaInput.value = '{"version":1}';
    }

    const refreshEnrollmentsButton = document.getElementById('enroll-refresh');
    if (refreshEnrollmentsButton && !refreshEnrollmentsButton.dataset.bound) {
        refreshEnrollmentsButton.dataset.bound = '1';
        refreshEnrollmentsButton.addEventListener('click', refreshPendingEnrollments);
    }

    if (config.accessToken) {
        refreshPendingEnrollments();
    } else {
        pendingEnrollmentsCache = [];
        renderPendingEnrollments();
        setEnrollmentResult('Sign in with OAuth to manage device enrollments.', true);
    }

    renderUpdaterUi();
}

async function setupTauriListeners() {
    window.addEventListener('keydown', async (e) => {
        pressedKeys.add((e.key || '').toLowerCase());

        const hasAlt = e.altKey || pressedKeys.has('alt');
        const hasQ = pressedKeys.has('q');
        const hasR = pressedKeys.has('r');
        if (hasAlt && hasQ && hasR) {
            showDebugQrTemporarily();
        }

        if (e.key === 'Escape' && appWindow) {
            await appWindow.hide();
        }
    });

    window.addEventListener('keyup', (e) => {
        pressedKeys.delete((e.key || '').toLowerCase());
    });

    window.addEventListener('blur', () => {
        pressedKeys.clear();
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
    if ((!config.apiKey && !config.accessToken) || !config.serverUrl) return;

    try {
        const res = config.accessToken
            ? await listRecentUploads(config, { page: 1, perPage: 50, query: recentSearchQuery.trim() })
            : await listDesktopFiles(config);
        if (!res.ok) return;

        if (config.accessToken) {
            const payload = await res.json();
            const items = Array.isArray(payload?.items) ? payload.items : [];
            recentFilesCache = items.map((item) => ({
                id: item.file_id,
                file_name: item.filename,
                file_size: item.size_bytes,
                uploaded_at: item.created_at,
                expires_at: item.expires_at,
                share_url: item.share_url,
            }));
        } else {
            const text = await res.text();
            recentFilesCache = text ? JSON.parse(text) : [];
        }
        renderRecentFiles();
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

            const initRes = await uploadInit(config, {
                file_name: fileName,
                file_size: totalSize,
                total_chunks: totalChunks,
                chunk_size: CHUNK_SIZE,
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

                const chunkRes = await uploadChunk(config, form);
                if (!chunkRes.ok) throw new Error('Chunk upload failed at index ' + ci);

                const fileProgress  = (ci + 1) / totalChunks;
                const totalProgress = (i + fileProgress) / paths.length;
                fill.style.width = (totalProgress * 100) + '%';
            }

            const completeRes = await uploadComplete(config, session_id);
            if (!completeRes.ok) throw new Error('Complete failed');

            if (statusText) statusText.innerText = `Assembling ${fileName}…`;
            await pollAssemblyStatus(session_id);

            const finalRes = await uploadFinalize(config, { session_id, duration: config.duration });
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
            const res = await uploadStatus(config, sessionID);
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