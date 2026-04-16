export const getTauriApi = () => {
    try {
        return window.__TAURI__;
    } catch (_) {
        return null;
    }
};

function asJson(data) {
    if (data == null) return null;
    if (typeof data === 'string') {
        return JSON.parse(data);
    }
    return data;
}

function asText(data) {
    if (data == null) return '';
    if (typeof data === 'string') return data;
    return JSON.stringify(data);
}

function asBlob(data) {
    if (data instanceof Blob) return data;
    if (data instanceof Uint8Array) return new Blob([data]);
    if (typeof data === 'string') {
        const encoder = new TextEncoder();
        return new Blob([encoder.encode(data)]);
    }
    return new Blob([JSON.stringify(data)]);
}

export async function httpRequest(url, options = {}) {
    const tauri = getTauriApi();
    const isMultipartFormData =
        typeof FormData !== 'undefined' && options?.body instanceof FormData;

    // Tauri HTTP plugin currently has unstable FormData blob handling in this app.
    // Use native fetch for multipart payloads to avoid InvalidStateError on chunks.
    if (tauri && !isMultipartFormData) {
        try {
            const pluginHttp = await import('@tauri-apps/plugin-http');
            const tauriFetch = pluginHttp?.fetch;
            if (typeof tauriFetch !== 'function') {
                throw new Error('Tauri HTTP plugin fetch API unavailable');
            }

            const response = await tauriFetch(url, {
                method: options.method || 'GET',
                headers: options.headers || {},
                body: options.body,
            });

            return {
                ok: response.ok ?? (response.status >= 200 && response.status < 300),
                status: response.status,
                headers: response.headers || {},
                async json() {
                    if (typeof response.json === 'function') {
                        return response.json();
                    }
                    return asJson(response.data);
                },
                async text() {
                    if (typeof response.text === 'function') {
                        return response.text();
                    }
                    return asText(response.data);
                },
                async blob() {
                    if (typeof response.blob === 'function') {
                        return response.blob();
                    }
                    return asBlob(response.data);
                },
            };
        } catch (error) {
            console.warn('Tauri HTTP plugin failed, falling back to fetch:', error);
        }
    }

    try {
        return await fetch(url, options);
    } catch (error) {
        const message = String(error?.message || '').toLowerCase();
        if (message.includes('load failed') || message.includes('failed to fetch') || message.includes('networkerror')) {
            throw new Error('Network/CORS request failed while contacting server');
        }
        throw error;
    }
}
