import { getTauriApi, httpRequest } from './lib/http.js';
import {
    approveEnrollment,
    createEnrollment,
    downloadDesktopFile,
    listPendingEnrollments,
    listRecentUploads,
    listDesktopFiles,
    registerDevice,
    rejectEnrollment,
    uploadChunk,
    uploadComplete,
    uploadFinalize,
    uploadInit,
    uploadStatus,
    verifyDesktopKey,
} from './lib/desktopApi.js';
import { beginLoopbackOAuth, waitForLoopbackOAuth } from './lib/oauth.js';

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
let approvalPollTimer = null;
let approvalWaitState = null;
let enrollmentPopupOpen = false;
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
    const normalizeStored = (value) => {
        if (!value) return null;
        const trimmed = value.trim();
        if (!trimmed || trimmed === 'null' || trimmed === 'undefined') {
            return null;
        }
        return trimmed;
    };

    config = {
        apiKey: normalizeStored(localStorage.getItem('dropzone_key')),
        accessToken: normalizeStored(localStorage.getItem('dropzone_access_token')),
        serverUrl: normalizeStored(localStorage.getItem('dropzone_url')),
        ownerName: normalizeStored(localStorage.getItem('dropzone_owner')),
        duration: localStorage.getItem('dropzone_duration') || '7d',
    };
}
let config = {};
loadConfig();

function clearStoredOAuthState() {
    localStorage.removeItem('dropzone_access_token');
    localStorage.removeItem('dropzone_owner');
}

function isRecoverableOAuthBootstrapError(err) {
    const message = String(err?.message || '').toLowerCase();
    return message.includes('missing authentication credentials')
    || message.includes('mismatch')
        || message.includes('missing bearer token')
        || message.includes('invalid bearer token')
        || message.includes('invalid_bearer_token')
        || message.includes('auth required')
    || message.includes('missing_auth')
    || message.includes('approver device is not trusted')
    || message.includes('device_not_trusted')
        || message.includes('load failed')
        || message.includes('failed to fetch')
        || message.includes('networkerror');
}

function isConnectivityOAuthError(err) {
    const message = String(err?.message || '').toLowerCase();
    return message.includes('load failed')
        || message.includes('failed to fetch')
        || message.includes('networkerror')
        || message.includes('cors');
}

function resetOAuthToOnboarding(message) {
    stopApprovalPolling();
    disconnectDesktopSocket();
    disconnectEnrollmentSocket();
    clearStoredOAuthState();
    loadConfig();
    hideApprovalWaitScreen();
    showOnboarding();
    if (message) {
        showToast(message);
    }
}

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
            <button class="file-dl" title="Download">
                <svg viewBox="0 0 24 24"><path d="M12 3v11M12 14l-4-4M12 14l4-4M4 20h16"/></svg>
            </button>`;

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
        const trimmed = existing.trim();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
            return trimmed;
        }
    }

    const generated = (() => {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }

        const bytes = new Uint8Array(16);
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            crypto.getRandomValues(bytes);
        } else {
            for (let index = 0; index < bytes.length; index += 1) {
                bytes[index] = Math.floor(Math.random() * 256);
            }
        }

        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    })();
    localStorage.setItem('dropzone_device_id', generated);
    return generated;
}

async function getOrCreateDeviceIdentity() {
    const storageKey = 'dropzone_device_identity_v1';
    const cached = localStorage.getItem(storageKey);
    if (cached) {
        try {
            const parsed = JSON.parse(cached);
            if (parsed?.deviceId && parsed?.publicKeyJWK && parsed?.privateKeyJWK) {
                return parsed;
            }
        } catch (_) {
        }
    }

    const keyPair = await crypto.subtle.generateKey(
        {
            name: 'RSA-OAEP',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
        },
        true,
        ['encrypt', 'decrypt']
    );

    const publicKeyJWK = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const privateKeyJWK = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const identity = {
        deviceId: getOrCreateApproverDeviceId(),
        keyAlgorithm: 'RSA-OAEP-2048',
        keyVersion: 1,
        publicKeyJWK,
        privateKeyJWK,
    };

    localStorage.setItem(storageKey, JSON.stringify(identity));
    return identity;
}

function setEnrollmentResult(message, isError = false) {
    const result = document.getElementById('enroll-result');
    if (!result) return;
    result.textContent = message;
    result.classList.remove('hidden');
    result.style.color = isError ? '#b84f4f' : '';
}

function setPopupEnrollmentResult(message, isError = false) {
    const result = document.getElementById('popup-enroll-result');
    if (!result) return;
    result.textContent = message;
    result.classList.remove('hidden');
    result.style.color = isError ? '#b84f4f' : '';
}

function defaultWrapMetaValue() {
    return '{"version":1}';
}

async function getDeviceRegistrationPayload(deviceID) {
    const identity = await getOrCreateDeviceIdentity();
    return {
        device_id: deviceID,
        device_label: 'Dropzone Desktop',
        public_key_jwk: identity.publicKeyJWK,
        key_algorithm: identity.keyAlgorithm,
        key_version: identity.keyVersion,
    };
}

async function registerOAuthDevice(deviceID) {
    const payload = await getDeviceRegistrationPayload(deviceID);
    return tauriInvoke('desktop_device_api', {
        request: {
            server_url: config.serverUrl,
            access_token: config.accessToken,
            method: 'POST',
            path: '/desktop/me/devices/register',
            body: payload,
        },
    });
}

async function ensureEnrollmentForDevice(deviceID) {
    const pendingPayload = await tauriInvoke('desktop_device_api', {
        request: {
            server_url: config.serverUrl,
            access_token: config.accessToken,
            method: 'GET',
            path: '/desktop/me/devices/enrollments/pending',
        },
    });

    const existing = Array.isArray(pendingPayload?.items)
        ? pendingPayload.items.find((item) => (item?.enrollment?.request_device_id || '') === deviceID)
        : null;

    if (existing?.enrollment) {
        return {
            enrollment_id: existing.enrollment.id,
            verification_code: existing.enrollment.verification_code,
            expires_at: existing.enrollment.expires_at,
        };
    }

    return tauriInvoke('desktop_device_api', {
        request: {
            server_url: config.serverUrl,
            access_token: config.accessToken,
            method: 'POST',
            path: '/desktop/me/devices/enrollments',
            body: { request_device_id: deviceID },
        },
    });
}

function setApprovalWaitStatus(message, isError = false) {
    const el = document.getElementById('approval-status');
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? '#b84f4f' : '';
}

function stopApprovalPolling() {
    if (approvalPollTimer) {
        clearInterval(approvalPollTimer);
        approvalPollTimer = null;
    }
}

function showApprovalWaitScreen(waitState) {
    approvalWaitState = waitState;
    onboardingScreen?.classList.add('hidden');
    mainScreen?.classList.add('hidden');
    document.getElementById('settings')?.classList.add('hidden');

    const screen = document.getElementById('approval-wait');
    const codeEl = document.getElementById('approval-code');
    const deviceEl = document.getElementById('approval-device-id');
    if (codeEl) codeEl.textContent = waitState.verificationCode || 'pending';
    if (deviceEl) deviceEl.textContent = waitState.deviceID;
    setApprovalWaitStatus('Waiting for approval from another trusted device...');
    screen?.classList.remove('hidden');
}

function hideApprovalWaitScreen() {
    approvalWaitState = null;
    document.getElementById('approval-wait')?.classList.add('hidden');
}

async function checkOAuthApprovalStatus() {
    if (!approvalWaitState || !config.accessToken) return false;

    try {
        const registration = await registerOAuthDevice(approvalWaitState.deviceID);
        if (!registration?.needs_enrollment) {
            stopApprovalPolling();
            hideApprovalWaitScreen();
            showToast('Device approved. Uploads are now enabled.');
            showMain();
            return true;
        }

        setApprovalWaitStatus('Still pending approval...');
        return false;
    } catch (err) {
        if (isRecoverableOAuthBootstrapError(err)) {
            resetOAuthToOnboarding('OAuth session expired or is invalid. Please sign in again.');
            return false;
        }
        setApprovalWaitStatus(err?.message || 'Approval check failed', true);
        return false;
    }
}

function startApprovalPolling() {
    stopApprovalPolling();
    approvalPollTimer = setInterval(() => {
        checkOAuthApprovalStatus();
    }, 4000);
}

async function ensureOAuthDeviceReady() {
    const deviceID = getOrCreateApproverDeviceId();
    let registration;
    try {
        registration = await registerOAuthDevice(deviceID);
    } catch (err) {
        if (isRecoverableOAuthBootstrapError(err)) {
            clearStoredOAuthState();
            loadConfig();
            hideApprovalWaitScreen();
            showOnboarding();
            return false;
        }
        showApprovalWaitScreen({
            deviceID,
            enrollmentID: '',
            verificationCode: 'pending',
        });
        setApprovalWaitStatus(err?.message || 'Waiting for server/device approval endpoint.', true);
        startApprovalPolling();
        return false;
    }

    if (!registration?.needs_enrollment) {
        stopApprovalPolling();
        hideApprovalWaitScreen();
        return true;
    }

    let enrollment;
    try {
        enrollment = await ensureEnrollmentForDevice(deviceID);
    } catch (err) {
        if (isRecoverableOAuthBootstrapError(err)) {
            clearStoredOAuthState();
            loadConfig();
            hideApprovalWaitScreen();
            showOnboarding();
            return false;
        }
        showApprovalWaitScreen({
            deviceID,
            enrollmentID: '',
            verificationCode: 'pending',
        });
        setApprovalWaitStatus(err?.message || 'Could not create enrollment yet.', true);
        startApprovalPolling();
        return false;
    }

    showApprovalWaitScreen({
        deviceID,
        enrollmentID: enrollment.enrollment_id,
        verificationCode: enrollment.verification_code,
    });
    startApprovalPolling();
    return false;
}

function readEnrollmentApprovalInputs(prefix) {
    const approverInput = document.getElementById(`${prefix}-approver-device-id`);
    const wrappedUkInput = document.getElementById(`${prefix}-wrapped-uk`);
    const wrapAlgInput = document.getElementById(`${prefix}-uk-wrap-alg`);
    const wrapMetaInput = document.getElementById(`${prefix}-uk-wrap-meta`);

    const approverDeviceID = (approverInput?.value || '').trim();
    const wrappedUserKeyB64 = (wrappedUkInput?.value || '').trim();
    const ukWrapAlg = (wrapAlgInput?.value || '').trim();
    const ukWrapMetaRaw = (wrapMetaInput?.value || '').trim();

    if (!approverDeviceID) return { error: 'Approver device ID is required.' };
    if (!wrappedUserKeyB64) return { error: 'Wrapped user key is required.' };
    if (!ukWrapAlg) return { error: 'Wrap algorithm is required.' };

    let ukWrapMeta = {};
    if (ukWrapMetaRaw) {
        try {
            ukWrapMeta = JSON.parse(ukWrapMetaRaw);
        } catch (_) {
            return { error: 'Wrap metadata must be valid JSON.' };
        }
    }

    return {
        approverDeviceID,
        wrappedUserKeyB64,
        ukWrapAlg,
        ukWrapMeta,
    };
}

function renderEnrollmentPopup() {
    const popup = document.getElementById('enrollment-popup');
    const list = document.getElementById('popup-enroll-pending-list');
    if (!popup || !list) return;

    const currentDevice = getOrCreateApproverDeviceId();
    const popupItems = pendingEnrollmentsCache.filter((item) => {
        const deviceID = item?.enrollment?.request_device_id || '';
        return deviceID && deviceID !== currentDevice;
    });

    if (!popupItems.length || !config.accessToken) {
        popup.classList.add('hidden');
        enrollmentPopupOpen = false;
        return;
    }

    list.innerHTML = '';

    popupItems.forEach((item) => {
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
            if (!enrollmentId) {
                setPopupEnrollmentResult('Enrollment ID is missing.', true);
                return;
            }
            const input = readEnrollmentApprovalInputs('popup-enroll');
            if (input.error) {
                setPopupEnrollmentResult(input.error, true);
                return;
            }

            try {
                await tauriInvoke('desktop_device_api', {
                    request: {
                        server_url: config.serverUrl,
                        access_token: config.accessToken,
                        method: 'POST',
                        path: `/desktop/me/devices/enrollments/${encodeURIComponent(enrollmentId)}/approve`,
                        body: {
                            approver_device_id: input.approverDeviceID,
                            verification_code: verificationCode,
                            wrapped_user_key_b64: input.wrappedUserKeyB64,
                            uk_wrap_alg: input.ukWrapAlg,
                            uk_wrap_meta: input.ukWrapMeta,
                        },
                    },
                });
                setPopupEnrollmentResult('Enrollment approved.');
                await refreshPendingEnrollments();
            } catch (err) {
                console.error('Approve enrollment failed:', err);
                setPopupEnrollmentResult('Failed to approve enrollment.', true);
            }
        });

        row.querySelector('.enroll-action-reject')?.addEventListener('click', async () => {
            if (!enrollmentId) {
                setPopupEnrollmentResult('Enrollment ID is missing.', true);
                return;
            }
            const input = readEnrollmentApprovalInputs('popup-enroll');
            if (input.error) {
                setPopupEnrollmentResult(input.error, true);
                return;
            }

            try {
                await tauriInvoke('desktop_device_api', {
                    request: {
                        server_url: config.serverUrl,
                        access_token: config.accessToken,
                        method: 'POST',
                        path: `/desktop/me/devices/enrollments/${encodeURIComponent(enrollmentId)}/reject`,
                        body: {
                            approver_device_id: input.approverDeviceID,
                        },
                    },
                });
                setPopupEnrollmentResult('Enrollment rejected.');
                await refreshPendingEnrollments();
            } catch (err) {
                console.error('Reject enrollment failed:', err);
                setPopupEnrollmentResult('Failed to reject enrollment.', true);
            }
        });

        list.appendChild(row);
    });

    popup.classList.remove('hidden');
    enrollmentPopupOpen = true;
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
                await tauriInvoke('desktop_device_api', {
                    request: {
                        server_url: config.serverUrl,
                        access_token: config.accessToken,
                        method: 'POST',
                        path: `/desktop/me/devices/enrollments/${encodeURIComponent(enrollmentId)}/approve`,
                        body: {
                            approver_device_id: approverDeviceID,
                            verification_code: verificationCode,
                            wrapped_user_key_b64: wrappedUserKeyB64,
                            uk_wrap_alg: ukWrapAlg,
                            uk_wrap_meta: ukWrapMeta,
                        },
                    },
                });
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
                await tauriInvoke('desktop_device_api', {
                    request: {
                        server_url: config.serverUrl,
                        access_token: config.accessToken,
                        method: 'POST',
                        path: `/desktop/me/devices/enrollments/${encodeURIComponent(enrollmentId)}/reject`,
                        body: {
                            approver_device_id: approverDeviceID,
                        },
                    },
                });
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
        const payload = await tauriInvoke('desktop_device_api', {
            request: {
                server_url: config.serverUrl,
                access_token: config.accessToken,
                method: 'GET',
                path: '/desktop/me/devices/enrollments/pending',
            },
        });
        pendingEnrollmentsCache = Array.isArray(payload?.items) ? payload.items : [];
        renderPendingEnrollments();
        renderEnrollmentPopup();
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
    const approvalRefreshBtn = document.getElementById('btn-approval-refresh');
    const approvalSignoutBtn = document.getElementById('btn-approval-signout');
    const popupCloseBtn = document.getElementById('popup-enroll-close');
    const popupRefreshBtn = document.getElementById('popup-enroll-refresh');

    approvalRefreshBtn?.addEventListener('click', () => checkOAuthApprovalStatus());
    approvalSignoutBtn?.addEventListener('click', () => {
        stopApprovalPolling();
        disconnectDesktopSocket();
        disconnectEnrollmentSocket();
        localStorage.clear();
        window.location.reload();
    });

    popupCloseBtn?.addEventListener('click', () => {
        document.getElementById('enrollment-popup')?.classList.add('hidden');
        enrollmentPopupOpen = false;
    });

    popupRefreshBtn?.addEventListener('click', refreshPendingEnrollments);

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

            localStorage.setItem('dropzone_access_token', result.access_token);
            localStorage.removeItem('dropzone_key');
            localStorage.setItem('dropzone_url', url);
            localStorage.setItem('dropzone_owner', 'Authenticated User');

            config.accessToken = result.access_token;
            config.apiKey = null;
            config.serverUrl = url;
            config.ownerName = 'Authenticated User';

            const ready = await ensureOAuthDeviceReady();
            if (ready) {
                showMain();
            }
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

        stopApprovalPolling();
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

    if (config.accessToken && config.serverUrl) {
        try {
            const ready = await ensureOAuthDeviceReady();
            if (ready) {
                showMain();
            }
        } catch (err) {
            console.error('OAuth device readiness failed:', err);
            if (isRecoverableOAuthBootstrapError(err)) {
                clearStoredOAuthState();
                loadConfig();
            } else {
                await showModal({
                    title: 'OAuth setup failed',
                    message: err?.message || 'Could not initialize trusted device state for OAuth login.',
                });
            }
            showOnboarding();
        }
    } else if (config.apiKey && config.serverUrl) {
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
    hideApprovalWaitScreen();
    document.getElementById('enrollment-popup')?.classList.add('hidden');
    enrollmentPopupOpen = false;
    onboardingScreen.classList.remove('hidden');
    mainScreen.classList.add('hidden');
    document.getElementById('settings').classList.add('hidden');
}

function showMain() {
    if (!mainScreen) return;
    hideApprovalWaitScreen();
    onboardingScreen.classList.add('hidden');
    document.getElementById('settings').classList.add('hidden');
    mainScreen.classList.remove('hidden');
    loadConfig();

    
    renderPairingQRCodes();
    connectDesktopSocket();
    connectEnrollmentSocket();

    loadRecentFiles();
    if (config.accessToken) {
        refreshPendingEnrollments();
    }

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
        wrapMetaInput.value = defaultWrapMetaValue();
    }

    const popupApproverInput = document.getElementById('popup-enroll-approver-device-id');
    if (popupApproverInput && !popupApproverInput.value.trim()) {
        popupApproverInput.value = getOrCreateApproverDeviceId();
    }

    const popupWrapAlgInput = document.getElementById('popup-enroll-uk-wrap-alg');
    if (popupWrapAlgInput && !popupWrapAlgInput.value.trim()) {
        popupWrapAlgInput.value = 'x25519-xsalsa20-poly1305';
    }

    const popupWrapMetaInput = document.getElementById('popup-enroll-uk-wrap-meta');
    if (popupWrapMetaInput && !popupWrapMetaInput.value.trim()) {
        popupWrapMetaInput.value = defaultWrapMetaValue();
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

            const finalizePayload = { session_id, duration: config.duration };
            if (config.accessToken) {
                finalizePayload.device_id = getOrCreateApproverDeviceId();
            }
            const finalRes = await uploadFinalize(config, finalizePayload);
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