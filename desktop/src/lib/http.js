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

    if (tauri && tauri.http) {
        try {
            const response = await tauri.http.fetch(url, {
                method: options.method || 'GET',
                headers: options.headers || {},
                body: options.body,
            });

            return {
                ok: response.status >= 200 && response.status < 300,
                status: response.status,
                headers: response.headers || {},
                data: response.data,
                async json() {
                    return asJson(response.data);
                },
                async text() {
                    return asText(response.data);
                },
                async blob() {
                    return asBlob(response.data);
                },
            };
        } catch (error) {
            console.warn('Tauri HTTP failed, falling back to fetch:', error);
        }
    }

    return fetch(url, options);
}
