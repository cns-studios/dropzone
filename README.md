# dropzone


## Structure

```
dropzone/
├── desktop/          # Tauri v2 (Rust) — system tray, drop window, share UI
├── android/          # Kotlin — background listener, download handler
├── backend/          # Go — REST API, file storage, push relay, share links
├── cli/              # Admin CLI — user/API key management
└── docs/             # Architecture notes, API spec
```

---

## How It Works

1. **Desktop** idles in the system tray. A global hotkey opens the drop window.
2. User drops files. Desktop uploads them to the backend authenticated via API key.
3. **Backend** stores the files and fires a push notification to the paired Android device.
4. **Android** receives the notification: *"3 files shared — Download / Ignore"*. Tap download, files are saved locally.
5. Back on desktop, user optionally selects files from the upload batch, generates a share link (token-based bundle), and copies it to clipboard. Anyone with the link can download.

---

## Components

### `desktop/` — Tauri v2 / Rust

- System tray with idle icon
- Global hotkey registration (X11 + Wayland/Hyprland via config injection)
- Drag-and-drop file zone
- Upload progress UI
- Post-upload share link builder
- API key stored via OS keychain (`keyring` crate)
- Targets: Linux, Windows

### `android/` — Kotlin

- Persistent notification listener (FCM or WebSocket foreground service)
- Actionable push: Download / Ignore
- File download + storage (scoped storage, `MediaStore`)
- API key stored in `EncryptedSharedPreferences`
- Targets: Android 10+

### `backend/` — Go

- REST API (see [API](#api))
- API key auth (header: `X-Api-Key`)
- File storage (local disk, configurable path)
- Push relay to Android (FCM or SSE)
- Share link generation (token → file bundle → public download)
- SQLite for metadata (uploads, links, users)
- Runs in Docker, managed via Coolify

### `cli/` — Go (or shell)

- `dropzone-admin user create <name>` — creates user, prints API key
- `dropzone-admin user list`
- `dropzone-admin user revoke <id>`
- `dropzone-admin link list`
- `dropzone-admin link revoke <token>`

---

## API

> All authenticated endpoints require `X-Api-Key: <key>` header.

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Liveness check |

### Upload

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/upload` | ✅ | Upload one or more files (multipart). Returns upload ID + file list. |
| `GET` | `/uploads` | ✅ | List past uploads for this user |
| `DELETE` | `/uploads/:upload_id` | ✅ | Delete an upload and its files |

### Share Links

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/links` | ✅ | Create share link from subset of an upload's files. Returns token + URL. |
| `GET` | `/links` | ✅ | List active share links for this user |
| `DELETE` | `/links/:token` | ✅ | Revoke a share link |
| `GET` | `/s/:token` | — | Public: list files in share bundle |
| `GET` | `/s/:token/:filename` | — | Public: download a specific file |

### Push (Android registration)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/device` | ✅ | Register or update Android push token |
| `DELETE` | `/device` | ✅ | Unregister device |

---

## Data Model (SQLite)

```sql
users        (id, name, api_key_hash, created_at)
uploads      (id, user_id, created_at)
files        (id, upload_id, filename, size, path, created_at)
share_links  (id, user_id, token, created_at, expires_at?)
link_files   (link_id, file_id)
devices      (user_id, push_token, updated_at)
```

---

## Auth Model

Each user has exactly one API key. The key is set server-side via the admin CLI — never generated client-side.

```
dropzone-admin user create aaron
# API Key: dz_xxxxxxxxxxxxxxxxxxxxxxxx
```

The key is hashed (SHA-256 or Argon2id) at rest. Clients send it in plaintext over HTTPS. One key covers both the desktop and Android client for that user — they share the same identity.

> Future: per-device keys, key rotation, expiry.

---

## Push Notifications

Two supported modes, configured in `backend/config.yaml`:

**FCM (default)** — requires a Firebase project. Backend sends to the registered FCM token on upload. Reliable Android delivery.

**SSE (self-hosted)** — Android client holds a persistent SSE connection. Requires a foreground service. No Google dependency.

---

## Share Links

Share links are token-based (`/s/<token>`). A link bundles one or more files from a single upload. Anyone with the link can list and download the bundled files — no auth required.

Optional TTL configurable per-link at creation time.

```json
POST /links
{
  "upload_id": "abc123",
  "file_ids": ["f1", "f2"],
  "expires_in": 86400
}
```

Returns:
```json
{
  "token": "xyz789",
  "url": "https://drop.yourdomain.com/s/xyz789",
  "expires_at": "2025-04-01T12:00:00Z"
}
```

---

## Deployment

Backend runs as a Docker container. Intended for Coolify + Traefik + Cloudflare Tunnel.

```yaml
# docker-compose.yml (backend)
services:
  dropzone:
    build: ./backend
    environment:
      - STORAGE_PATH=/data/files
      - DB_PATH=/data/dropzone.db
      - FCM_SERVICE_ACCOUNT=/run/secrets/fcm.json
    volumes:
      - dropzone_data:/data
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.dropzone.rule=Host(`drop.cns-studios.com`)"
```

---

## Config

`backend/config.yaml`:

```yaml
storage:
  path: /data/files

db:
  path: /data/dropzone.db

push:
  mode: fcm                        # fcm | sse
  fcm_service_account: /run/secrets/fcm.json

share:
  base_url: https://drop.cns-studios.com
  default_ttl: 0                   # 0 = no expiry
```

---

## Development

### Backend

```bash
cd backend
go run ./cmd/server
```

### Desktop

```bash
cd desktop
cargo tauri dev
```

### Android

Open `android/` in Android Studio. Set `BASE_URL` and `API_KEY` in `local.properties` or the debug config.

### Admin CLI

```bash
cd cli
go run ./cmd/admin user create aaron
```

---

## Roadmap

- [ ] Chunked / resumable uploads for large files
- [ ] Per-device API keys + key rotation
- [ ] Desktop: upload history window
- [ ] Android: in-app file browser
- [ ] Share link password protection
- [ ] Web UI (optional) for link management