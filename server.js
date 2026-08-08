'use strict';
/* ============================================================================
   Kings Production — Node/Express backend
   ----------------------------------------------------------------------------
   Serves the single-file app (index.html) and the /api/* surface backed by
   the shared engine (shared/engine.js) over pluggable adapters:

     store — Turso (server/turso-store.js, free cloud SQLite) when TURSO_URL
             is set, otherwise local SQLite (server/sqlite-store.js)
     files — Cloudflare R2 (server/r2-files.js) when R2_* vars are set,
             otherwise local disk (server/disk-files.js)
     mail  — console + optional SMTP (server/mail.js)

   Run:  npm install && npm start        (Node >= 22.13)
   ============================================================================ */
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { createEngine } = require('./shared/engine.js');
const { createSqliteStore } = require('./server/sqlite-store.js');
const { createTursoStore } = require('./server/turso-store.js');
const { createR2Files } = require('./server/r2-files.js');
const { createMailer } = require('./server/mail.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = String(process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
const MAX_UPLOAD = 20 * 1024 * 1024;
const STORE_BACKEND = process.env.TURSO_URL ? 'turso' : 'sqlite';

async function main() {
  /* ---- adapters + engine ---- */
  const store = STORE_BACKEND === 'turso'
    ? await createTursoStore({ url: process.env.TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN })
    : createSqliteStore(path.join(DATA_DIR, 'kings.db'));
  if (store && store.ready) {
    try { await store.ready(); }
    catch (e) {
      console.error('✖ Could not connect to Turso. Check TURSO_URL / TURSO_AUTH_TOKEN:');
      console.error('  ' + (e && e.message || e));
      process.exit(1);
    }
  }
  const files = createR2Files({
    bucket: process.env.R2_BUCKET,
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    fallbackDir: UPLOAD_DIR,
  });
  const mail = createMailer({
    baseUrl: PUBLIC_URL,
    smtp: process.env.SMTP_HOST ? {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      secure: process.env.SMTP_SECURE === 'true',
    } : null,
  });
  const engine = createEngine({
    store,
    files,
    mail,
    config: {
      autoAdminFirstUser: process.env.AUTO_ADMIN !== 'false', // first registered user becomes Admin
      devMail: !process.env.SMTP_HOST, // expose reset links in API responses only when mail isn't configured
    },
  });

  /* ---- app ---- */
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' })); // profile pictures are base64 data URLs

  /* With a cloud store, wait until every pending write has landed in Turso
     before the client sees the response (the engine writes synchronously to
     its cache; the mirror to Turso drains here). */
  const send = async (res, r, okStatus) => {
    if (store && store.idle) { try { await store.idle(); } catch (e) { console.error('[store] idle failed:', e); } }
    res.status(r.ok ? (okStatus || 200) : 400).json(r);
  };
  const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('[api]', e);
    res.status(500).json({ ok: false, code: 'server', error: 'Internal server error.' });
  });

  /* ---- auth helpers ---- */
  function tokenFrom(req) {
    const header = req.get('authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
  }
  async function authUser(req) {
    const t = tokenFrom(req);
    if (!t) return null;
    const r = await engine.me(t);
    return r && r.ok ? r.data : null;
  }
  async function needAuth(req, res) {
    const u = await authUser(req);
    if (!u) {
      res.status(401).json({ ok: false, code: 'auth', error: 'You must be logged in to do that.' });
      return null;
    }
    return u;
  }
  function shortLabel(req) {
    const ua = req.get('user-agent') || '';
    const os = /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '';
    const br = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'Browser';
    return (br + (os ? ' on ' + os : '')).slice(0, 60);
  }

  /* ---- health ---- */
  app.get('/api/health', (req, res) => res.json({ ok: true, data: { name: 'Kings Production API', store: STORE_BACKEND, uptime: Math.round(process.uptime()) } }));

  /* ---- auth ---- */
  app.post('/api/auth/register', h(async (req, res) => send(res, await engine.register(req.body || {}))));
  app.post('/api/auth/login', h(async (req, res) => send(res, await engine.login({ ...(req.body || {}), label: shortLabel(req) }))));
  app.post('/api/auth/verify2fa', h(async (req, res) => send(res, await engine.verify2fa({ ...(req.body || {}), label: shortLabel(req) }))));
  app.post('/api/auth/request-reset', h(async (req, res) => send(res, await engine.requestReset(req.body || {}))));
  app.post('/api/auth/reset-password', h(async (req, res) => send(res, await engine.resetPassword(req.body || {}))));
  app.post('/api/auth/logout', h(async (req, res) => {
    const u = await authUser(req);
    if (u) await engine.logout(tokenFrom(req));
    send(res, { ok: true, data: true });
  }));
  app.get('/api/me', h(async (req, res) => send(res, await engine.me(tokenFrom(req)))));

  /* ---- profile & 2FA ---- */
  app.patch('/api/profile', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.updateProfile(u, req.body || {})); }));
  app.post('/api/auth/2fa/setup', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.setup2fa(u)); }));
  app.post('/api/auth/2fa/enable', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.enable2fa(u, req.body || {})); }));
  app.post('/api/auth/2fa/disable', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.disable2fa(u, req.body || {})); }));

  /* ---- assets ---- */
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });
  const bodyFile = req => (req.file ? { name: req.file.originalname, data: req.file.buffer, mime: req.file.mimetype, size: req.file.size } : null);

  app.get('/api/assets', h(async (req, res) => send(res, await engine.listApproved())));
  app.get('/api/assets/top', h(async (req, res) => send(res, await engine.topSelling(Number(req.query.n) || 6))));
  app.get('/api/assets/mine', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.myAssets(u)); }));
  app.get('/api/assets/:id', h(async (req, res) => { const u = await authUser(req); send(res, await engine.getAsset(req.params.id, u && u.id)); }));
  app.post('/api/assets', upload.single('file'), h(async (req, res) => {
    const u = await needAuth(req, res); if (!u) return;
    send(res, await engine.createAsset(u, {
      title: req.body.title, category: req.body.category, description: req.body.description, price: req.body.price,
      fileName: req.file && req.file.originalname, fileData: bodyFile(req),
    }));
  }));
  app.patch('/api/assets/:id', upload.single('file'), h(async (req, res) => {
    const u = await needAuth(req, res); if (!u) return;
    send(res, await engine.updateAsset(u, req.params.id, {
      title: req.body.title, category: req.body.category, description: req.body.description, price: req.body.price,
      fileName: req.file && req.file.originalname, fileData: bodyFile(req),
    }));
  }));
  app.delete('/api/assets/:id', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.deleteAsset(u, req.params.id)); }));
  app.get('/api/assets/:id/download', h(async (req, res) => {
    const u = await authUser(req);
    const r = await engine.download(u, req.params.id);
    if (!r.ok) return send(res, r);
    send(res, { ok: true, data: { fileName: r.data.fileName, size: r.data.size } });
  }));
  app.get('/api/assets/:id/file', h(async (req, res) => {
    const u = await authUser(req);
    const r = await engine.download(u, req.params.id);
    if (!r.ok) return send(res, r, 403);
    const f = await files.get(req.params.id);
    if (!f) return send(res, { ok: false, code: 'notfound', error: 'The file for this asset is missing.' });
    const safe = String(r.data.fileName || 'asset-file').replace(/[^\w.\- ]+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    res.setHeader('Content-Type', r.data.mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.data);
  }));
  app.post('/api/assets/:id/purchase', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.purchase(u, req.params.id)); }));

  /* ---- comments ---- */
  app.get('/api/assets/:id/comments', h(async (req, res) => send(res, await engine.listComments(req.params.id))));
  app.post('/api/assets/:id/comments', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.addComment(u, req.params.id, (req.body || {}).body)); }));

  /* ---- reviews & ratings ---- */
  app.get('/api/assets/:id/reviews', h(async (req, res) => send(res, await engine.listReviews(req.params.id))));
  app.post('/api/assets/:id/reviews', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.addReview(u, req.params.id, req.body || {})); }));
  app.delete('/api/reviews/:id', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.deleteReview(u, req.params.id)); }));

  /* ---- reports ---- */
  app.post('/api/reports', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.createReport(u, req.body || {})); }));

  /* ---- purchases & licenses ---- */
  app.get('/api/purchases/mine', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.myPurchases(u)); }));
  app.post('/api/licenses/assign', h(async (req, res) => {
    const u = await needAuth(req, res); if (!u) return;
    const b = req.body || {};
    send(res, await engine.assignLicense(u, b.purchaseId, { gameId: b.gameId, gameName: b.gameName }));
  }));

  /* ---- profiles & content ---- */
  app.get('/api/profile/:handle', h(async (req, res) => send(res, await engine.publicProfile(req.params.handle))));
  app.get('/api/site/content', h(async (req, res) => send(res, await engine.content())));

  /* ---- admin (auth + role check enforced inside the engine) ---- */
  const admin = fn => h(async (req, res) => {
    const u = await needAuth(req, res);
    if (!u) return;
    send(res, await fn(u, req));
  });
  app.get('/api/admin/overview', admin(async u => engine.adminOverview(u)));
  app.get('/api/admin/approvals', admin(async u => {
    const p = await engine.adminPending(u);
    const r = await engine.adminRejected(u);
    if (!p.ok) return p;
    if (!r.ok) return r;
    return { ok: true, data: { pending: p.data, rejected: r.data } };
  }));
  app.post('/api/admin/approvals/:id/approve', admin(async (u, req) => engine.adminApprove(u, req.params.id)));
  app.post('/api/admin/approvals/:id/reject', admin(async (u, req) => engine.adminReject(u, req.params.id, (req.body || {}).reason)));
  app.get('/api/admin/assets', admin(async u => engine.adminAssets(u)));
  app.delete('/api/admin/assets/:id', admin(async (u, req) => engine.adminDeleteAsset(u, req.params.id)));
  app.get('/api/admin/users', admin(async u => engine.adminUsers(u)));
  app.post('/api/admin/users/:id/ban', admin(async (u, req) => engine.adminBan(u, req.params.id, (req.body || {}).reason)));
  app.post('/api/admin/users/:id/unban', admin(async (u, req) => engine.adminUnban(u, req.params.id)));
  app.post('/api/admin/users/:id/timeout', admin(async (u, req) => engine.adminTimeout(u, req.params.id, (req.body || {}).minutes)));
  app.post('/api/admin/users/:id/clear-timeout', admin(async (u, req) => engine.adminClearTimeout(u, req.params.id)));
  app.post('/api/admin/users/:id/role', admin(async (u, req) => engine.adminSetRole(u, req.params.id, (req.body || {}).role)));
  app.get('/api/admin/sessions', admin(async u => engine.adminSessions(u)));
  app.get('/api/admin/emails', admin(async u => engine.adminEmails(u)));
  app.get('/api/admin/reports', admin(async u => engine.adminReports(u)));
  app.post('/api/admin/reports/:id/resolve', admin(async (u, req) => engine.adminResolveReport(u, req.params.id)));

  /* ---- the app (single-file SPA) ---- */
  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

  /* ---- multer errors (e.g. oversized uploads) ---- */
  app.use((err, req, res, next) => {
    if (err && err.name === 'MulterError') {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 20 MB).'
        : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Unexpected file field — expected a single "file" upload.'
        : 'Invalid file upload.';
      return res.status(400).json({ ok: false, code: 'invalid', error: msg });
    }
    next(err);
  });

  /* ---- 404 for unknown API routes ---- */
  app.use('/api', (req, res) => res.status(404).json({ ok: false, code: 'notfound', error: 'Unknown API route.' }));

  const server = app.listen(PORT, () => {
    console.log('┌──────────────────────────────────────────────┐');
    console.log('│  KINGS PRODUCTION  ·  Node/Express backend   │');
    console.log('└──────────────────────────────────────────────┘');
    console.log(`  App:     ${PUBLIC_URL}`);
    console.log(`  API:     ${PUBLIC_URL}/api/health`);
    console.log(`  DB:      ${STORE_BACKEND}${STORE_BACKEND === 'turso' ? ` (${process.env.TURSO_URL})` : ` → ${path.join(DATA_DIR, 'kings.db')}`}`);
    console.log(`  Uploads: ${process.env.R2_BUCKET ? `R2 bucket "${process.env.R2_BUCKET}"` : `local disk → ${UPLOAD_DIR}`}`);
    console.log(`  AUTO_ADMIN (first registered user → Admin): ${process.env.AUTO_ADMIN !== 'false'}`);
    console.log(`  SMTP:    ${process.env.SMTP_HOST ? 'configured' : 'off (emails go to the Admin → Mailbox + console)'}`);
  });

  function shutdown() {
    console.log('\nShutting down…');
    server.close(async () => {
      try { await store.close(); } catch (e) {}
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  console.error('✖ Failed to start:');
  console.error(e && e.stack || e);
  process.exit(1);
});
