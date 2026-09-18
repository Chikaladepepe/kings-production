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
  users: ['id', 'handle', 'email', 'displayName', 'passHash', 'bio', 'pfp', 'role', 'banned', 'banReason', 'timeoutUntil', 'restrictedUntil', 'restrictReason', 'totpSecret', 'totpEnabled', 'country', 'tags', 'googleId', 'acceptedTermsAt', 'emailVerified', 'unsubscribed', 'needsPasswordSetup', 'protectionTier', 'contractTier', 'createdAt', 'updatedAt'],
  sessions: ['id', 'userId', 'label', 'createdAt', 'lastSeen', 'expiresAt'],
  assets: ['id', 'ownerId', 'title', 'category', 'description', 'price', 'fileName', 'fileMime', 'fileSize', 'fileUrl', 'imageUrl', 'images', 'paymentMethods', 'sellerPaymentDetails', 'deliverDuringPending', 'status', 'rejectReason', 'sales', 'createdAt', 'updatedAt', 'approvedAt'],
  purchases: ['id', 'assetId', 'buyerId', 'price', 'licenseKey', 'gameId', 'gameName', 'status', 'activatedAt', 'deviceId', 'deviceName', 'lastSeen', 'createdAt'],
  comments: ['id', 'assetId', 'userId', 'body', 'rating', 'createdAt'],
  likes: ['id', 'assetId', 'userId', 'createdAt'],
  devices: ['id', 'purchaseId', 'assetId', 'deviceId', 'deviceName', 'status', 'createdAt', 'lastSeen'],
  reviews: ['id', 'assetId', 'userId', 'rating', 'body', 'createdAt', 'updatedAt'],
  reports: ['id', 'reporterId', 'targetType', 'targetId', 'reason', 'details', 'status', 'resolvedBy', 'resolvedAt', 'createdAt'],
  tokens: ['id', 'userId', 'token', 'purpose', 'expiresAt', 'used', 'createdAt'],
  pending_regs: ['id', 'email', 'code', 'expiresAt', 'createdAt'],
  emails: ['id', 'to', 'subject', 'action', 'body', 'link', 'createdAt', 'read'],
  portfolio: ['id', 'title', 'category', 'desc', 'stat', 'status', 'imageUrl', 'images', 'links', 'featured', 'createdAt'],
  creators: ['id', 'name', 'role', 'bio', 'docs', 'links', 'handle', 'imageUrl', 'createdAt'],
  orders: ['id', 'buyerId', 'assetId', 'method', 'amount', 'currency', 'status', 'providerRef', 'licenseKey', 'gameDetails', 'sellerId', 'approval', 'approvalNote', 'createdAt', 'paidAt', 'updatedAt'],
  tickets: ['id', 'userId', 'subject', 'category', 'details', 'status', 'createdAt', 'updatedAt', 'lastActivityAt'],
  ticket_messages: ['id', 'ticketId', 'userId', 'body', 'createdAt'],
  announcements: ['id', 'title', 'body', 'link', 'style', 'active', 'createdAt', 'updatedAt'],
  systems: ['id', 'userId', 'name', 'password', 'status', 'staffNote', 'pausedBy', 'pauseExpiresAt', 'kickOnDeny', 'banOnBlacklist', 'createdAt', 'updatedAt', 'lastSeenAt'],
  system_devices: ['id', 'systemId', 'deviceId', 'deviceName', 'status', 'createdAt', 'lastSeenAt'],
  system_games: ['id', 'systemId', 'placeId', 'status', 'gameName', 'gameOwner', 'gameOwnerType', 'createdAt', 'lastSeenAt'],
  sub_revokes: ['id', 'actorId', 'targetId', 'reason', 'prevProtection', 'prevContract', 'status', 'resolvedBy', 'resolvedAt', 'createdAt'],
  mail_blasts: ['id', 'subject', 'body', 'recipients', 'status', 'scheduledFor', 'createdAt', 'updatedAt', 'sentAt'],
  mail_inbound: ['id', 'email', 'event', 'subject', 'body', 'detail', 'createdAt'],
};
/* Booleans are persisted as 0/1 integers and restored on read. */
const BOOLS = { users: ['banned', 'totpEnabled', 'emailVerified', 'unsubscribed'], tokens: ['used'], emails: ['read'], portfolio: ['featured'], announcements: ['active'] };

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
  displayName TEXT NOT NULL, passHash TEXT NOT NULL, bio TEXT, pfp TEXT,
  role TEXT NOT NULL DEFAULT 'member', banned INTEGER NOT NULL DEFAULT 0, banReason TEXT,
  timeoutUntil INTEGER, totpSecret TEXT, totpEnabled INTEGER NOT NULL DEFAULT 0,
  country TEXT, tags TEXT, googleId TEXT, acceptedTermsAt INTEGER, emailVerified INTEGER NOT NULL DEFAULT 1,
  protectionTier INTEGER NOT NULL DEFAULT 0, contractTier INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, label TEXT,
  createdAt INTEGER NOT NULL, lastSeen INTEGER NOT NULL, expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
  description TEXT NOT NULL, price INTEGER NOT NULL, fileName TEXT, fileMime TEXT, fileSize INTEGER,
  imageUrl TEXT, status TEXT NOT NULL DEFAULT 'pending', rejectReason TEXT, sales INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, approvedAt INTEGER
);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL, buyerId TEXT NOT NULL, price INTEGER NOT NULL,
  licenseKey TEXT NOT NULL, gameId TEXT, gameName TEXT,
  status TEXT NOT NULL DEFAULT 'active', activatedAt INTEGER, deviceId TEXT, deviceName TEXT, lastSeen INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL, userId TEXT NOT NULL, body TEXT NOT NULL,
  rating INTEGER, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL, userId TEXT NOT NULL, createdAt INTEGER NOT NULL,
  UNIQUE (assetId, userId)
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, purchaseId TEXT NOT NULL, assetId TEXT NOT NULL, deviceId TEXT NOT NULL,
  deviceName TEXT, status TEXT NOT NULL DEFAULT 'active', createdAt INTEGER NOT NULL, lastSeen INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS pending_regs (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, code TEXT NOT NULL,
  expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY, "to" TEXT NOT NULL, subject TEXT NOT NULL, action TEXT,
  body TEXT, link TEXT, createdAt INTEGER NOT NULL, "read" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS portfolio (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT, "desc" TEXT, stat TEXT, status TEXT,
  imageUrl TEXT, images TEXT, links TEXT, featured INTEGER NOT NULL DEFAULT 0, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, bio TEXT, imageUrl TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, buyerId TEXT NOT NULL, assetId TEXT NOT NULL,
  method TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'PHP',
  status TEXT NOT NULL DEFAULT 'created', providerRef TEXT, licenseKey TEXT,
  gameDetails TEXT, sellerId TEXT, approval TEXT, approvalNote TEXT,
  createdAt INTEGER NOT NULL, paidAt INTEGER, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, subject TEXT NOT NULL, category TEXT,
  details TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastActivityAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id TEXT PRIMARY KEY, ticketId TEXT NOT NULL, userId TEXT NOT NULL, body TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, link TEXT,
  style TEXT NOT NULL DEFAULT 'gold', active INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS systems (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', staffNote TEXT, pausedBy TEXT, pauseExpiresAt INTEGER,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastSeenAt INTEGER
);
CREATE TABLE IF NOT EXISTS system_devices (
  id TEXT PRIMARY KEY, systemId TEXT NOT NULL, deviceId TEXT NOT NULL, deviceName TEXT,
  status TEXT NOT NULL DEFAULT 'active', createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS system_games (
  id TEXT PRIMARY KEY, systemId TEXT NOT NULL, placeId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_blasts (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL,
  recipients TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  scheduledFor INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, sentAt INTEGER
);
CREATE TABLE IF NOT EXISTS mail_inbound (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, event TEXT NOT NULL,
  subject TEXT, body TEXT, detail TEXT, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, assetId TEXT NOT NULL, buyerId TEXT, sellerId TEXT NOT NULL,
  userId TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_asset ON chats (assetId);
CREATE INDEX IF NOT EXISTS idx_mail_blasts_status ON mail_blasts (status);
CREATE INDEX IF NOT EXISTS idx_mail_inbound_email ON mail_inbound (email);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders (buyerId);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets (status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (userId);
CREATE INDEX IF NOT EXISTS idx_comments_asset ON comments (assetId);
CREATE INDEX IF NOT EXISTS idx_reviews_asset ON reviews (assetId);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);
CREATE INDEX IF NOT EXISTS idx_purchases_buyer ON purchases (buyerId);
CREATE INDEX IF NOT EXISTS idx_likes_asset ON likes (assetId);
CREATE INDEX IF NOT EXISTS idx_devices_asset ON devices (assetId);
CREATE INDEX IF NOT EXISTS idx_systems_user ON systems (userId);
CREATE INDEX IF NOT EXISTS idx_system_devices_system ON system_devices (systemId);
CREATE INDEX IF NOT EXISTS idx_system_games_system ON system_games (systemId);
`;

function createSqliteStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(DDL);
  runMigrations(db);
  ticketCleanup(db);

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
    /* Health/integrity snapshot for the Founder Panel status tab. */
    stats({ uploadsDir } = {}) {
      let dbBytes = null, walBytes = null, tables = 0, rows = 0, integrity = null;
      try {
        const vr = db.prepare('PRAGMA integrity_check').get();
        integrity = vr && (vr.integrity_check || vr['integrity_check(1)']) || 'ok';
      } catch (e) { integrity = 'unavailable'; }
      try {
        const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        tables = t.length;
        t.forEach(x => { try { const c = db.prepare(`SELECT COUNT(*) AS n FROM "${x.name}"`).get(); rows += c.n; } catch (e) {} });
      } catch (e) {}
      try {
        const ps = db.prepare('PRAGMA page_count').get();
        const pz = db.prepare('PRAGMA page_size').get();
        if (ps && pz) dbBytes = ps.page_count * pz.page_size;
        const wal = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      } catch (e) {}
      try { const w = fs.statSync(file + '-wal'); walBytes = w.size; } catch (e) {}
      let uploadsBytes = null, uploadsCount = null;
      if (uploadsDir) {
        try { uploadsCount = fs.readdirSync(uploadsDir).length; } catch (e) {}
        try {
          uploadsBytes = 0;
          const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else uploadsBytes += fs.statSync(p).size;
          });
          walk(uploadsDir);
        } catch (e) { if (uploadsBytes === 0) uploadsBytes = null; }
      }
      return { dbBytes, walBytes, tables, rows, integrity, uploadsBytes, uploadsCount };
    },
    close() { db.close(); },
  };
}

/* Optional ALTERs for databases created before new columns were added. */
const MIGRATIONS = [
  "ALTER TABLE users ADD COLUMN country TEXT",
  "ALTER TABLE assets ADD COLUMN imageUrl TEXT",
  "ALTER TABLE comments ADD COLUMN rating INTEGER",
  "ALTER TABLE purchases ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
  "ALTER TABLE purchases ADD COLUMN activatedAt INTEGER",
  "ALTER TABLE purchases ADD COLUMN deviceId TEXT",
  "ALTER TABLE purchases ADD COLUMN deviceName TEXT",
  "ALTER TABLE purchases ADD COLUMN lastSeen INTEGER",
  "ALTER TABLE portfolio ADD COLUMN imageUrl TEXT",
  "ALTER TABLE portfolio ADD COLUMN links TEXT",
  "ALTER TABLE portfolio ADD COLUMN createdAt INTEGER",
  "ALTER TABLE portfolio ADD COLUMN featured INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN tags TEXT",
  "ALTER TABLE users ADD COLUMN googleId TEXT",
  "ALTER TABLE users ADD COLUMN acceptedTermsAt INTEGER",
  "ALTER TABLE creators ADD COLUMN links TEXT",
  "ALTER TABLE creators ADD COLUMN handle TEXT",
  "ALTER TABLE creators ADD COLUMN createdAt INTEGER",
  "ALTER TABLE users ADD COLUMN emailVerified INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE users ADD COLUMN unsubscribed INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN protectionTier INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN contractTier INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN restrictedUntil INTEGER",
  "ALTER TABLE users ADD COLUMN restrictReason TEXT",
  "ALTER TABLE orders ADD COLUMN gameDetails TEXT",
  "ALTER TABLE orders ADD COLUMN sellerId TEXT",
  "ALTER TABLE orders ADD COLUMN approval TEXT",
  "ALTER TABLE orders ADD COLUMN approvalNote TEXT",
  "ALTER TABLE creators ADD COLUMN imageUrl TEXT",
  "ALTER TABLE assets ADD COLUMN images TEXT",
  "ALTER TABLE assets ADD COLUMN paymentMethods TEXT",
  "ALTER TABLE assets ADD COLUMN sellerPaymentDetails TEXT",
  "ALTER TABLE assets ADD COLUMN deliverDuringPending INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE assets ADD COLUMN fileUrl TEXT",
  "ALTER TABLE systems ADD COLUMN kickOnDeny INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE systems ADD COLUMN banOnBlacklist INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE creators ADD COLUMN docs TEXT",
  "ALTER TABLE users ADD COLUMN needsPasswordSetup INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE portfolio ADD COLUMN images TEXT",
  "ALTER TABLE system_games ADD COLUMN gameName TEXT",
  "ALTER TABLE system_games ADD COLUMN gameOwner TEXT",
  "ALTER TABLE system_games ADD COLUMN gameOwnerType TEXT",
  "CREATE TABLE IF NOT EXISTS sub_revokes (id TEXT PRIMARY KEY, actorId TEXT, targetId TEXT, reason TEXT, prevProtection INTEGER, prevContract INTEGER, status TEXT NOT NULL DEFAULT 'pending', resolvedBy TEXT, resolvedAt INTEGER, createdAt INTEGER NOT NULL)",
  "ALTER TABLE systems ADD COLUMN staffNote TEXT",
  "ALTER TABLE systems ADD COLUMN pausedBy TEXT",
  "ALTER TABLE systems ADD COLUMN pauseExpiresAt INTEGER",
  "ALTER TABLE ticket_messages ADD COLUMN kind TEXT",
  "ALTER TABLE ticket_messages ADD COLUMN actorName TEXT",
  "CREATE TABLE IF NOT EXISTS site_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER)",
  "CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, assetId TEXT NOT NULL, buyerId TEXT, sellerId TEXT NOT NULL, userId TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_chats_asset ON chats (assetId)",
];
function ticketCleanup(db) {
  const cutoff = Date.now() - 5 * 24 * 3600 * 1000;
  try {
    const toDelete = db.prepare('SELECT id FROM tickets WHERE lastActivityAt < ? AND status = ?').all(cutoff, 'closed');
    for (const row of toDelete) {
      db.prepare('DELETE FROM ticket_messages WHERE ticketId = ?').run(row.id);
      db.prepare('DELETE FROM tickets WHERE id = ?').run(row.id);
    }
  } catch (e) { /* best effort */ }
}
function runMigrations(db) {
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { /* duplicate column — already migrated */ }
  }
}

module.exports = { createSqliteStore, SCHEMA, BOOLS, DDL, MIGRATIONS, runMigrations, ticketCleanup };
