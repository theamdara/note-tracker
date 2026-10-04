# Note Tracker

A self-contained, offline note-taking and tracking app with LAN multi-device sync.
One server file + one HTML file, zero external dependencies (Node.js built-ins only).

## Features

- **Note Tracking** — dated records (e.g. daily log) with optional image, voice, video, or file attachments. Search by text or date.
- **Note Taking** — quick undated notes with auto timestamp and tag support (built-in tags: `maps`, `eating`, `personal use`, `info`, `item price`, `biz`, `project` + custom tags). Filter by tag, search by text.
- **Edit & Delete** — every note can be edited in place (text, date, tags, and attachments: keep / remove / replace) or deleted.
- **LAN Sync (hub ↔ client)** — consolidate notes across multiple devices on the same network. Notes are matched by content hash, so identical notes are never duplicated and different notes are all kept.

## Requirements

- **Node.js 22+** (uses the built-in `node:sqlite` module; no `npm install` needed)

## Quick start

```bash
node server.js            # default port 3001
# or
node server.js 3000       # custom port
PORT=8080 node server.js  # via env var

node -r ./patch-os.js server.js  # on userland android
```

Open the printed URL (e.g. `http://127.0.0.1:3001`). Data is stored in `notes.db` (SQLite, WAL mode) next to `server.js`; attachments are saved to `uploads/`.

Environment variables:

| Var    | Default | Meaning                                    |
|--------|---------|--------------------------------------------|
| `PORT` | `3001`  | Listen port (CLI arg takes precedence)     |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` to restrict to localhost) |

## Using LAN sync (multiple devices)

One device acts as the **hub**; every other device is a **client**.

1. On the hub machine, open the app → **Sync** tab → set role to *Hub*. The panel shows the address other devices should use (e.g. `http://192.168.1.56:3001`).
2. On each client machine, run its own copy of this app (`node server.js`), open it in a browser, go to **Sync** → role *Client* → enter the hub address shown in step 1.
3. At any time:
   - **Push my notes → hub** — uploads your attachments to the hub and merges your records into it.
   - **Pull hub → my notes** — downloads new attachments and merges the consolidated set back onto this device.

Notes are matched by a canonical content identity (text fields + SHA-1 content hashes of attachments, not filenames), so:

- the same note on two devices is never duplicated,
- the same image stored under different filenames on different devices still matches,
- editing/adding on any device and pushing/pulling keeps all copies consistent.

The hub address and role are remembered per browser (localStorage).

## API reference

All endpoints are JSON unless noted. Base: `http://<host>:<port>`.

### Tracking notes (dated records)

| Method & path          | Description |
|------------------------|-------------|
| `GET /api/notes`       | List all tracking notes |
| `POST /api/notes`      | Create one. JSON `{date, note}` or multipart with fields `date`, `note` and optional files `image`, `voice`, `video`, `file` (or `<key>_url` to reference an already-stored file) |
| `PATCH /api/notes/:id` | Update one. Same body as POST; for each attachment slot you may instead send `<key>_slot` = `keep` (unchanged), empty string (remove), or a filename (reference). Orphaned files are deleted only when no other note references them |
| `DELETE /api/notes/:id`| Delete one (removes its attachment files if unreferenced) |

### Taking notes (undated, tagged)

| Method & path            | Description |
|--------------------------|-------------|
| `GET /api/taking`        | List all taking notes with tags |
| `POST /api/taking`       | Create one. JSON `{note, tags[]}` or multipart with `note`, `tags` (comma-separated) and optional files `image`, `voice`, `video`, `file` |
| `PATCH /api/taking/:id`  | Update one. Same semantics as the tracking PATCH; omit `tags` to keep current tags |
| `DELETE /api/taking/:id` | Delete one |

### Tags

| Method & path               | Description |
|-----------------------------|-------------|
| `GET /api/tags`             | List all tag names |
| `DELETE /api/tags?name=…`   | Remove a tag from the list (notes keep their text; links cascade) |

### Sync

| Method & path            | Description |
|--------------------------|-------------|
| `POST /api/sync/upload`  | Store one attachment on this server. Body `{data: <base64>, name}` → `{name, hash}` (SHA-1 of content) |
| `GET /api/sync/pull`     | This device's consolidated records with attachment filenames + content hashes and all tags |
| `POST /api/sync/apply`   | Merge a batch into this device, deduped by content identity. Body `{tracking[], taking[], tags[]}` → counts added |
| `POST /api/sync/push`    | Same as apply (alias used when pushing to the hub) |
| `POST /api/sync/fetch`   | Download one attachment from a remote URL into this server's `uploads/`. Body `{url}` → `{name}` |

CORS is enabled for all origins so client browsers on other LAN devices can call the hub API and load its uploads.

## Project layout

```
server.js    HTTP server + SQLite storage + sync logic (single file, no deps)
index.html   Single-page UI (vanilla JS, no build step)
notes.db     SQLite database (created on first run; WAL sidecar files alongside)
uploads/     Attachment files (images, audio, video, documents)
```

## Notes & limits

- Max attachment size: 10 MB per file.
- Deleting a note removes its attachment files only if no other note still uses them.
- Sync is best-effort over LAN HTTP; both sides should Push then Pull to converge.
- The database and uploads live on disk next to `server.js` — back up that folder to back up your data.
