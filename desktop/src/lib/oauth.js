import { verifyOAuthToken } from './desktopApi.js';

const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 260000;

async function openExternal(url) {
    const shell = await import('@tauri-apps/plugin-shell');
    await shell.open(url);
}

export async function beginLoopbackOAuth(serverUrl, tauriInvoke) {
    if (!serverUrl) {
        throw new Error('Server URL is required');
    }

    const start = await tauriInvoke('start_oauth_loopback', {
        serverUrl,
    });

    if (!start?.session_id || !start?.auth_url) {
        throw new Error('OAuth bootstrap failed');
    }

    await openExternal(start.auth_url);
    return start.session_id;
}

export async function waitForLoopbackOAuth(tauriInvoke, sessionId, timeoutMs = POLL_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const state = await tauriInvoke('poll_oauth_loopback', { sessionId });
        if (!state || !state.status) {
            throw new Error('OAuth session returned invalid response');
        }

        if (state.status === 'completed') {
            if (!state.access_token) {
                throw new Error('OAuth completed without access token');
            }
            return state;
        }

        if (state.status === 'failed') {
            throw new Error(state.error || 'OAuth failed');
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error('OAuth login timed out');
}

export async function verifyLoopbackToken(serverUrl, token) {
    const response = await verifyOAuthToken(serverUrl, token);
    if (!response.ok) {
        const message = await response.text().catch(() => 'Bearer token rejected by server');
        throw new Error(message || 'Bearer token rejected by server');
    }
    return response.json();
}
