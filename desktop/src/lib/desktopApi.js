import { httpRequest } from './http.js';

function authHeaders(config, extra = {}) {
    if (config.accessToken) {
        return {
            Authorization: `Bearer ${config.accessToken}`,
            ...extra,
        };
    }

    return {
        'X-API-KEY': config.apiKey,
        ...extra,
    };
}

export function verifyDesktopKey(url, key) {
    return httpRequest(`${url}/desktop/auth/verify?key=${encodeURIComponent(key)}`, {
        method: 'GET',
    });
}

export function fetchOAuthConfig(url) {
    return httpRequest(`${url}/desktop/auth/oauth/config`, {
        method: 'GET',
    });
}

export function verifyOAuthToken(url, token) {
    return httpRequest(`${url}/desktop/auth/oauth/verify`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });
}

export function listDesktopFiles(config) {
    return httpRequest(`${config.serverUrl}/desktop/files`, {
        headers: authHeaders(config),
    });
}

export function listRecentUploads(config, { page = 1, perPage = 50, query = '' } = {}) {
    const params = new URLSearchParams({
        page: String(page),
        per_page: String(perPage),
    });
    if (query) {
        params.set('q', query);
    }
    return httpRequest(`${config.serverUrl}/desktop/me/recent-uploads?${params.toString()}`, {
        headers: authHeaders(config),
    });
}

export function lookupFileByCode(config, code) {
    return httpRequest(`${config.serverUrl}/desktop/file/code/${encodeURIComponent(code)}`, {
        headers: authHeaders(config),
    });
}

export function reportFile(config, fileId) {
    return httpRequest(`${config.serverUrl}/desktop/file/${encodeURIComponent(fileId)}/report`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ file_id: fileId }),
    });
}

export function getFileAccess(config, fileId, deviceId) {
    return httpRequest(`${config.serverUrl}/desktop/me/files/${encodeURIComponent(fileId)}/access?device_id=${encodeURIComponent(deviceId)}`, {
        headers: authHeaders(config),
    });
}

export function registerDevice(config, payload) {
    return httpRequest(`${config.serverUrl}/desktop/me/devices/register`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
}

export function recoverDevice(config, payload) {
    return httpRequest(`${config.serverUrl}/desktop/me/devices/recover`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
}

export function createEnrollment(config, payload) {
    return httpRequest(`${config.serverUrl}/desktop/me/devices/enrollments`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
}

export function listPendingEnrollments(config) {
    return httpRequest(`${config.serverUrl}/desktop/me/devices/enrollments/pending`, {
        headers: authHeaders(config),
    });
}

export function approveEnrollment(config, enrollmentId, payload) {
    return httpRequest(`${config.serverUrl}/desktop/me/devices/enrollments/${encodeURIComponent(enrollmentId)}/approve`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
}

export function rejectEnrollment(config, enrollmentId, payload) {
    return httpRequest(`${config.serverUrl}/desktop/me/devices/enrollments/${encodeURIComponent(enrollmentId)}/reject`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
}

export function downloadDesktopFile(config, fileId) {
    return httpRequest(`${config.serverUrl}/desktop/files/${encodeURIComponent(fileId)}/download`, {
        headers: authHeaders(config),
    });
}

export function uploadInit(config, body) {
    return httpRequest(`${config.serverUrl}/desktop/upload/init`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
    });
}

export function uploadChunk(config, formData) {
    return httpRequest(`${config.serverUrl}/desktop/upload/chunk`, {
        method: 'POST',
        headers: authHeaders(config),
        body: formData,
    });
}

export function uploadComplete(config, sessionId) {
    return httpRequest(`${config.serverUrl}/desktop/upload/complete`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ session_id: sessionId, confirmed: true }),
    });
}

export function uploadFinalize(config, payload) {
    return httpRequest(`${config.serverUrl}/desktop/upload/finalize`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
}

export function uploadStatus(config, sessionId) {
    return httpRequest(`${config.serverUrl}/desktop/upload/status/${encodeURIComponent(sessionId)}`, {
        headers: authHeaders(config),
    });
}

export function cancelUpload(config, sessionId) {
    return httpRequest(`${config.serverUrl}/desktop/upload/cancel`, {
        method: 'DELETE',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ session_id: sessionId }),
    });
}
