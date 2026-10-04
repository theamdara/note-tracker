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
    expect_end_date TEXT,                    -- expected end date YYYY-MM-DD (NULL if none)
    archived    INTEGER NOT NULL DEFAULT 0,  -- 1 = moved to the Archive page
    uuid        TEXT,                        -- stable cross-device identity (sync dedupe)
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
    uuid        TEXT,                        -- stable cross-device identity (sync dedupe)
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

  -- Multi-attachments: a note (tracking or taking) can have any number of attachments.
  -- The legacy single-slot columns (image_name/voice_name/video_name/file_name) are kept
  -- and treated as the first attachment of their kind, so old data keeps working.
  CREATE TABLE IF NOT EXISTS attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note_kind   TEXT    NOT NULL,             -- 'tracking' | 'taking'
    note_id     INTEGER NOT NULL,
    type        TEXT    NOT NULL,             -- 'image' | 'audio' | 'video' | 'file'
    file_name   TEXT    NOT NULL,             -- filename in uploads/
    original_name TEXT,                       -- user-visible filename (NULL = use file_name)
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_kind, note_id);
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

// Migrations: add new columns to existing databases (older notes.db files).
{
  const cols = db.prepare("PRAGMA table_info(notes)").all().map((c) => c.name);
  if (!cols.includes('expect_end_date')) db.exec('ALTER TABLE notes ADD COLUMN expect_end_date TEXT');
  if (!cols.includes('archived')) db.exec('ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('uuid')) db.exec('ALTER TABLE notes ADD COLUMN uuid TEXT');
  const tcols = db.prepare("PRAGMA table_info(taking_notes)").all().map((c) => c.name);
  if (!tcols.includes('uuid')) db.exec('ALTER TABLE taking_notes ADD COLUMN uuid TEXT');
}

// Migration: move legacy single-slot attachments into the attachments table (once).
{
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  if (tables.has('attachments')) {
    const hasData = db.prepare('SELECT COUNT(*) AS c FROM attachments').get().c > 0;
    if (!hasData) {
      const ins = db.prepare(
        'INSERT INTO attachments (note_kind, note_id, type, file_name, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const migrate = (kind, table) => {
        for (const r of db.prepare('SELECT * FROM ' + table).all()) {
          let order = 0;
          for (const [col, type] of [['image_name', 'image'], ['voice_name', 'audio'], ['video_name', 'video'], ['file_name', 'file']]) {
            if (r[col]) ins.run(kind, r.id, type, r[col], order++, r.created_at || new Date().toISOString());
          }
        }
      };
      migrate('tracking', 'notes');
      migrate('taking', 'taking_notes');
    }
  }
}

const stmts = {
  // Tracking notes
  insert: db.prepare(
    'INSERT INTO notes (date, note, image_name, voice_name, video_name, file_name, expect_end_date, uuid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  list: db.prepare('SELECT * FROM notes ORDER BY date DESC, id DESC'),
  get: db.prepare('SELECT * FROM notes WHERE id = ?'),
  remove: db.prepare('DELETE FROM notes WHERE id = ?'),

  // Taking notes
  t_insert: db.prepare(
    'INSERT INTO taking_notes (note, image_name, voice_name, video_name, file_name, uuid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
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

  // Multi-attachments
  att_insert: db.prepare(
    'INSERT INTO attachments (note_kind, note_id, type, file_name, original_name, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  att_list: db.prepare('SELECT * FROM attachments WHERE note_kind = ? AND note_id = ? ORDER BY sort_order, id'),
  att_get: db.prepare('SELECT * FROM attachments WHERE id = ?'),
  att_remove: db.prepare('DELETE FROM attachments WHERE id = ?'),
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

// Normalize an optional date field (e.g. expect_end_date): accept YYYY-MM-DD, return null when empty/invalid.
function normalizeDateField(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : s;
}

function saveImage(buffer, ext) {
  const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return name;
}

// A note's stable cross-device identity. Generated once at creation and carried through
// sync so the same note is never inserted twice on any device (dedupe by uuid first,
// falling back to content-hash for notes created before uuids existed).
function newUuid() {
  return crypto.randomUUID();
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

  // POST /api/notes -> create one (JSON or multipart with attachments; multiple files per type allowed)
  if (req.method === 'POST' && url.pathname === '/api/notes') {
    const contentType = req.headers['content-type'] || '';
    let date, note, expectEndDate;
    // Legacy single-slot refs (first image/audio/video/file), from sync passthrough.
    const legacyRefs = { image: null, voice: null, video: null, file: null };
    // New multi-attachments collected from multipart file parts.
    const newAtts = [];

    if (/multipart\/form-data/i.test(contentType)) {
      req_global.content_type = contentType;
      const body = await readBody(req, MAX_IMAGE_BYTES * 8 + 1024 * 1024);
      const fields = parseMultipartFields(body, contentType);
      date = (fields.date || '').trim();
      note = (fields.note || '').trim();
      expectEndDate = normalizeDateField(fields.expect_end_date);
      for (const f of parseMultipartFiles(body)) {
        if (f.buffer.length === 0) continue;
        const key = ['image', 'voice', 'video', 'file'].includes(f.field) ? f.field : 'file';
        newAtts.push({ type: key, buffer: f.buffer, ext: f.ext, name: f.name });
      }
      // Passthrough: reference files that already exist on this server (used by sync pull).
      for (const key of ['image', 'voice', 'video', 'file']) {
        const ref = (fields[key + '_url'] || '').trim();
        if (ref && !legacyRefs[key]) legacyRefs[key] = path.basename(ref);
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
      expectEndDate = normalizeDateField(data.expect_end_date);
      for (const key of ['image', 'voice', 'video', 'file']) {
        const ref = (data[key + '_url'] || '').trim();
        if (ref && !legacyRefs[key]) legacyRefs[key] = path.basename(ref);
      }
    }

    if (!date) return sendJson(res, 400, { error: 'date is required' });
    const hasAttach = newAtts.length > 0 || Object.values(legacyRefs).some(Boolean);
    if (!note && !hasAttach) {
      return sendJson(res, 400, { error: 'note text or an attachment is required' });
    }

    const info = stmts.insert.run(
      date, note, legacyRefs.image, legacyRefs.voice, legacyRefs.video, legacyRefs.file, expectEndDate, newUuid(), new Date().toISOString()
    );
    const id = Number(info.lastInsertRowid);
    addAttachments('tracking', id, newAtts);
    const row = stmts.get.get(id);
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

  // POST /api/notes/:id/archive -> archive or unarchive a tracking note.
  // Body: { archived: true | false }  ->  { ok, id, archived }
  const archMatch = /^\/api\/notes\/(\d+)\/archive$/.exec(url.pathname);
  if (req.method === 'POST' && archMatch) {
    const id = Number(archMatch[1]);
    const row = stmts.get.get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });
    let body;
    try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
    catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    const archived = body.archived ? 1 : 0;
    db.prepare('UPDATE notes SET archived = ? WHERE id = ?').run(archived, id);
    return sendJson(res, 200, { ok: true, id, archived: !!archived });
  }

  // POST /api/notes/:id/attachments -> add one or more attachments (multipart, fields image/voice/video/file)
  if (req.method === 'POST' && /^\/api\/notes\/(\d+)\/attachments$/.test(url.pathname)) {
    const id = Number(/^\/api\/notes\/(\d+)\/attachments$/.exec(url.pathname)[1]);
    const row = stmts.get.get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });
    req_global.content_type = req.headers['content-type'] || '';
    const body = await readBody(req, MAX_IMAGE_BYTES * 8 + 1024 * 1024);
    const items = parseMultipartFiles(body)
      .filter((f) => f.buffer.length > 0)
      .map((f) => ({ type: ['image', 'voice', 'video', 'file'].includes(f.field) ? f.field : 'file', buffer: f.buffer, ext: f.ext, name: f.name }));
    if (items.length === 0) return sendJson(res, 400, { error: 'no files' });
    addAttachments('tracking', id, items);
    return sendJson(res, 201, { note: rowToPublic(stmts.get.get(id)) });
  }

  // DELETE /api/notes/:id/attachments/:attId -> remove one attachment
  const trAttDelMatch = /^\/api\/notes\/(\d+)\/attachments\/(\d+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && trAttDelMatch) {
    const id = Number(trAttDelMatch[1]);
    const attId = Number(trAttDelMatch[2]);
    if (!stmts.get.get(id)) return sendJson(res, 404, { error: 'not found' });
    const att = stmts.att_get.get(attId);
    if (!att || att.note_kind !== 'tracking' || att.note_id !== id) return sendJson(res, 404, { error: 'attachment not found' });
    stmts.att_remove.run(attId);
    cleanupOrphanFiles([att.file_name]);
    return sendJson(res, 200, { ok: true, note: rowToPublic(stmts.get.get(id)) });
  }

  // PATCH /api/notes/:id -> update one tracking note (JSON or multipart with new attachments)
  if (req.method === 'PATCH' && delMatch) {
    const id = Number(delMatch[1]);
    const row = stmts.get.get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });

    const contentType = req.headers['content-type'] || '';
    let date, note, expectEndDate;
    // New multi-attachments from multipart file parts.
    const newAtts = [];
    // Attachments to remove during this edit (ids or legacy filenames), applied on save.
    let removedIds = [];
    // Explicit slot instructions (legacy image slot): 'keep' | '' (remove) | filename reference.
    const slots = {};

    if (/multipart\/form-data/i.test(contentType)) {
      req_global.content_type = contentType;
      const body = await readBody(req, MAX_IMAGE_BYTES * 8 + 1024 * 1024);
      const fields = parseMultipartFields(body, contentType);
      date = (fields.date || '').trim();
      note = (fields.note || '').trim();
      expectEndDate = normalizeDateField(fields.expect_end_date);
      if (Object.prototype.hasOwnProperty.call(fields, 'image_slot')) slots.image = fields.image_slot;
      removedIds = String(fields.removed_attachment_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const f of parseMultipartFiles(body)) {
        if (f.buffer.length === 0) continue;
        const key = ['image', 'voice', 'video', 'file'].includes(f.field) ? f.field : 'file';
        newAtts.push({ type: key, buffer: f.buffer, ext: f.ext, name: f.name });
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
      expectEndDate = normalizeDateField(data.expect_end_date);
      if (Object.prototype.hasOwnProperty.call(data, 'image_slot')) slots.image = data.image_slot;
      if (Array.isArray(data.removed_attachment_ids)) removedIds = data.removed_attachment_ids.map(String);
    }

    if (!date) return sendJson(res, 400, { error: 'date is required' });
    if (!note && newAtts.length === 0) {
      return sendJson(res, 400, { error: 'note text or an attachment is required' });
    }

    // Legacy image slot: resolve to its final filename (keep / remove / reference).
    let oldImageFile = null;
    if (Object.prototype.hasOwnProperty.call(slots, 'image')) {
      const v = String(slots.image).trim();
      const next = v === 'keep' ? (row.image_name || null) : v === '' ? null : path.basename(v);
      if (next !== (row.image_name || null)) {
        oldImageFile = row.image_name || null;
        db.prepare('UPDATE notes SET image_name = ? WHERE id = ?').run(next, id);
      }
    }

    db.prepare('UPDATE notes SET date = ?, note = ?, expect_end_date = ? WHERE id = ?')
      .run(date, note, expectEndDate, id);

    // Attachments removed during this edit (applied on save).
    const removedFiles = removeAttachmentsByIds('tracking', id, removedIds);

    // New multi-attachments.
    addAttachments('tracking', id, newAtts);

    cleanupOrphanFiles([oldImageFile, ...removedFiles]);

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

  // GET /api/taking -> list taking notes with their tags and all attachments
  if (req.method === 'GET' && url.pathname === '/api/taking') {
    const rows = stmts.t_list.all().map((r) => {
      const atts = attachmentsOfNote('taking', r);
      return {
        id: r.id,
        uuid: r.uuid || null,
        note: r.note,
        image: atts.find((a) => a.primary) ? atts.find((a) => a.primary).url : null,
        image_hash: r.image_name ? attHash(r.image_name) : '',
        attachments: atts,
        created_at: r.created_at,
        tags: stmts.tags_for_note.all(r.id).map((t) => t.name),
      };
    });
    return sendJson(res, 200, { notes: rows });
  }

  // POST /api/taking -> create a taking note (JSON or multipart with attachments + tags; multiple files per type allowed)
  if (req.method === 'POST' && url.pathname === '/api/taking') {
    const contentType = req.headers['content-type'] || '';
    let note;
    const legacyRefs = { image: null, voice: null, video: null, file: null };
    const newAtts = [];
    let tagNames = [];

    if (/multipart\/form-data/i.test(contentType)) {
      req_global.content_type = contentType;
      const body = await readBody(req, MAX_IMAGE_BYTES * 8 + 1024 * 1024);
      const fields = parseMultipartFields(body, contentType);
      note = (fields.note || '').trim();
      tagNames = (fields.tags || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const f of parseMultipartFiles(body)) {
        if (f.buffer.length === 0) continue;
        const key = ['image', 'voice', 'video', 'file'].includes(f.field) ? f.field : 'file';
        newAtts.push({ type: key, buffer: f.buffer, ext: f.ext, name: f.name });
      }
      for (const key of ['image', 'voice', 'video', 'file']) {
        const ref = (fields[key + '_url'] || '').trim();
        if (ref && !legacyRefs[key]) legacyRefs[key] = path.basename(ref);
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
        if (ref && !legacyRefs[key]) legacyRefs[key] = path.basename(ref);
      }
    }

    const hasAttach = newAtts.length > 0 || Object.values(legacyRefs).some(Boolean);
    if (!note && !hasAttach) {
      return sendJson(res, 400, { error: 'note text or an attachment is required' });
    }

    const info = stmts.t_insert.run(
      note, legacyRefs.image, legacyRefs.voice, legacyRefs.video, legacyRefs.file, newUuid(), new Date().toISOString()
    );
    const id = Number(info.lastInsertRowid);
    attachTags(id, tagNames);
    addAttachments('taking', id, newAtts);
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

  // POST /api/taking/:id/attachments -> add one or more attachments (multipart, fields image/voice/video/file)
  if (req.method === 'POST' && /^\/api\/taking\/(\d+)\/attachments$/.test(url.pathname)) {
    const id = Number(/^\/api\/taking\/(\d+)\/attachments$/.exec(url.pathname)[1]);
    const row = stmts.t_get.get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });
    req_global.content_type = req.headers['content-type'] || '';
    const body = await readBody(req, MAX_IMAGE_BYTES * 8 + 1024 * 1024);
    const items = parseMultipartFiles(body)
      .filter((f) => f.buffer.length > 0)
      .map((f) => ({ type: ['image', 'voice', 'video', 'file'].includes(f.field) ? f.field : 'file', buffer: f.buffer, ext: f.ext, name: f.name }));
    if (items.length === 0) return sendJson(res, 400, { error: 'no files' });
    addAttachments('taking', id, items);
    return sendJson(res, 201, { note: getTakingNote(id) });
  }

  // DELETE /api/taking/:id/attachments/:attId -> remove one attachment
  const tkAttDelMatch = /^\/api\/taking\/(\d+)\/attachments\/(\d+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && tkAttDelMatch) {
    const id = Number(tkAttDelMatch[1]);
    const attId = Number(tkAttDelMatch[2]);
    if (!stmts.t_get.get(id)) return sendJson(res, 404, { error: 'not found' });
    const att = stmts.att_get.get(attId);
    if (!att || att.note_kind !== 'taking' || att.note_id !== id) return sendJson(res, 404, { error: 'attachment not found' });
    stmts.att_remove.run(attId);
    cleanupOrphanFiles([att.file_name]);
    return sendJson(res, 200, { ok: true, note: getTakingNote(id) });
  }

  // PATCH /api/taking/:id -> update one taking note (JSON or multipart with new attachments + tags)
  if (req.method === 'PATCH' && tDelMatch) {
    const id = Number(tDelMatch[1]);
    const row = stmts.t_get.get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });

    const contentType = req.headers['content-type'] || '';
    let note;
    let tagNames = null; // null = keep current tags
    const newAtts = [];
    let removedIds = [];
    const slots = {};

    if (/multipart\/form-data/i.test(contentType)) {
      req_global.content_type = contentType;
      const body = await readBody(req, MAX_IMAGE_BYTES * 8 + 1024 * 1024);
      const fields = parseMultipartFields(body, contentType);
      note = (fields.note || '').trim();
      if (Object.prototype.hasOwnProperty.call(fields, 'tags')) {
        tagNames = (fields.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'image_slot')) slots.image = fields.image_slot;
      removedIds = String(fields.removed_attachment_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const f of parseMultipartFiles(body)) {
        if (f.buffer.length === 0) continue;
        const key = ['image', 'voice', 'video', 'file'].includes(f.field) ? f.field : 'file';
        newAtts.push({ type: key, buffer: f.buffer, ext: f.ext, name: f.name });
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
      if (Object.prototype.hasOwnProperty.call(data, 'image_slot')) slots.image = data.image_slot;
      if (Array.isArray(data.removed_attachment_ids)) removedIds = data.removed_attachment_ids.map(String);
    }

    if (!note && newAtts.length === 0) {
      return sendJson(res, 400, { error: 'note text or an attachment is required' });
    }

    // Legacy image slot: resolve to its final filename (keep / remove / reference).
    let oldImageFile = null;
    if (Object.prototype.hasOwnProperty.call(slots, 'image')) {
      const v = String(slots.image).trim();
      const next = v === 'keep' ? (row.image_name || null) : v === '' ? null : path.basename(v);
      if (next !== (row.image_name || null)) {
        oldImageFile = row.image_name || null;
        db.prepare('UPDATE taking_notes SET image_name = ? WHERE id = ?').run(next, id);
      }
    }

    db.prepare('UPDATE taking_notes SET note = ? WHERE id = ?').run(note, id);

    if (tagNames !== null) attachTags(id, tagNames);

    // Attachments removed during this edit (applied on save).
    const removedFiles = removeAttachmentsByIds('taking', id, removedIds);

    addAttachments('taking', id, newAtts);

    cleanupOrphanFiles([oldImageFile, ...removedFiles]);

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
    // All attachments of a note as portable { type, name, hash } objects. The startup
    // migration moves legacy single-slot columns into the attachments table, so the table
    // is the complete source of truth — read only from it (re-adding the legacy slot would
    // create phantom duplicates when the migrated filename differs).
    const syncAtts = (kind, row) =>
      stmts.att_list.all(kind, row.id).map((a) => ({ type: a.type, name: a.file_name, hash: attHash(a.file_name) }));
    const tracking = stmts.list.all().map((r) => ({
      uuid: r.uuid || null,
      date: r.date, note: r.note, created_at: r.created_at,
      image: r.image_name, voice: r.voice_name, video: r.video_name, file: r.file_name,
      expect_end_date: r.expect_end_date || null, archived: !!r.archived,
      image_hash: attHash(r.image_name), voice_hash: attHash(r.voice_name),
      video_hash: attHash(r.video_name), file_hash: attHash(r.file_name),
      attachments: syncAtts('tracking', r),
    }));
    const taking = stmts.t_list.all().map((r) => ({
      uuid: r.uuid || null,
      note: r.note, created_at: r.created_at,
      image: r.image_name, voice: r.voice_name, video: r.video_name, file: r.file_name,
      image_hash: attHash(r.image_name), voice_hash: attHash(r.voice_name),
      video_hash: attHash(r.video_name), file_hash: attHash(r.file_name),
      tags: stmts.tags_for_note.all(r.id).map((t) => t.name),
      attachments: syncAtts('taking', r),
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
// expect_end_date is included so the same record with different end dates stays distinct;
// archived state is intentionally excluded (it is per-device UI state, not content).
function trackingIdentity({ date, note, image_name, voice_name, video_name, file_name, expect_end_date, note_id }) {
  const extra = stmts.att_list.all('tracking', note_id).map((a) => a.type + ':' + attHash(a.file_name)).sort().join('\u0001');
  return [date || '', note || '', attHash(image_name), attHash(voice_name), attHash(video_name), attHash(file_name), expect_end_date || '', extra].join('\u0001');
}
function takingIdentity({ note, image_name, voice_name, video_name, file_name, tags, note_id }) {
  const extra = stmts.att_list.all('taking', note_id).map((a) => a.type + ':' + attHash(a.file_name)).sort().join('\u0001');
  return [note || '', attHash(image_name), attHash(voice_name), attHash(video_name), attHash(file_name), (tags || []).slice().sort().join(','), extra].join('\u0001');
}

// An incoming sync object carries attachment content hashes under *_hash keys (sent by the
// client). Fall back to reading the local file if a hash isn't provided.
function trackingIdentityIn(n) {
  const extra = incomingAttList(n).map((a) => a.type + ':' + (a.hash || attHash(a.name))).sort().join('\u0001');
  return [n.date || '', n.note || '', n.image_hash || attHash(n.image), n.voice_hash || attHash(n.voice), n.video_hash || attHash(n.video), n.file_hash || attHash(n.file), n.expect_end_date || '', extra].join('\u0001');
}
function takingIdentityIn(n) {
  const extra = incomingAttList(n).map((a) => a.type + ':' + (a.hash || attHash(a.name))).sort().join('\u0001');
  return [n.note || '', n.image_hash || attHash(n.image), n.voice_hash || attHash(n.voice), n.video_hash || attHash(n.video), n.file_hash || attHash(n.file), (n.tags || []).slice().sort().join(','), extra].join('\u0001');
}

// Build the identity of an incoming note from its attachment list (legacy slots + extra attachments).
function incomingAttList(n) {
  const out = [];
  if (n.image) out.push({ type: 'image', hash: n.image_hash || '' });
  if (n.voice) out.push({ type: 'audio', hash: n.voice_hash || '' });
  if (n.video) out.push({ type: 'video', hash: n.video_hash || '' });
  if (n.file) out.push({ type: 'file', hash: n.file_hash || '' });
  for (const a of n.attachments || []) {
    if (a && a.name) out.push({ type: a.type || 'file', hash: a.hash || '' });
  }
  return out;
}

// Insert incoming tracking notes that aren't already present.
// Dedupe order: (1) stable uuid — the same note on any device, even if content changed;
// (2) content identity hash — for notes created before uuids existed.
function addedTracking(incoming) {
  const rows = stmts.list.all();
  const byUuid = new Set(rows.filter((r) => r.uuid).map((r) => r.uuid));
  const byHash = new Set(rows.map((r) => sha1(trackingIdentity({ ...r, note_id: r.id }))));
  let added = 0;
  for (const n of incoming || []) {
    if (!n) continue;
    const uuid = String(n.uuid || '').trim();
    if (uuid && byUuid.has(uuid)) continue; // same note already here (by identity)
    const h = sha1(trackingIdentityIn(n));
    if (byHash.has(h)) {
      // Same content already here (legacy note without uuid): adopt the incoming uuid on the
      // matching row so future syncs dedupe by identity instead of re-matching by content.
      if (uuid) {
        const match = rows.find((r) => !r.uuid && sha1(trackingIdentity({ ...r, note_id: r.id })) === h);
        if (match) db.prepare('UPDATE notes SET uuid = ? WHERE id = ?').run(uuid, match.id);
      }
      continue;
    }
    const info = stmts.insert.run(
      n.date, n.note || '', n.image || null, n.voice || null, n.video || null, n.file || null,
      normalizeDateField(n.expect_end_date), uuid || newUuid(),
      n.created_at || new Date().toISOString()
    );
    // Extra (non-legacy-slot) attachments arrive as { type, name, hash } from the peer.
    const legacyNames = new Set([n.image, n.voice, n.video, n.file].filter(Boolean));
    addAttachments('tracking', Number(info.lastInsertRowid), (n.attachments || [])
      .filter((a) => a && a.name && !legacyNames.has(a.name))
      .map((a) => ({ type: a.type || 'file', name: a.name, hash: a.hash })));
    if (uuid) byUuid.add(uuid);
    byHash.add(h);
    added++;
  }
  return added;
}

// Insert incoming taking notes that aren't already present (same uuid-first dedupe).
function addedTaking(incoming) {
  const rows = stmts.t_list.all();
  const byUuid = new Set(rows.filter((r) => r.uuid).map((r) => r.uuid));
  const byHash = new Set(
    rows.map((r) => sha1(takingIdentity({ ...r, note_id: r.id, tags: stmts.tags_for_note.all(r.id).map((t) => t.name) })))
  );
  let added = 0;
  for (const n of incoming || []) {
    if (!n) continue;
    const uuid = String(n.uuid || '').trim();
    if (uuid && byUuid.has(uuid)) continue; // same note already here (by identity)
    const h = sha1(takingIdentityIn(n));
    if (byHash.has(h)) {
      if (uuid) {
        const match = rows.find((r) => !r.uuid && sha1(takingIdentity({ ...r, note_id: r.id, tags: stmts.tags_for_note.all(r.id).map((t) => t.name) })) === h);
        if (match) db.prepare('UPDATE taking_notes SET uuid = ? WHERE id = ?').run(uuid, match.id);
      }
      continue;
    }
    const info = stmts.t_insert.run(
      n.note || '', n.image || null, n.voice || null, n.video || null, n.file || null,
      uuid || newUuid(),
      n.created_at || new Date().toISOString()
    );
    attachTags(Number(info.lastInsertRowid), (n.tags || []).map(String));
    const legacyNames = new Set([n.image, n.voice, n.video, n.file].filter(Boolean));
    addAttachments('taking', Number(info.lastInsertRowid), (n.attachments || [])
      .filter((a) => a && a.name && !legacyNames.has(a.name))
      .map((a) => ({ type: a.type || 'file', name: a.name, hash: a.hash })));
    if (uuid) byUuid.add(uuid);
    byHash.add(h);
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
  const atts = attachmentsOfNote('taking', r);
  return {
    id: r.id,
    uuid: r.uuid || null,
    note: r.note,
    image: atts.find((a) => a.primary) ? atts.find((a) => a.primary).url : null,
    image_hash: r.image_name ? attHash(r.image_name) : '',
    attachments: atts,
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

// Remove all stored attachment files for a deleted row (legacy slots + attachments table).
function deleteRowFiles(row) {
  const names = new Set();
  for (const col of ['image_name', 'voice_name', 'video_name', 'file_name']) {
    if (row[col]) names.add(row[col]);
  }
  const kind = row.note_kind || 'tracking';
  for (const a of stmts.att_list.all(kind, row.id)) names.add(a.file_name);
  for (const name of names) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch {}
  }
}

// Public attachment object. `primary` marks the legacy single-slot image (used as the card thumbnail).
function attToPublic(a, primary) {
  const type = a.type || 'file';
  const out = {
    id: a.id,
    type,
    url: '/uploads/' + a.file_name,
    name: a.original_name || a.file_name,
    hash: attHash(a.file_name),
  };
  if (primary) out.primary = true;
  return out;
}

// All attachments of a note as public objects. The legacy image slot is included first
// (marked primary) unless it was already migrated into the attachments table.
function attachmentsOfNote(kind, row) {
  const atts = stmts.att_list.all(kind, row.id).map((a) => attToPublic(a, false));
  if (row.image_name && !atts.some((a) => a.url === '/uploads/' + row.image_name)) {
    atts.unshift(attToPublic({ id: null, type: 'image', file_name: row.image_name, original_name: row.image_name }, true));
  }
  return atts;
}

// Add attachments to a note. Two shapes of item are supported:
//   { type, buffer, ext, name }  — bytes to store (regular uploads)
//   { type, name, hash }         — reference an already-stored filename (sync apply)
function addAttachments(kind, noteId, items) {
  const base = stmts.att_list.all(kind, noteId).length;
  let i = 0;
  for (const it of items || []) {
    if (!it) continue;
    let fname;
    if (it.buffer && it.buffer.length > 0) {
      fname = saveImage(it.buffer, it.ext);
    } else if (it.name) {
      fname = path.basename(it.name);
    } else {
      continue;
    }
    stmts.att_insert.run(kind, noteId, it.type || 'file', fname, it.original_name || null, base + i++, new Date().toISOString());
  }
}

// Remove attachments by id from a note (used by PATCH removed_attachment_ids during edit).
// Legacy-slot attachments (id null) are matched by filename instead. Returns orphaned filenames.
function removeAttachmentsByIds(kind, noteId, idsOrNames) {
  const wanted = new Set((idsOrNames || []).map(String));
  if (wanted.size === 0) return [];
  const orphans = [];
  for (const a of stmts.att_list.all(kind, noteId)) {
    if (wanted.has(String(a.id)) || wanted.has(a.file_name)) {
      stmts.att_remove.run(a.id);
      orphans.push(a.file_name);
    }
  }
  return orphans;
}

// Delete attachment files that are no longer referenced anywhere (legacy slots or the table).
function cleanupOrphanFiles(names) {
  for (const name of names) {
    if (!name) continue;
    const inTable = db.prepare('SELECT COUNT(*) AS c FROM attachments WHERE file_name = ?').get(name).c;
    let inLegacy = 0;
    try { inLegacy += db.prepare('SELECT COUNT(*) AS c FROM notes WHERE image_name = ? OR voice_name = ? OR video_name = ? OR file_name = ?').get(name, name, name, name).c; } catch {}
    try { inLegacy += db.prepare('SELECT COUNT(*) AS c FROM taking_notes WHERE image_name = ? OR voice_name = ? OR video_name = ? OR file_name = ?').get(name, name, name, name).c; } catch {}
    if (inTable === 0 && inLegacy === 0) { try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch {} }
  }
}

function rowToPublic(row) {
  const atts = attachmentsOfNote('tracking', row);
  return {
    id: row.id,
    uuid: row.uuid || null,
    date: row.date,
    note: row.note,
    image: atts.find((a) => a.primary) ? atts.find((a) => a.primary).url : null,
    image_hash: row.image_name ? attHash(row.image_name) : '',
    attachments: atts,
    expect_end_date: row.expect_end_date || null,
    archived: !!row.archived,
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
