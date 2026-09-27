#!/usr/bin/env node
/**
 * Note-taking & tracking server (offline, self-contained).
 *
 * - Stores records in a local SQLite database (notes.db) via node:sqlite.
 * - Serves the single-file web UI (index.html) and a small JSON API over HTTP.
 * - No external dependencies: uses only Node built-ins (http, fs, path, crypto, sqlite).
 *
 * Usage:  node server.js [port]     (default port 3000)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.argv[2] || process.env.PORT || 3001);
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'notes.db');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;

  -- Feature 1: Note TRACKING (dated records)
  CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,            -- YYYY-MM-DD (user-entered, defaults to today)
    note        TEXT    NOT NULL DEFAULT '', -- free text
    image_name  TEXT,                        -- filename in uploads/ (NULL if none)
    voice_name  TEXT,                        -- audio attachment (NULL if none)
    video_name  TEXT,                        -- video attachment (NULL if none)
    file_name   TEXT,                        -- general file attachment (NULL if none)
    created_at  TEXT    NOT NULL             -- ISO timestamp of insertion
  );

  -- Feature 2: Note TAKING (undated; auto timestamp + tags)
  CREATE TABLE IF NOT EXISTS taking_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note        TEXT    NOT NULL DEFAULT '', -- free text
    image_name  TEXT,                        -- filename in uploads/ (NULL if none)
    voice_name  TEXT,                        -- audio attachment (NULL if none)
    video_name  TEXT,                        -- video attachment (NULL if none)
    file_name   TEXT,                        -- general file attachment (NULL if none)
    created_at  TEXT    NOT NULL             -- ISO timestamp of insertion (auto)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE               -- e.g. 'maps', 'eating', ...
  );

  CREATE TABLE IF NOT EXISTS notes_tags (
    note_id INTEGER NOT NULL,
    tag_id  INTEGER NOT NULL,
    PRIMARY KEY (note_id, tag_id),
    FOREIGN KEY (note_id) REFERENCES taking_notes(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id)  REFERENCES tags(id)        ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_notes_tags_tag ON notes_tags(tag_id);
`);

// Seed the default tag set for note-taking.
const DEFAULT_TAGS = ['maps', 'eating', 'personal use', 'info', 'item price', 'biz', 'project'];
{
  const existing = db.prepare('SELECT COUNT(*) AS c FROM tags').get().c;
  if (existing === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
    for (const t of DEFAULT_TAGS) ins.run(t);
  }
}

const stmts = {
  // Tracking notes
  insert: db.prepare(
    'INSERT INTO notes (date, note, image_name, voice_name, video_name, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  list: db.prepare('SELECT * FROM notes ORDER BY date DESC, id DESC'),
  get: db.prepare('SELECT * FROM notes WHERE id = ?'),
  remove: db.prepare('DELETE FROM notes WHERE id = ?'),

  // Taking notes
  t_insert: db.prepare(
    'INSERT INTO taking_notes (note, image_name, voice_name, video_name, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  t_list: db.prepare('SELECT * FROM taking_notes ORDER BY created_at DESC, id DESC'),
  t_get: db.prepare('SELECT * FROM taking_notes WHERE id = ?'),
  t_remove: db.prepare('DELETE FROM taking_notes WHERE id = ?'),

  // Tags
  tag_all: db.prepare('SELECT name FROM tags ORDER BY name'),
  tag_get: db.prepare('SELECT * FROM tags WHERE name = ?'),
  tag_remove: db.prepare('DELETE FROM tags WHERE id = ?'),
  tag_get_or_create: db.prepare(
    'INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id, name'
  ),
  tag_set_note: db.prepare('DELETE FROM notes_tags WHERE note_id = ?'),
  tag_link: db.prepare('INSERT OR IGNORE INTO notes_tags (note_id, tag_id) VALUES (?, ?)'),
  tags_for_note: db.prepare(
    'SELECT t.name FROM tags t JOIN notes_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ? ORDER BY t.name'
  ),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Extract ALL file parts (any type) from a multipart/form-data body.
// Returns an array of { field, name, ext, mime, buffer }.
function parseMultipartFiles(body) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(
    req_global.content_type || ''
  );
  let boundary = null;
  if (boundaryMatch) boundary = boundaryMatch[1] || boundaryMatch[2];
  if (!boundary) return [];

  const delim = Buffer.from('--' + boundary);
  const parts = [];
  let start = body.indexOf(delim);
  while (start !== -1) {
    const nextStart = body.indexOf(delim, start + delim.length);
    if (nextStart === -1) break;
    parts.push(body.subarray(start + delim.length, nextStart));
    start = nextStart;
  }

  const out = [];
  for (const part of parts) {
    // Part layout: headers \r\n\r\n content \r\n
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.subarray(0, headerEnd).toString('utf8');
    let content = part.subarray(headerEnd + 4);
    if (content.slice(-2).toString() === '\r\n') content = content.subarray(0, -2);

    // Accept any file part that carries a filename.
    const nameMatch = /filename="([^"]*)"/i.exec(headers);
    if (!nameMatch) continue;
    const fieldMatch = /name="([^"]*)"/i.exec(headers);
    const mimeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
    const mime = mimeMatch ? mimeMatch[1].trim().toLowerCase() : 'application/octet-stream';
    const filename = path.basename(nameMatch[1]);
    const extMatch = /\.([a-zA-Z0-9]{2,5})$/.exec(filename);
    const ext = extMatch ? '.' + extMatch[1].toLowerCase() : '.bin';
    out.push({ field: fieldMatch ? fieldMatch[1] : 'file', name: filename, ext, mime, buffer: content });
  }
  return out;
}

// We stash the current request's headers on a module global so parseMultipartFile
// can read the content-type without threading it through. (Simpler for this small app.)
const req_global = {};

function saveImage(buffer, ext) {
  const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return name;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  // GET /api/notes -> list all
  if (req.method === 'GET' && url.pathname === '/api/notes') {
    const rows = stmts.list.all().map(rowToPublic);
    return sendJson(res, 200, { notes: rows });
  }

  // POST /api/notes -> create one (JSON or multipart with attachments)
  if (req.method === 'POST' && url.pathname === '/api/notes') {
    const contentType = req.headers['content-type'] || '';
    let date, note;
    const atts = { image: null, voice: null, video: null, file: null };

    if (/multipart\/form-data/i.test(contentType)) {
      req_global.content_type = contentType;
      const body = await readBody(req, MAX_IMAGE_BYTES * 4 + 1024 * 1024);
      const fields = parseMultipartFields(body, contentType);
      date = (fields.date || '').trim();
      note = (fields.note || '').trim();
      for (const f of parseMultipartFiles(body)) {
        if (f.buffer.length === 0) continue;
        const key = ['image', 'voice', 'video', 'file'].includes(f.field) ? f.field : 'file';
        if (!atts[key]) atts[key] = saveImage(f.buffer, f.ext);
      }
      // Passthrough: reference a file that already exists on this server (used by sync pull).
      for (const key of ['image', 'voice', 'video', 'file']) {
        const ref = (fields[key + '_url'] || '').trim();
        if (ref && !atts[key]) atts[key] = path.basename(ref);
      }
    } else {
      const body = await readBody(req, 1024 * 1024);
      let data;
      try {
        data = JSON.parse(body.toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      date = (data.date || '').trim();
      note = (data.note || '').trim();
      for (const key of ['image', 'voice', 'video', 'file']) {
        const ref = (data[key + '_url'] || '').trim();
        if (ref && !atts[key]) atts[key] = path.basename(ref);
      }
    }

    if (!date) return sendJson(res, 400, { error: 'date is required' });
    const hasAttach = atts.image || atts.voice || atts.video || atts.file;
    if (!note && !hasAttach) {
      return sendJson(res, 400, { error: 'note text or an attachment is required' });
    }

    const info = stmts.insert.run(
      date, note, atts.image, atts.voice, atts.video, atts.file, new Date().toISOString()
    );
    const row = stmts.get.get(Number(info.lastInsertRowid));
    return sendJson(res, 201, { note: rowToPublic(row) });
  }

  // DELETE /api/notes/:id -> delete one tracking note
  const delMatch = /^\/api\/notes\/(\d+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && delMatch) {
    const id = Number(delMatch[1]);
    const row = stmts.get.get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });
    stmts.remove.run(id);
    deleteRowFiles(row);
    return sendJson(res, 200, { ok: true, id });
  }

  // PATCH /api/notes/:id -> update one tracking note (JSON or multipart with new attachments)
  if (req.method === 'PATCH' && delMatch) {
    const id = Number(delMatch[1]);
    const row = stmts.get.get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });

    const contentType = req.headers['content-type'] || '';
    let date, note;
    // New uploads per slot (null until a file part arrives).
    const atts = { image: null, voice: null, video: null, file: null };
    // Explicit slot instructions from fields/JSON: 'keep' | '' (remove) | filename reference.
    const slots = {};

    if (/multipart\/form-data/i.test(contentType)) {
      req_global.content_type = contentType;
      const body = await readBody(req, MAX_IMAGE_BYTES * 4 + 1024 * 1024);
      const fields = parseMultipartFields(body, contentType);
      date = (fields.date || '').trim();
      note = (fields.note || '').trim();
      for (const key of ['image', 'voice', 'video', 'file']) {
        if (Object.prototype.hasOwnProperty.call(fields, key + '_slot')) slots[key] = fields[key + '_slot'];
      }
      for (const f of parseMultipartFiles(body)) {
        if (f.buffer.length === 0) continue;
        const key = ['image', 'voice', 'video', 'file'].includes(f.field) ? f.field : 'file';
        if (!atts[key]) atts[key] = saveImage(f.buffer, f.ext);
      }
    } else {
      const body = await readBody(req, 1024 * 1024);
      let data;
      try {
        data = JSON.parse(body.toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      date = (data.date ?? '').trim();
      note = (data.note ?? '').trim();
      for (const key of ['image', 'voice', 'video', 'file']) {
        if (Object.prototype.hasOwnProperty.call(data, key + '_slot')) slots[key] = data[key + '_slot'];
      }
    }

    if (!date) return sendJson(res, 400, { error: 'date is required' });
    const hasAttach = atts.image || atts.voice || atts.video || atts.file;
    if (!note && !hasAttach) {
      return sendJson(res, 400, { error: 'note text or an attachment is required' });
    }

    // Resolve each slot to its final filename.
    const col = { image: 'image_name', voice: 'voice_name', video: 'video_name', file: 'file_name' };
    const oldFiles = {};
    for (const key of ['image', 'voice', 'video', 'file']) {
      const current = row[col[key]] || null;
      let next = current; // default: keep
      if (atts[key]) next = atts[key];                       // new upload replaces
      else if (Object.prototype.hasOwnProperty.call(slots, key)) {
        const v = String(slots[key]).trim();
        if (v === 'keep') next = current;
        else if (v === '') next = null;                        // explicit remove
        else next = path.basename(v);                           // reference an existing file
      }
      if (next !== current) {
        oldFiles[col[key]] = current;   // remember files that will be orphaned
        db.prepare('UPDATE notes SET ' + col[key] + ' = ? WHERE id = ?').run(next, id);
      }
    }
    db.prepare('UPDATE notes SET date = ?, note = ? WHERE id = ?').run(date, note, id);

    // Delete files that are no longer referenced by ANY row (so shared files survive).
    for (const [c, fname] of Object.entries(oldFiles)) {
      if (!fname) continue;
      const stillUsed = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE ' + c + ' = ?').get(fname).c;
      if (stillUsed === 0) { try { fs.unlinkSync(path.join(UPLOAD_DIR, fname)); } catch {} }
    }

    const updated = stmts.get.get(id);
    return sendJson(res, 200, { note: rowToPublic(updated) });
  }

  // ---- Note-taking feature (undated, auto timestamp + tags) ----

  // GET /api/tags -> all available tag names
  if (req.method === 'GET' && url.pathname === '/api/tags') {
    const rows = stmts.tag_all.all();
    return sendJson(res, 200, { tags: rows.map((r) => r.name) });
  }

  // DELETE /api/tags?name=... -> remove a tag from the tag list (and its links)
  if (req.method === 'DELETE' && url.pathname === '/api/tags') {
    const name = (url.searchParams.get('name') || '').trim();
    if (!name) return sendJson(res, 400, { error: 'tag name is required' });
    const tag = stmts.tag_get.get(name);
    if (!tag) return sendJson(res, 404, { error: 'not found' });
    stmts.tag_remove.run(tag.id); // cascades to notes_tags
    return sendJson(res, 200, { ok: true, name });
  }

  // GET /api/taking -> list taking notes with their tags
  if (req.method === 'GET' && url.pathname === '/api/taking') {
    const rows = stmts.t_list.all().map((r) => ({
      id: r.id,
      note: r.note,
      image: r.image_name ? '/uploads/' + r.image_name : null,
      image_hash: attHash(r.image_name),
      attachments: attachmentsOf(r),
      created_at: r.created_at,
      tags: stmts.tags_for_note.all(r.id).map((t) => t.name),
    }));
    return sendJson(res, 200, { notes: rows });
  }

  // POST /api/taking -> create a taking note (JSON or multipart with attachments + tags)
  if (req.method === 'POST' && url.pathname === '/api/taking') {
    const contentType = req.headers['content-type'] || '';
    let note;
    const atts = { image: null, voice: null, video: null, file: null };
    let tagNames = [];

    if (/multipart\/form-data/i.test(contentType)) {
      req_global.content_type = contentType;
      const body = await readBody(req, MAX_IMAGE_BYTES * 4 + 1024 * 1024);
      const fields = parseMultipartFields(body, contentType);
      note = (fields.note || '').trim();
      tagNames = (fields.tags || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const f of parseMultipartFiles(body)) {
        if (f.buffer.length === 0) continue;
        const key = ['image', 'voice', 'video', 'file'].includes(f.field) ? f.field : 'file';
        if (!atts[key]) atts[key] = saveImage(f.buffer, f.ext);
      }
      for (const key of ['image', 'voice', 'video', 'file']) {
        const ref = (fields[key + '_url'] || '').trim();
        if (ref && !atts[key]) atts[key] = path.basename(ref);
      }
    } else {
      const body = await readBody(req, 1024 * 1024);
      let data;
      try {
        data = JSON.parse(body.toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      note = (data.note || '').trim();
      tagNames = Array.isArray(data.tags)
        ? data.tags.map((s) => String(s).trim()).filter(Boolean)
        : [];
      for (const key of ['image', 'voice', 'video', 'file']) {
        const ref = (data[key + '_url'] || '').trim();
        if (ref && !atts[key]) atts[key] = path.basename(ref);
      }
    }

    const hasAttach = atts.image || atts.voice || atts.video || atts.file;
    if (!note && !hasAttach) {
      return sendJson(res, 400, { error: 'note text or an attachment is required' });
    }

    const info = stmts.t_insert.run(
      note, atts.image, atts.voice, atts.video, atts.file, new Date().toISOString()
    );
    const id = Number(info.lastInsertRowid);
    attachTags(id, tagNames);
    return sendJson(res, 201, { note: getTakingNote(id) });
  }

  // DELETE /api/taking/:id -> delete one taking note
  const tDelMatch = /^\/api\/taking\/(\d+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && tDelMatch) {
    const id = Number(tDelMatch[1]);
    const row = stmts.t_get.get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });
    stmts.t_remove.run(id); // cascades to notes_tags
    deleteRowFiles(row);
    return sendJson(res, 200, { ok: true, id });
  }

  // PATCH /api/taking/:id -> update one taking note (JSON or multipart with new attachments + tags)
  if (req.method === 'PATCH' && tDelMatch) {
    const id = Number(tDelMatch[1]);
    const row = stmts.t_get.get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });

    const contentType = req.headers['content-type'] || '';
    let note;
    let tagNames = null; // null = keep current tags
    const atts = { image: null, voice: null, video: null, file: null };
    const slots = {};

    if (/multipart\/form-data/i.test(contentType)) {
      req_global.content_type = contentType;
      const body = await readBody(req, MAX_IMAGE_BYTES * 4 + 1024 * 1024);
      const fields = parseMultipartFields(body, contentType);
      note = (fields.note || '').trim();
      if (Object.prototype.hasOwnProperty.call(fields, 'tags')) {
        tagNames = (fields.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
      }
      for (const key of ['image', 'voice', 'video', 'file']) {
        if (Object.prototype.hasOwnProperty.call(fields, key + '_slot')) slots[key] = fields[key + '_slot'];
      }
      for (const f of parseMultipartFiles(body)) {
        if (f.buffer.length === 0) continue;
        const key = ['image', 'voice', 'video', 'file'].includes(f.field) ? f.field : 'file';
        if (!atts[key]) atts[key] = saveImage(f.buffer, f.ext);
      }
    } else {
      const body = await readBody(req, 1024 * 1024);
      let data;
      try {
        data = JSON.parse(body.toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      note = (data.note ?? '').trim();
      if (Object.prototype.hasOwnProperty.call(data, 'tags')) {
        tagNames = Array.isArray(data.tags) ? data.tags.map((s) => String(s).trim()).filter(Boolean) : null;
      }
      for (const key of ['image', 'voice', 'video', 'file']) {
        if (Object.prototype.hasOwnProperty.call(data, key + '_slot')) slots[key] = data[key + '_slot'];
      }
    }

    const hasAttach = atts.image || atts.voice || atts.video || atts.file;
    if (!note && !hasAttach) {
      return sendJson(res, 400, { error: 'note text or an attachment is required' });
    }

    const col = { image: 'image_name', voice: 'voice_name', video: 'video_name', file: 'file_name' };
    const oldFiles = {};
    for (const key of ['image', 'voice', 'video', 'file']) {
      const current = row[col[key]] || null;
      let next = current; // default: keep
      if (atts[key]) next = atts[key];
      else if (Object.prototype.hasOwnProperty.call(slots, key)) {
        const v = String(slots[key]).trim();
        if (v === 'keep') next = current;
        else if (v === '') next = null;
        else next = path.basename(v);
      }
      if (next !== current) {
        oldFiles[col[key]] = current;
        db.prepare('UPDATE taking_notes SET ' + col[key] + ' = ? WHERE id = ?').run(next, id);
      }
    }
    db.prepare('UPDATE taking_notes SET note = ? WHERE id = ?').run(note, id);

    if (tagNames !== null) attachTags(id, tagNames);

    for (const [c, fname] of Object.entries(oldFiles)) {
      if (!fname) continue;
      const stillUsed = db.prepare('SELECT COUNT(*) AS c FROM taking_notes WHERE ' + c + ' = ?').get(fname).c;
      if (stillUsed === 0) { try { fs.unlinkSync(path.join(UPLOAD_DIR, fname)); } catch {} }
    }

    return sendJson(res, 200, { note: getTakingNote(id) });
  }

  // ---- LAN consolidation SYNC (hub <-> client) ----

  // POST /api/sync/upload -> store one attachment file on THIS server, return its filename.
  // Body: { data: "<base64>", name: "original.ext" }  ->  { name: "<stored>.ext" }
  // Used by a client to push its local attachments up to the hub.
  if (req.method === 'POST' && url.pathname === '/api/sync/upload') {
    const body = await readBody(req, MAX_IMAGE_BYTES + 1024 * 1024);
    let data;
    try { data = JSON.parse(body.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    const b64 = (data.data || '').trim();
    if (!b64) return sendJson(res, 400, { error: 'no data' });
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0) return sendJson(res, 400, { error: 'empty file' });
    const nameMatch = /\.([a-zA-Z0-9]{2,5})$/.exec(data.name || '');
    const ext = nameMatch ? '.' + nameMatch[1].toLowerCase() : '.bin';
    const stored = saveImage(buf, ext);
    // Return the content hash so the client can match this attachment across devices.
    return sendJson(res, 200, { name: stored, hash: crypto.createHash('sha1').update(buf).digest('hex') });
  }

  // POST /api/sync/push -> merge this device's records into the hub (keep both / dedupe by content)
  if (req.method === 'POST' && url.pathname === '/api/sync/push') {
    const body = await readBody(req, 1024 * 1024); // JSON only (attachments already live on the hub or are re-sent separately)
    let data;
    try { data = JSON.parse(body.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

    const res_ = { tracking: addedTracking(data.tracking), taking: addedTaking(data.taking) };
    // Also merge any new tag names the client knows about.
    for (const t of (data.tags || [])) stmts.tag_get_or_create.get(String(t).trim());
    return sendJson(res, 200, res_);
  }

  // POST /api/sync/fetch -> download one attachment from a remote URL, store locally.
  // Body: { url }  ->  { name } (local filename in uploads/)
  if (req.method === 'POST' && url.pathname === '/api/sync/fetch') {
    const body = await readBody(req, MAX_IMAGE_BYTES + 1024 * 1024);
    let data;
    try { data = JSON.parse(body.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    const remoteUrl = (data.url || '').trim();
    if (!/^https?:\/\//i.test(remoteUrl)) return sendJson(res, 400, { error: 'url must be http(s)' });

    // Stream the remote file into memory (bounded), then save locally.
    const bytes = await fetchBytes(remoteUrl);
    const extMatch = /\.([a-zA-Z0-9]{2,5})/.exec(decodeURIComponent(remoteUrl.split('/').pop() || ''));
    const ext = extMatch ? '.' + extMatch[1].toLowerCase() : '.bin';
    const name = saveImage(bytes, ext);
    return sendJson(res, 200, { name });
  }

  // POST /api/sync/apply -> insert a batch of records into THIS device, deduped by content.
  // Used by a client after pulling from the hub. Body: { tracking:[], taking:[], tags:[] }
  if (req.method === 'POST' && url.pathname === '/api/sync/apply') {
    const body = await readBody(req, 1024 * 1024);
    let data;
    try { data = JSON.parse(body.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    const res_ = { tracking: addedTracking(data.tracking), taking: addedTaking(data.taking) };
    for (const t of (data.tags || [])) stmts.tag_get_or_create.get(String(t).trim());
    return sendJson(res, 200, res_);
  }

  // GET /api/sync/pull -> return the hub's consolidated records (+ tags)
  if (req.method === 'GET' && url.pathname === '/api/sync/pull') {
    const tracking = stmts.list.all().map((r) => ({
      date: r.date, note: r.note, created_at: r.created_at,
      image: r.image_name, voice: r.voice_name, video: r.video_name, file: r.file_name,
      image_hash: attHash(r.image_name), voice_hash: attHash(r.voice_name),
      video_hash: attHash(r.video_name), file_hash: attHash(r.file_name),
    }));
    const taking = stmts.t_list.all().map((r) => ({
      note: r.note, created_at: r.created_at,
      image: r.image_name, voice: r.voice_name, video: r.video_name, file: r.file_name,
      image_hash: attHash(r.image_name), voice_hash: attHash(r.voice_name),
      video_hash: attHash(r.video_name), file_hash: attHash(r.file_name),
      tags: stmts.tags_for_note.all(r.id).map((t) => t.name),
    }));
    const tags = stmts.tag_all.all().map((t) => t.name);
    return sendJson(res, 200, { tracking, taking, tags });
  }

  return sendJson(res, 404, { error: 'not found' });
}

// Download bytes from an http(s) URL (bounded), for sync attachment fetch.
async function fetchBytes(remoteUrl, limitBytes = MAX_IMAGE_BYTES + 1024 * 1024) {
  const r = await fetch(remoteUrl);
  if (!r.ok) throw new Error('remote fetch failed: ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > limitBytes) throw new Error('attachment too large');
  return buf;
}

// --- Sync merge helpers (keep both / dedupe by content hash) ---

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Content hash of a stored attachment file (empty string if missing). This makes the
// note identity independent of the (server-specific) filename, so the same image on two
// devices hashes identically even though each stores it under a different name.
function attHash(filename) {
  if (!filename) return '';
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(UPLOAD_DIR, filename))).digest('hex');
  } catch {
    return 'missing:' + filename;
  }
}

// Canonical identity for a note: text fields + attachment CONTENT hashes (not filenames).
function trackingIdentity({ date, note, image_name, voice_name, video_name, file_name }) {
  return [date || '', note || '', attHash(image_name), attHash(voice_name), attHash(video_name), attHash(file_name)].join('\u0001');
}
function takingIdentity({ note, image_name, voice_name, video_name, file_name, tags }) {
  return [note || '', attHash(image_name), attHash(voice_name), attHash(video_name), attHash(file_name), (tags || []).slice().sort().join(',')].join('\u0001');
}

// An incoming sync object carries attachment content hashes under *_hash keys (sent by the
// client). Fall back to reading the local file if a hash isn't provided.
function trackingIdentityIn(n) {
  return [n.date || '', n.note || '', n.image_hash || attHash(n.image), n.voice_hash || attHash(n.voice), n.video_hash || attHash(n.video), n.file_hash || attHash(n.file)].join('\u0001');
}
function takingIdentityIn(n) {
  return [n.note || '', n.image_hash || attHash(n.image), n.voice_hash || attHash(n.voice), n.video_hash || attHash(n.video), n.file_hash || attHash(n.file), (n.tags || []).slice().sort().join(',')].join('\u0001');
}

// Insert incoming tracking notes that aren't already present (by content identity).
function addedTracking(incoming) {
  const existing = new Set(stmts.list.all().map((r) => sha1(trackingIdentity(r))));
  let added = 0;
  for (const n of incoming || []) {
    if (!n) continue;
    const h = sha1(trackingIdentityIn(n));
    if (existing.has(h)) continue;
    stmts.insert.run(
      n.date, n.note || '', n.image || null, n.voice || null, n.video || null, n.file || null,
      n.created_at || new Date().toISOString()
    );
    existing.add(h);
    added++;
  }
  return added;
}

// Insert incoming taking notes that aren't already present (by content identity).
function addedTaking(incoming) {
  const existing = new Set(
    stmts.t_list.all().map((r) => sha1(takingIdentity({ ...r, tags: stmts.tags_for_note.all(r.id).map((t) => t.name) })))
  );
  let added = 0;
  for (const n of incoming || []) {
    if (!n) continue;
    const h = sha1(takingIdentityIn(n));
    if (existing.has(h)) continue;
    const info = stmts.t_insert.run(
      n.note || '', n.image || null, n.voice || null, n.video || null, n.file || null,
      n.created_at || new Date().toISOString()
    );
    attachTags(Number(info.lastInsertRowid), (n.tags || []).map(String));
    existing.add(h);
    added++;
  }
  return added;
}

// Replace a taking note's tags with the given names (creating new ones as needed).
function attachTags(noteId, tagNames) {
  stmts.tag_set_note.run(noteId);
  for (const name of tagNames) {
    const tag = stmts.tag_get_or_create.get(name);
    if (tag) stmts.tag_link.run(noteId, tag.id);
  }
}

function getTakingNote(id) {
  const r = stmts.t_get.get(id);
  return {
    id: r.id,
    note: r.note,
    image: r.image_name ? '/uploads/' + r.image_name : null,
    image_hash: attHash(r.image_name),
    attachments: attachmentsOf(r),
    created_at: r.created_at,
    tags: stmts.tags_for_note.all(id).map((t) => t.name),
  };
}

// Parse text fields (non-file parts) out of a multipart body.
function parseMultipartFields(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  let boundary = null;
  if (boundaryMatch) boundary = boundaryMatch[1] || boundaryMatch[2];
  if (!boundary) return {};
  const delim = Buffer.from('--' + boundary);
  const out = {};
  let start = body.indexOf(delim);
  while (start !== -1) {
    const nextStart = body.indexOf(delim, start + delim.length);
    if (nextStart === -1) break;
    const part = body.subarray(start + delim.length, nextStart);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      let content = part.subarray(headerEnd + 4);
      if (content.slice(-2).toString() === '\r\n') content = content.subarray(0, -2);
      const nameMatch = /name="([^"]*)"/i.exec(headers);
      const isFile = /filename="/i.test(headers);
      if (nameMatch && !isFile) out[nameMatch[1]] = content.toString('utf8');
    }
    start = nextStart;
  }
  return out;
}

function attachmentsOf(row) {
  const out = [];
  if (row.voice_name) out.push({ type: 'audio', url: '/uploads/' + row.voice_name, hash: attHash(row.voice_name) });
  if (row.video_name) out.push({ type: 'video', url: '/uploads/' + row.video_name, hash: attHash(row.video_name) });
  if (row.file_name) out.push({ type: 'file', url: '/uploads/' + row.file_name, name: row.file_name, hash: attHash(row.file_name) });
  return out;
}

// Remove all stored attachment files for a deleted row.
function deleteRowFiles(row) {
  for (const col of ['image_name', 'voice_name', 'video_name', 'file_name']) {
    if (row[col]) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, row[col])); } catch {}
    }
  }
}

function rowToPublic(row) {
  return {
    id: row.id,
    date: row.date,
    note: row.note,
    image: row.image_name ? '/uploads/' + row.image_name : null,
    image_hash: attHash(row.image_name),
    attachments: attachmentsOf(row),
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Static file serving (UI + uploaded images)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  // video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  // common files
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  // Only allow index.html at root and files under /uploads/.
  const filePath = path.normalize(path.join(ROOT, '.' + rel));
  if (!filePath.startsWith(ROOT)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'not found' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// CORS: allow any device's browser (a separate client at 127.0.0.1 or another
// LAN address) to call this hub's API and fetch its uploads. Without these
// headers the browser blocks cross-origin requests, which is why syncing from a
// client running on its own localhost failed.
function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  if (origin) res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Let browsers load attachment files cross-origin.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Disposition');
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Handle CORS preflight for any path.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET') return serveStatic(req, res, url);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/payload too large/.test(msg)) return sendJson(res, 413, { error: 'image too large' });
    console.error('Request error:', e);
    sendJson(res, 500, { error: 'internal server error' });
  }
});

// Bind to all interfaces so other devices on the LAN can reach this hub.
// (Set HOST=127.0.0.1 to restrict to localhost only.)
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Note-taking app running:  http://127.0.0.1:${PORT}  (this device)`);
  // Best-effort LAN address for other devices to open.
  const os = require('node:os');
  const ifaces = os.networkInterfaces();
  const lanIps = Object.values(ifaces)
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal);
  for (const ip of lanIps) console.log(`LAN: other devices can open  http://${ip.address}:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
});
