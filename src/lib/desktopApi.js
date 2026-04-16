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

function getResponseHeader(response, name) {
    const headers = response?.headers;
    if (!headers) return '';
    if (typeof headers.get === 'function') {
        return headers.get(name) || headers.get(name.toLowerCase()) || '';
    }
    return headers[name] || headers[name.toLowerCase()] || '';
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
    const encodedFileId = encodeURIComponent(fileId);
    const desktopUrl = `${config.serverUrl}/desktop/files/${encodedFileId}/download`;
    const apiUrl = `${config.serverUrl}/api/file/${encodedFileId}/download`;

    return httpRequest(desktopUrl, {
        headers: authHeaders(config),
    }).then((response) => {
        const contentType = String(getResponseHeader(response, 'content-type') || '').toLowerCase();
        const looksLikeHtml = contentType.includes('text/html');

        if (response.ok && !looksLikeHtml) {
            return response;
        }

        const status = Number(response.status || 0);
        if (looksLikeHtml || status === 404 || status === 405 || status === 501) {
            return httpRequest(apiUrl, {
                headers: authHeaders(config),
            });
        }

        return response;
    }).catch(() => {
        return httpRequest(apiUrl, {
            headers: authHeaders(config),
        });
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

export function startTunnel(config, payload) {
    return httpRequest(`${config.serverUrl}/desktop/me/tunnels/start`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
}

export function joinTunnel(config, payload) {
    return httpRequest(`${config.serverUrl}/desktop/me/tunnels/join`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
}

export function getTunnel(config, tunnelId) {
    return httpRequest(`${config.serverUrl}/desktop/me/tunnels/${encodeURIComponent(tunnelId)}`, {
        headers: authHeaders(config),
    });
}

export function listTunnelFiles(config, tunnelId) {
    return httpRequest(`${config.serverUrl}/desktop/me/tunnels/${encodeURIComponent(tunnelId)}/files`, {
        headers: authHeaders(config),
    });
}

export function confirmTunnel(config, tunnelId, payload = {}) {
    return httpRequest(`${config.serverUrl}/desktop/me/tunnels/${encodeURIComponent(tunnelId)}/confirm`, {
        method: 'POST',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
}

export function endTunnel(config, tunnelId, payload = {}) {
    return httpRequest(`${config.serverUrl}/desktop/me/tunnels/${encodeURIComponent(tunnelId)}`, {
        method: 'DELETE',
        headers: authHeaders(config, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
}
