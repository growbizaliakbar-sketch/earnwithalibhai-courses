// Express session store backed by the `sessions` table (SQLite or Turso).
// Implements the express-session Store interface: get / set / destroy / touch.
// The db helpers are async; callbacks keep the Store contract intact.
'use strict';

const { Store } = require('express-session');
const db = require('./db');

function defaultExpiry(session) {
  return session.cookie && session.cookie.expires
    ? new Date(session.cookie.expires).getTime()
    : Date.now() + 1000 * 60 * 60 * 24 * 7;
}

class SQLiteStore extends Store {
  get(sid, cb) {
    db.get('SELECT data, expires FROM sessions WHERE session_id = ?', sid).then(
      (row) => {
        if (!row) return cb(null, null);
        if (row.expires <= Date.now()) {
          db.run('DELETE FROM sessions WHERE session_id = ?', sid).then(
            () => cb(null, null),
            cb
          );
          return;
        }
        try {
          cb(null, JSON.parse(row.data));
        } catch (err) {
          cb(err);
        }
      },
      cb
    );
  }

  set(sid, session, cb) {
    const expires = defaultExpiry(session);
    const data = JSON.stringify(session);
    db.run(
      `INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET expires = excluded.expires, data = excluded.data`,
      sid,
      expires,
      data
    ).then(() => cb(null), cb);
  }

  destroy(sid, cb) {
    db.run('DELETE FROM sessions WHERE session_id = ?', sid).then(() => cb(null), cb);
  }

  touch(sid, session, cb) {
    db.run('UPDATE sessions SET expires = ? WHERE session_id = ?', defaultExpiry(session), sid).then(
      () => cb(null),
      cb
    );
  }

  // Housekeeping: drop expired rows (called periodically from server.js).
  async prune() {
    try {
      await db.run('DELETE FROM sessions WHERE expires <= ?', Date.now());
    } catch (_) {
      // best-effort
    }
  }
}

module.exports = SQLiteStore;
