'use strict';
/* ============================================================================
   SQLite store adapter — implements the `store` interface the shared engine
   (shared/engine.js) talks to:
     get(table, id) / all(table) / put(table, row) / del(table, id) / flush()
   Built on node:sqlite (Node >= 22.13, no native compilation). The engine does
   application-level filtering/aggregation; this layer is a real SQLite
   database with parameterized SQL for every read and write.
   ============================================================================ */
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('');
  console.error('✖ node:sqlite is unavailable on this Node version.');
  console.error('  Kings Production needs Node 23.4+ (node:sqlite is built in and unflagged),');
  console.error('  or Node 22.13+ run with:  NODE_OPTIONS=--experimental-sqlite node server.js');
  console.error('');
  process.exit(1);
}
const path = require('node:path');
const fs = require('node:fs');

/* Every table with its exact column set. Column names come from this fixed
   map only — never from untrusted input — so the dynamic INSERT/REPLACE below
   cannot be injection points. */
const SCHEMA = {
  users: ['id', 'handle', 'email', 'displayName', 'passHash', 'bio', 'pfp', 'role', 'banned', 'banReason', 'timeoutUntil', 'totpSecret', 'totpEnabled', 'createdAt', 'updatedAt'],
  sessions: ['id', 'userId', 'label', 'createdAt', 'lastSeen', 'expiresAt'],
  assets: ['id', 'ownerId', 'title', 'category', 'description', 'price', 'fileName', 'fileMime', 'fileSize', 'status', 'rejectReason', 'sales', 'createdAt', 'updatedAt', 'approvedAt'],
  purchases: ['id', 'assetId', 'buyerId', 'price', 'licenseKey', 'gameId', 'gameName', 'createdAt'],
  comments: ['id', 'assetId', 'userId', 'body', 'createdAt'],
  reviews: ['id', 'assetId', 'userId', 'rating', 'body', 'createdAt', 'updatedAt'],
  reports: ['id', 'reporterId', 'targetType', 'targetId', 'reason', 'details', 'status', 'resolvedBy', 'resolvedAt', 'createdAt'],
  tokens: ['id', 'userId', 'token', 'purpose', 'expiresAt', 'used', 'createdAt'],
  emails: ['id', 'to', 'subject', 'action', 'body', 'link', 'createdAt', 'read'],
  portfolio: ['id', 'title', 'category', 'desc', 'stat', 'status'],
  creators: ['id', 'name', 'role', 'bio'],
};
/* Booleans are persisted as 0/1 integers and restored on read. */
const BOOLS = { users: ['banned', 'totpEnabled'], tokens: ['used'], emails: ['read'] };

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
  displayName TEXT NOT NULL, passHash TEXT NOT NULL, bio TEXT, pfp TEXT,
  role TEXT NOT NULL DEFAULT 'member', banned INTEGER NOT NULL DEFAULT 0, banReason TEXT,
  timeoutUntil INTEGER, totpSecret TEXT, totpEnabled INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, label TEXT,
  createdAt INTEGER NOT NULL, lastSeen INTEGER NOT NULL, expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
  description TEXT NOT NULL, price INTEGER NOT NULL, fileName TEXT, fileMime TEXT, fileSize INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', rejectReason TEXT, sales INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, approvedAt INTEGER
);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL, buyerId TEXT NOT NULL, price INTEGER NOT NULL,
  licenseKey TEXT NOT NULL, gameId TEXT, gameName TEXT, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL, userId TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL, userId TEXT NOT NULL, rating INTEGER NOT NULL,
  body TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  UNIQUE (assetId, userId)
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, reporterId TEXT NOT NULL, targetType TEXT NOT NULL, targetId TEXT NOT NULL,
  reason TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'open',
  resolvedBy TEXT, resolvedAt INTEGER, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, token TEXT NOT NULL, purpose TEXT NOT NULL,
  expiresAt INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY, "to" TEXT NOT NULL, subject TEXT NOT NULL, action TEXT,
  body TEXT, link TEXT, createdAt INTEGER NOT NULL, "read" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS portfolio (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT, "desc" TEXT, stat TEXT, status TEXT
);
CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, bio TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets (status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (userId);
CREATE INDEX IF NOT EXISTS idx_comments_asset ON comments (assetId);
CREATE INDEX IF NOT EXISTS idx_reviews_asset ON reviews (assetId);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);
CREATE INDEX IF NOT EXISTS idx_purchases_buyer ON purchases (buyerId);
`;

function createSqliteStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(DDL);

  function rowToObj(table, row) {
    if (!row) return null;
    const o = Object.assign({}, row);
    (BOOLS[table] || []).forEach(c => { o[c] = !!o[c]; });
    return o;
  }
  function objToRow(table, o) {
    const row = {};
    for (const c of SCHEMA[table]) {
      if (o[c] === undefined || o[c] === null) row[c] = null;
      else row[c] = (BOOLS[table] || []).includes(c) ? (o[c] ? 1 : 0) : o[c];
    }
    return row;
  }

  return {
    get(table, id) {
      const r = db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id);
      return rowToObj(table, r);
    },
    all(table) {
      const rs = db.prepare(`SELECT * FROM "${table}"`).all();
      return rs.map(r => rowToObj(table, r));
    },
    put(table, row) {
      const r = objToRow(table, row);
      const cols = SCHEMA[table];
      const sql = `INSERT OR REPLACE INTO "${table}" ("${cols.join('","')}") VALUES (${cols.map(() => '?').join(',')})`;
      db.prepare(sql).run(...cols.map(c => r[c]));
    },
    del(table, id) {
      db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
    },
    flush() { /* every put is already committed */ },
    close() { db.close(); },
  };
}

module.exports = { createSqliteStore };
