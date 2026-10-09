// Database layer — two modes, one async API.
//
// Local mode (default): node:sqlite file at data/app.db (WAL mode, FK enforcement).
//   Zero config — this is exactly the original behavior.
//
// Production mode: set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN for remote DBs)
//   to use Turso/libSQL instead. Same schema (libSQL is SQLite-compatible).
//
// All query helpers are async and MUST be awaited: get / all / run.
// `ready` resolves once the schema is in place; server.js waits for it before
// listening and exits with a clear message if the database is unreachable.
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');
const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbs');

const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const mode = TURSO_URL ? 'turso' : 'local';

// data/ always exists (dev mail outbox falls back to it); upload dirs only
// matter in local mode (production uploads go to R2 object storage).
fs.mkdirSync(DATA_DIR, { recursive: true });
if (mode === 'local') {
  for (const dir of [VIDEOS_DIR, THUMBS_DIR]) fs.mkdirSync(dir, { recursive: true });
}

let localDb = null;
let turso = null;

if (mode === 'local') {
  const { DatabaseSync } = require('node:sqlite');
  localDb = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
  localDb.exec('PRAGMA journal_mode = WAL;');
  localDb.exec('PRAGMA foreign_keys = ON;');
  localDb.exec('PRAGMA busy_timeout = 5000;');
} else {
  const { createClient } = require('@libsql/client');
  turso = createClient({
    url: TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student','admin')),
  status TEXT NOT NULL DEFAULT 'pending_verification'
    CHECK(status IN ('pending_verification','email_verified','active','disabled')),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify','set_password','reset')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  short_description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  price TEXT NOT NULL DEFAULT 'Free',
  thumbnail_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  video_path TEXT,
  external_video_url TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  is_free_preview INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, course_id)
);

CREATE TABLE IF NOT EXISTS lesson_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL,
  last_position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_modules_course ON modules(course_id, position);
CREATE INDEX IF NOT EXISTS idx_lessons_module ON lessons(module_id, position);
CREATE INDEX IF NOT EXISTS idx_enrollments_user ON enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_progress_user ON lesson_progress(user_id);
`;

function schemaStatements() {
  return SCHEMA.split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function describeUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.host || '(invalid URL)';
  } catch (_) {
    return '(invalid URL)';
  }
}

async function initSchema() {
  const stmts = schemaStatements();
  if (mode === 'local') {
    for (const s of stmts) localDb.exec(s);
    return;
  }
  try {
    await turso.execute('PRAGMA foreign_keys = ON');
  } catch (_) {
    // best-effort; some remotes ignore PRAGMA
  }
  await turso.batch(stmts.map((sql) => ({ sql, args: [] })));
}

// Resolves when the schema is ready. Rejects with a clear, credential-free
// message when the database cannot be reached (no stack dump to the user:
// server.js prints err.message and exits). A startup timeout keeps a hung
// network from blocking boot forever.
const STARTUP_TIMEOUT_MS = Number(process.env.DB_STARTUP_TIMEOUT_MS || 20000);

function tursoUnreachableError(detail) {
  return new Error(
    `Cannot reach the Turso database at ${describeUrl(TURSO_URL)} (${detail}). ` +
      'Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your environment.'
  );
}

const ready = (async () => {
  try {
    await Promise.race([
      initSchema(),
      new Promise((_, reject) =>
        setTimeout(() => reject(tursoUnreachableError('connection timed out')), STARTUP_TIMEOUT_MS).unref()
      ),
    ]);
  } catch (err) {
    if (mode === 'turso') {
      if (err && err.message && err.message.startsWith('Cannot reach the Turso database')) throw err;
      const detail = err && err.message ? err.message : String(err);
      throw tursoUnreachableError(detail);
    }
    throw err;
  }
})();

async function get(sql, ...params) {
  await ready;
  if (mode === 'local') return localDb.prepare(sql).get(...params);
  const r = await turso.execute({ sql, args: params });
  return r.rows[0];
}

async function all(sql, ...params) {
  await ready;
  if (mode === 'local') return localDb.prepare(sql).all(...params);
  const r = await turso.execute({ sql, args: params });
  return r.rows;
}

async function run(sql, ...params) {
  await ready;
  if (mode === 'local') {
    const info = localDb.prepare(sql).run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }
  const r = await turso.execute({ sql, args: params });
  return {
    changes: Number(r.rowsAffected || 0),
    lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : 0,
  };
}

async function close() {
  if (mode === 'local') {
    try {
      localDb.close();
    } catch (_) {}
  } else if (turso) {
    try {
      turso.close();
    } catch (_) {}
  }
}

function now() {
  return new Date().toISOString();
}

module.exports = {
  mode,
  ready,
  get,
  all,
  run,
  close,
  now,
  DATA_DIR,
  UPLOADS_DIR,
  VIDEOS_DIR,
  THUMBS_DIR,
};
