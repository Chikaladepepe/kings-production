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
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { createEngine } = require('./shared/engine.js');
const { createSqliteStore } = require('./server/sqlite-store.js');
const { createTursoStore } = require('./server/turso-store.js');
const { createR2Files } = require('./server/r2-files.js');
const { createMailer } = require('./server/mail.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000; // treats PORT=0 as unset so a stray empty env value can't bind a random port
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
    logoUrl: process.env.MAIL_LOGO_URL || (PUBLIC_URL + '/logo.png'),
    smtp: process.env.SMTP_HOST ? {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      secure: process.env.SMTP_SECURE === 'true',
      from: process.env.SMTP_FROM || null,
    } : null,
  });
  /* Live exchange rates (USD base) refreshed from a free API; falls back to
     the engine's static table when offline. Used for regional pricing. */
  let liveFx = null;
  async function refreshFx() {
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j && j.result === 'success' && j.rates) {
        liveFx = j.rates;
        if (engine && engine.setFx) engine.setFx(j.rates);
      }
    } catch (e) { /* keep last good rates */ }
  }

  const engine = createEngine({
    store,
    files,
    mail,
    config: {
      autoAdminFirstUser: process.env.AUTO_ADMIN !== 'false', // first registered user becomes Admin
      devMail: !process.env.SMTP_HOST, // expose reset links in API responses only when mail isn't configured
      currency: process.env.PAYMENT_CURRENCY || 'USD', // checkout base currency (USD)
      priceMultiplier: Number(process.env.PRICE_MULTIPLIER || 1), // price-unit → currency rate
      fx: liveFx || undefined, // live USD→X rates (engine falls back to its static table)
    },
  });
  refreshFx();
  setInterval(refreshFx, 6 * 36e5).unref();
  /* Fire due scheduled email blasts every 30s (drafts + scheduling are stored
     in the DB, so pending blasts survive restarts). */
  if (engine.processScheduledBlasts) {
    try { engine.processScheduledBlasts(); } catch (e) { console.error('[blast] boot sweep failed:', e && e.message || e); }
    setInterval(() => { try { engine.processScheduledBlasts(); } catch (e) { console.error('[blast] sweep failed:', e && e.message || e); } }, 30e3).unref();
  }
  if (engine.processAdminPauseExpiry) {
    try { engine.processAdminPauseExpiry(); } catch (e) { console.error('[pause] boot sweep failed:', e && e.message || e); }
    setInterval(() => { try { engine.processAdminPauseExpiry(); } catch (e) { console.error('[pause] sweep failed:', e && e.message || e); } }, 60e3).unref();
  }

  /* ---- payments (Stripe · PayPal · GCash via PayMongo) ----
     Enabled by env keys; when none are set the checkout runs in dev/test
     mode and completes instantly without moving money. */
  const PAYMENT = {
    currency: process.env.PAYMENT_CURRENCY || 'PHP',
    stripe: process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null,
    paypal: (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) ? { id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET } : null,
    paymongo: process.env.PAYMONGO_SECRET_KEY || null,
  };
  PAYMENT.dev = !(PAYMENT.stripe || PAYMENT.paypal || PAYMENT.paymongo);
  /* Live by default; set PAYPAL_ENV=sandbox to test against the sandbox API
     (sandbox Client ID + Secret from developer.paypal.com). */
  const PAYPAL_BASE = process.env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

  async function paypalToken() {
    const cred = Buffer.from(`${PAYMENT.paypal.id}:${PAYMENT.paypal.secret}`).toString('base64');
    const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${cred}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const j = await r.json();
    return j.access_token;
  }
  async function paypalCreateOrder(amount, currency, title, orderId) {
    const token = await paypalToken();
    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: orderId, description: String(title).slice(0, 120), amount: { currency_code: currency, value: Number(amount).toFixed(2) } }],
        application_context: {
          brand_name: 'Kings Production',
          user_action: 'PAY_NOW',
          return_url: PUBLIC_URL + '/#/subscription?paid=1',
          cancel_url: PUBLIC_URL + '/#/subscription',
        },
      }),
    });
    const j = await r.json();
    const approve = j.links && j.links.find(l => l.rel === 'approve');
    return { id: j.id, url: approve ? approve.href : null };
  }
  async function paypalCapture(providerOrderId) {
    const token = await paypalToken();
    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${providerOrderId}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const j = await r.json();
    return j.status === 'COMPLETED';
  }
  const pmAuth = () => `Basic ${Buffer.from(PAYMENT.paymongo + ':').toString('base64')}`;
  async function paymongoCreateSource(amount, currency, title, orderId) {
    const r = await fetch('https://api.paymongo.com/v1/sources', {
      method: 'POST',
      headers: { Authorization: pmAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { attributes: {
        amount: amount * 100, currency: currency.toLowerCase(), type: 'gcash',
        redirect: { success: PUBLIC_URL + '/#/subscription?paid=1', failed: PUBLIC_URL + '/#/subscription' },
        metadata: { order_id: orderId },
      } } }),
    });
    const j = await r.json();
    const attrs = j.data && j.data.attributes || {};
    return { id: j.data && j.data.id, url: attrs.redirect && attrs.redirect.checkout_url };
  }
  async function paymongoCharged(sourceId) {
    const r = await fetch(`https://api.paymongo.com/v1/sources/${sourceId}`, { headers: { Authorization: pmAuth() } });
    const j = await r.json();
    return !!(j.data && j.data.attributes && j.data.attributes.status === 'charged');
  }

  /* ---- app ---- */
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Render's proxy — use the real client IP
  /* Stripe webhook must receive the RAW body for signature verification —
     register it before the global JSON parser. */
  app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      if (!PAYMENT.stripe) return res.status(400).json({ ok: false, error: 'Stripe is not configured.' });
      const sig = req.headers['stripe-signature'];
      let evt;
      try { evt = PAYMENT.stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
      catch (e) { return res.status(400).json({ ok: false, error: 'Invalid Stripe signature.' }); }
      if (evt.type === 'checkout.session.completed') {
        const orderId = evt.data.object.metadata && evt.data.object.metadata.orderId;
        if (orderId) {
          const r = await engine.settleOrder(orderId, evt.data.object.id);
          if (!r.ok) console.error('[stripe] settle failed:', r.error);
        }
      }
      res.json({ ok: true, received: true });
    } catch (e) { console.error('[stripe webhook]', e); res.status(500).json({ ok: false }); }
  });
  app.use(express.json({ limit: '4mb' })); // profile pictures are base64 data URLs

  /* ---- image proxy: make "page" URLs work as images (imgur.com/abc → the
     direct image) and bypass hotlink blocks for supported hosts.
     Route handler registered after the `h` helper is defined, below. ---- */
  const IMG_HOSTS = /^https?:\/\/(i\.imgur\.com|imgur\.com|media\.discordapp\.net|cdn\.discordapp\.com|i\.redd\.it|preview\.redd\.it|pbs\.twimg\.com|i\.ibb\.co|files\.catbox\.moe|litter\.catbox\.moe|gcdnb\.pbrd\.co|i\.imgsli\.com|i\.postimg\.cc|i\.pixhost\.to)\//i;
  const imgCache = new Map(); // url → { t, mime, buf }

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

  /* ---- /api/img handler (uses h + IMG_HOSTS defined above) ---- */
  app.get('/api/img', h(async (req, res) => {
    const raw = String(req.query.u || '');
    let url;
    try { url = new URL(raw); } catch (e) { return res.status(400).json({ ok: false, error: 'Bad url.' }); }
    if (!/^https?:$/.test(url.protocol) || !IMG_HOSTS.test(raw)) return res.status(400).json({ ok: false, error: 'Host not allowed.' });
    const hit = imgCache.get(raw);
    if (hit && Date.now() - hit.t < 300000) {
      res.setHeader('Content-Type', hit.mime); res.setHeader('Cache-Control', 'public, max-age=300');
      return res.end(hit.buf);
    }
    const fetchImage = async u => {
      const upstream = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': new URL(u).origin + '/' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
      if (!upstream.ok) throw new Error('upstream ' + upstream.status);
      return upstream;
    };
    try {
      let upstream = await fetchImage(raw);
      let mime = upstream.headers.get('content-type') || 'image/jpeg';
      /* A "page" URL (imgur album/gallery) returns HTML — pull the og:image
         meta tag and fetch THAT image instead. */
      if (/text\/html/i.test(mime)) {
        const html = await upstream.text();
        const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
          || html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
        if (!m) throw new Error('no image found on page');
        const imgUrl = m[1].replace(/&amp;/g, '&');
        if (!IMG_HOSTS.test(imgUrl)) throw new Error('extracted image not allowed');
        upstream = await fetchImage(imgUrl);
        mime = upstream.headers.get('content-type') || 'image/jpeg';
      }
      if (!/^image\//i.test(mime)) throw new Error('not an image');
      const ab = await upstream.arrayBuffer();
      if (ab.byteLength > 8 * 1024 * 1024) throw new Error('too large');
      const buf = Buffer.from(ab);
      if (imgCache.size > 120) imgCache.clear();
      imgCache.set(raw, { t: Date.now(), mime, buf });
      res.setHeader('Content-Type', mime); res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(buf);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Image fetch failed.' });
    }
  }));
  /* Throttle the public license-check endpoints the Roblox script calls, so a
     leaked script or a brute-force attempt can't hammer the API. Roblox
     servers share egress IPs, so keep the limit generous: 60/min per IP. */
  const sysHits = new Map();
  const rateLimitSystems = (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '?'; // 'trust proxy' makes req.ip the real client
    const now = Date.now();
    const arr = (sysHits.get(ip) || []).filter(t => now - t < 60000);
    if (arr.length >= 60) {
      if (engine.recordSecurityEvent) engine.recordSecurityEvent('rate_limited', { ip, path: req.path });
      return res.status(429).json({ ok: false, code: 'rate', error: 'Too many requests — try again shortly.' });
    }
    arr.push(now);
    sysHits.set(ip, arr);
    next();
  };

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
      if (engine.recordSecurityEvent && req.get('authorization')) engine.recordSecurityEvent('auth_fail', { ip: req.ip || '?', path: req.path.slice(0, 60) });
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
  app.post('/api/auth/register-code', h(async (req, res) => send(res, await engine.requestRegisterCode(req.body || {}))));
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
  app.post('/api/auth/verify-email', h(async (req, res) => send(res, await engine.verifyEmail(req.body || {}))));
  app.post('/api/auth/resend-verify', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.resendVerification(u)); }));

  /* ---- announcements (public read; admin writes below) ---- */
  app.get('/api/announcements', h(async (req, res) => send(res, await engine.listAnnouncements())));

  /* ---- Sign in with Google (enabled by GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET) ---- */
  const GOOGLE = {
    clientId: process.env.GOOGLE_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
    get enabled() { return !!(this.clientId && this.clientSecret); },
  };
  const googleStates = new Map(); // state -> { exp }  (CSRF protection)
  app.get('/api/auth/google/config', (req, res) => res.json({ ok: true, data: { enabled: GOOGLE.enabled } }));
  app.get('/api/auth/google', (req, res) => {
    if (!GOOGLE.enabled) return res.status(400).json({ ok: false, code: 'config', error: 'Google sign-in is not configured yet.' });
    const state = crypto.randomBytes(18).toString('hex');
    googleStates.set(state, { exp: Date.now() + 5 * 6e4 });
    const params = new URLSearchParams({
      client_id: GOOGLE.clientId,
      redirect_uri: PUBLIC_URL + '/api/auth/google/callback',
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
  });
  app.get('/api/auth/google/callback', h(async (req, res) => {
    const failRedirect = msg => res.redirect(PUBLIC_URL + '/#/login?google=err&msg=' + encodeURIComponent(msg || 'Google sign-in failed.'));
    const { code, state, error } = req.query;
    if (error || !code) return failRedirect(error || 'Google sign-in was cancelled.');
    const st = googleStates.get(String(state || ''));
    googleStates.delete(String(state || ''));
    if (!st || st.exp < Date.now()) return failRedirect('That sign-in link expired — please try again.');
    try {
      const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(code),
          client_id: GOOGLE.clientId,
          client_secret: GOOGLE.clientSecret,
          redirect_uri: PUBLIC_URL + '/api/auth/google/callback',
          grant_type: 'authorization_code',
        }).toString(),
      });
      const tj = await tr.json();
      if (!tj.access_token) return failRedirect('Google did not approve the sign-in.');
      const ir = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: 'Bearer ' + tj.access_token } });
      const info = await ir.json();
      if (!info || !info.email) return failRedirect('Google did not return a profile.');
      const r = await engine.googleLogin({ googleId: String(info.sub || ''), email: info.email, displayName: info.name || info.given_name || null, picture: info.picture || null });
      if (!r.ok) return failRedirect(r.error);
      const needPw = r.data.user && r.data.user.needsPasswordSetup ? '&pw=1' : '';
      return res.redirect(PUBLIC_URL + '/#/login?google=1' + needPw + '&token=' + encodeURIComponent(r.data.token));
    } catch (e) {
      console.error('[google] callback error:', e);
      return failRedirect('Google sign-in hit a server error — please try again.');
    }
  }));

  /* ---- profile & 2FA ---- */
  app.patch('/api/profile', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.updateProfile(u, req.body || {})); }));
  app.post('/api/auth/2fa/setup', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.setup2fa(u)); }));
  app.post('/api/auth/2fa/enable', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.enable2fa(u, req.body || {})); }));
  app.post('/api/auth/2fa/disable', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.disable2fa(u, req.body || {})); }));

  /* ---- assets ---- */
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });
  const bodyFile = req => (req.file ? { name: req.file.originalname, data: req.file.buffer, mime: req.file.mimetype, size: req.file.size } : null);

  /* ---- image upload proxy (Catbox default · Imgur · ImgBB) ----
     Sellers pick a local file; the server forwards it to the configured host
     and returns the hosted URL. The database keeps only the URL — no image
     bytes are ever stored. Catbox needs no key or account at all. */
  const imgUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  app.post('/api/upload-image', imgUpload.single('image'), h(async (req, res) => {
    const u = await needAuth(req, res); if (!u) return;
    if (!req.file) return send(res, { ok: false, code: 'invalid', error: 'Choose an image file first (png, jpg, gif, webp — up to 10 MB).' });
    const MIME_OK = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!MIME_OK.includes(req.file.mimetype)) return send(res, { ok: false, code: 'invalid', error: 'Only png, jpg, gif and webp images are supported.' });
    const s = await engine.getImgurSettings();
    const cfgd = (s.ok && s.data) || {};
    const provider = cfgd.provider || 'catbox';
    try {
      let link = null, extra = {};
      if (provider === 'catbox') {
        const fd = new FormData();
        fd.append('reqtype', 'fileupload');
        if (cfgd.userhash) fd.append('userhash', cfgd.userhash);
        fd.append('fileToUpload', new Blob([req.file.buffer], { type: req.file.mimetype }), 'upload.png');
        const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
        const txt = (await r.text()).trim();
        if (!r.ok || !txt.startsWith('https://')) return send(res, { ok: false, code: 'host', error: !txt ? 'Catbox did not respond — try again or switch provider in Founder Panel → Image uploads.' : 'Catbox error: ' + txt.slice(0, 120) });
        link = txt;
      } else if (provider === 'imgbb') {
        const key = cfgd.clientId;
        if (!key) return send(res, { ok: false, code: 'notconfigured', error: 'ImgBB needs an API key — set it in Founder Panel → Image uploads.' });
        const fd = new FormData();
        fd.append('key', key);
        fd.append('image', req.file.buffer.toString('base64'));
        const r = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: fd });
        const j = await r.json();
        if (!r.ok || !j || !j.success || !j.data || !j.data.url) return send(res, { ok: false, code: 'host', error: 'ImgBB error: ' + ((j && j.error && j.error.message) || 'upload rejected') });
        link = j.data.url; extra = { width: j.data.width, height: j.data.height, size: j.data.size };
      } else { /* imgur */
        const clientId = cfgd.clientId;
        if (!clientId) return send(res, { ok: false, code: 'notconfigured', error: 'Imgur needs a Client-ID — set it in Founder Panel → Image uploads.' });
        const form = new URLSearchParams();
        form.append('image', req.file.buffer.toString('base64'));
        const r = await fetch('https://api.imgur.com/3/image', {
          method: 'POST',
          headers: { Authorization: 'Client-ID ' + clientId, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        const j = await r.json();
        if (!r.ok || !j || !j.success || !j.data || !j.data.link) {
          const msg = j && j.data && j.data.error ? (typeof j.data.error === 'string' ? j.data.error : 'Imgur rejected the upload') : 'Imgur rejected the upload';
          return send(res, { ok: false, code: 'host', error: 'Imgur error: ' + msg });
        }
        link = j.data.link; extra = { width: j.data.width, height: j.data.height, size: j.data.size, deletehash: j.data.deletehash || null };
      }
      return send(res, { ok: true, data: { url: link, provider, ...extra } });
    } catch (e) {
      console.error('[image-upload] ' + provider + ' failed:', e.message);
      return send(res, { ok: false, code: 'network', error: 'Could not reach the image host — check the server\'s internet connection and try again.' });
    }
  }));

  /* ---- system-file upload proxy (Catbox; up to 100 MB) ----
     Sellers pick their .rbxl/.lua/.zip; the server forwards it to the file
     host and returns the URL. The database stores only the URL. */
  const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
  app.post('/api/upload-file', fileUpload.single('file'), h(async (req, res) => {
    const u = await needAuth(req, res); if (!u) return;
    if (!req.file) return send(res, { ok: false, code: 'invalid', error: 'Choose a file first (up to 100 MB).' });
    const s = await engine.getImgurSettings();
    const cfgd = (s.ok && s.data) || {};
    const provider = cfgd.provider || 'catbox';
    try {
      if (provider === 'catbox') {
        const fd = new FormData();
        fd.append('reqtype', 'fileupload');
        if (cfgd.userhash) fd.append('userhash', cfgd.userhash);
        fd.append('fileToUpload', new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' }), (req.file.originalname || 'system-file').slice(0, 100));
        const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
        const txt = (await r.text()).trim();
        if (!r.ok || !txt.startsWith('https://')) return send(res, { ok: false, code: 'host', error: !txt ? 'Catbox did not respond — try again or re-upload.' : 'File host error: ' + txt.slice(0, 120) });
        return send(res, { ok: true, data: { url: txt, size: req.file.size, provider } });
      }
      /* Images-only providers can't host system files. */
      return send(res, { ok: false, code: 'notconfigured', error: 'System files upload to Catbox. Founder Panel → Image uploads is set to an image-only host — switch it to Catbox for file uploads to work.' });
    } catch (e) {
      console.error('[file-upload] failed:', e.message);
      return send(res, { ok: false, code: 'network', error: 'Could not reach the file host — check the server\'s internet connection and try again.' });
    }
  }));

  app.get('/api/assets', h(async (req, res) => { const u = await authUser(req); send(res, await engine.listApproved(u && u.id)); }));
  app.get('/api/assets/top', h(async (req, res) => { const u = await authUser(req); send(res, await engine.topSelling(Number(req.query.n) || 6, u && u.id)); }));
  app.get('/api/assets/mine', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.myAssets(u)); }));
  app.get('/api/assets/:id', h(async (req, res) => { const u = await authUser(req); send(res, await engine.getAsset(req.params.id, u && u.id)); }));
  app.post('/api/assets', upload.single('file'), h(async (req, res) => {
    const u = await needAuth(req, res); if (!u) return;
    const j = k => { try { return JSON.parse(req.body[k] || ''); } catch (e) { return undefined; } };
    send(res, await engine.createAsset(u, {
      title: req.body.title, category: req.body.category, description: req.body.description, price: req.body.price, imageUrl: req.body.imageUrl,
      images: j('images'), paymentMethods: j('paymentMethods'), sellerPaymentDetails: j('sellerPaymentDetails'), deliverDuringPending: req.body.deliverDuringPending === '1' || req.body.deliverDuringPending === 'true',
      fileUrl: req.body.fileUrl || undefined,
      fileName: req.file && req.file.originalname, fileData: bodyFile(req),
    }));
  }));
  app.patch('/api/assets/:id', upload.single('file'), h(async (req, res) => {
    const u = await needAuth(req, res); if (!u) return;
    const j = k => { try { return JSON.parse(req.body[k] || ''); } catch (e) { return undefined; } };
    send(res, await engine.updateAsset(u, req.params.id, {
      title: req.body.title, category: req.body.category, description: req.body.description, price: req.body.price, imageUrl: req.body.imageUrl,
      images: j('images'), paymentMethods: j('paymentMethods'), sellerPaymentDetails: j('sellerPaymentDetails'), deliverDuringPending: req.body.deliverDuringPending === undefined ? undefined : (req.body.deliverDuringPending === '1' || req.body.deliverDuringPending === 'true'),
      fileUrl: req.body.fileUrl,
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
    /* Hosted file (Catbox): stream it through, keeping the URL hidden and
       the download gated. A type=file query asks for a direct redirect. */
    if (r.data.fileUrl) {
      try {
        const upstream = await fetch(r.data.fileUrl);
        if (!upstream.ok || !upstream.body) throw new Error('upstream ' + upstream.status);
        const safe = String(r.data.fileName || 'asset-file').replace(/[^\w.\- ]+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
        res.setHeader('Content-Type', r.data.mime || upstream.headers.get('content-type') || 'application/octet-stream');
        if (upstream.headers.get('content-length')) res.setHeader('Content-Length', upstream.headers.get('content-length'));
        upstream.body.pipe(res);
        return;
      } catch (e) {
        return send(res, { ok: false, code: 'notfound', error: 'The hosted file could not be fetched — ask the seller to re-upload it.' });
      }
    }
    const f = await files.get(req.params.id);
    if (!f) return send(res, { ok: false, code: 'notfound', error: 'The file for this asset is missing.' });
    const safe = String(r.data.fileName || 'asset-file').replace(/[^\w.\- ]+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    res.setHeader('Content-Type', r.data.mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.data);
  }));
  app.post('/api/assets/:id/purchase', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.purchase(u, req.params.id)); }));
  app.post('/api/assets/:id/like', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.toggleLike(u, req.params.id)); }));

  /* ---- post cooldown status ---- */
  app.get('/api/post-status', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.postStatus(u)); }));

  /* ---- comments ---- */
  app.get('/api/assets/:id/comments', h(async (req, res) => send(res, await engine.listComments(req.params.id))));
  app.post('/api/assets/:id/comments', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.addComment(u, req.params.id, req.body || {})); }));

  /* ---- reviews & ratings ---- */
  app.get('/api/assets/:id/reviews', h(async (req, res) => send(res, await engine.listReviews(req.params.id))));
  app.post('/api/assets/:id/reviews', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.addReview(u, req.params.id, req.body || {})); }));
  app.delete('/api/reviews/:id', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.deleteReview(u, req.params.id)); }));

  /* ---- reports ---- */
  app.post('/api/reports', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.createReport(u, req.body || {})); }));

  /* ---- purchases & licenses ---- */
  app.get('/api/purchases/mine', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.myPurchases(u)); }));

  /* ---- license security (called by the asset file itself at runtime) ---- */
  app.post('/api/license/activate', h(async (req, res) => send(res, await engine.licenseActivate(req.body || {}))));
  app.post('/api/license/heartbeat', h(async (req, res) => send(res, await engine.licenseHeartbeat(req.body || {}))));

  /* ---- creator dashboard (VIP / Licensed +) ---- */
  app.get('/api/dashboard', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.creatorDashboard(u)); }));
  app.get('/api/dashboard/licenses', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.creatorLicenses(u, req.query.asset || null)); }));
  app.post('/api/dashboard/licenses/:id/status', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.setLicenseStatus(u, req.params.id, (req.body || {}).status)); }));
  app.post('/api/dashboard/devices/:id/revoke', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.revokeDevice(u, req.params.id)); }));
  app.post('/api/licenses/assign', h(async (req, res) => {
    const u = await needAuth(req, res); if (!u) return;
    const b = req.body || {};
    send(res, await engine.assignLicense(u, b.purchaseId, { gameId: b.gameId, gameName: b.gameName }));
  }));

  /* ---- payments & checkout (Stripe · PayPal · GCash) ---- */
  app.get('/api/rates', (req, res) => res.json({ ok: true, data: { base: 'USD', rates: liveFx || null } }));
  app.get('/api/payment/methods', (req, res) => res.json({
    ok: true,
    data: {
      dev: PAYMENT.dev,
      currency: PAYMENT.currency,
      methods: [
        { id: 'stripe', label: 'Stripe · automatic', enabled: !!PAYMENT.stripe, auto: true },
        { id: 'paypal', label: 'PayPal · automatic', enabled: !!PAYMENT.paypal, auto: true },
        { id: 'gcash', label: 'GCash · automatic', enabled: !!PAYMENT.paymongo, auto: true },
        { id: 'stripe_manual', label: 'Stripe · manual', enabled: true, manual: true },
        { id: 'paypal_manual', label: 'PayPal · manual', enabled: true, manual: true },
        { id: 'gcash_manual', label: 'GCash · manual (QR)', enabled: true, manual: true },
        { id: 'kofi_manual', label: 'Ko-fi · manual', enabled: true, manual: true },
      ],
    },
  }));
  app.post('/api/checkout', h(async (req, res) => {
    const u = await needAuth(req, res); if (!u) return;
    const { assetId, plan, method, gameDetails } = req.body || {};
    const isVip = plan === 'vip';
    const isVipTry = plan === 'vip_try';
    const isSub = plan && String(plan).startsWith('sub:');
    const r = isVip ? await engine.createVipOrder(u, method)
      : isVipTry ? await engine.createVipTrialOrder(u, assetId, method, gameDetails)
      : isSub ? await engine.createSubscriptionOrder(u, String(plan).split(':')[1], String(plan).split(':')[2], method)
      : await engine.createOrder(u, assetId, method, gameDetails);
    if (!r.ok) return send(res, r);
    const { orderId, amount, currency } = r.data;
    if (isVipTry) {
      // Zero-cost VIP try — the order is created already paid, awaiting the seller's approval.
      return send(res, { ok: true, data: { orderId, vipTrial: true } });
    }
    if (PAYMENT.dev && !String(method || '').endsWith('_manual')) {
      // No gateway keys configured — complete instantly (test mode, no money moves).
      // Manual methods are exempt: they wait for the buyer's proof + staff verification.
      return send(res, await engine.completeOrder(u, orderId, 'dev'));
    }
    if (String(method || '').endsWith('_manual')) {
      // Manual payment — the buyer gets payment details, pays off-site, and submits proof.
      return send(res, { ok: true, data: { orderId, manual: true } });
    }
    try {
      let title = 'Kings Production asset';
      if (isVip) title = 'VIP / Licensed plan — Kings Production';
      else if (isSub) title = (String(plan).split(':')[1] === 'protection' ? 'Subscription ' : 'Contract ') + String(plan).split(':')[2] + ' — Kings Production';
      else { const asset = await engine.getAsset(u, assetId); title = (asset.ok && asset.data && asset.data.title) || title; }
      if (method === 'stripe' && PAYMENT.stripe) {
        const session = await PAYMENT.stripe.checkout.sessions.create({
          mode: 'payment',
          line_items: [{ price_data: {
            currency: currency.toLowerCase(),
            unit_amount: amount * 100,
            product_data: { name: String(title).slice(0, 60), description: 'License key · VIP / Licensed upgrade included' },
          }, quantity: 1 }],
          metadata: { orderId },
          success_url: PUBLIC_URL + '/#/subscription?paid=1',
          cancel_url: PUBLIC_URL + '/#/subscription',
        });
        return send(res, { ok: true, data: { orderId, redirect: session.url } });
      }
      if (method === 'paypal' && PAYMENT.paypal) {
        const pp = await paypalCreateOrder(amount, currency, title, orderId);
        if (!pp.url) return send(res, { ok: false, code: 'provider', error: 'PayPal could not start the checkout.' });
        return send(res, { ok: true, data: { orderId, redirect: pp.url } });
      }
      if (method === 'gcash' && PAYMENT.paymongo) {
        const pm = await paymongoCreateSource(amount, currency, title, orderId);
        if (!pm.url) return send(res, { ok: false, code: 'provider', error: 'GCash could not start the checkout.' });
        return send(res, { ok: true, data: { orderId, redirect: pm.url } });
      }
      await engine.cancelOrder(u, orderId);
      return send(res, { ok: false, code: 'unavailable', error: 'That payment method is not configured yet.' });
    } catch (e) {
      console.error('[checkout]', e && e.message || e);
      await engine.cancelOrder(u, orderId);
      return send(res, { ok: false, code: 'provider', error: 'Could not start the payment. Please try again.' });
    }
  }));
  /* Called after the buyer returns from the provider (PayPal / GCash) — verifies
     the payment and completes the order (license + VIP upgrade). Stripe completes
     via webhook; this endpoint is a safe no-op then. */
  app.post('/api/payments/confirm', h(async (req, res) => {
    const u = await needAuth(req, res); if (!u) return;
    const { orderId, providerRef } = req.body || {};
    if (!orderId) return send(res, { ok: false, code: 'invalid', error: 'Missing order reference.' });
    const ords = await engine.myOrders(u);
    const ord = ords.ok && ords.data.find(o => o.id === orderId);
    if (!ord) return send(res, { ok: false, code: 'notfound', error: 'Order not found.' });
    if (ord.status === 'completed') return send(res, await engine.completeOrder(u, orderId));
    if (ord.method === 'paypal' && PAYMENT.paypal) {
      if (!providerRef) return send(res, { ok: false, code: 'invalid', error: 'Payment reference missing.' });
      const okPay = await paypalCapture(providerRef);
      if (!okPay) return send(res, { ok: false, code: 'pending', error: 'Payment was not completed. Try again from the License page.' });
      return send(res, await engine.settleOrder(orderId, providerRef));
    }
    if (ord.method === 'gcash' && PAYMENT.paymongo) {
      if (!providerRef) return send(res, { ok: false, code: 'invalid', error: 'Payment reference missing.' });
      const okG = await paymongoCharged(providerRef);
      if (!okG) return send(res, { ok: false, code: 'pending', error: 'Payment was not completed. Try again from the License page.' });
      return send(res, await engine.settleOrder(orderId, providerRef));
    }
    if (ord.method === 'stripe') {
      if (ord.status === 'paid') return send(res, await engine.settleOrder(orderId));
      return send(res, { ok: false, code: 'pending', error: 'Payment is still processing — your license will appear on the License page shortly.' });
    }
    return send(res, { ok: false, code: 'unavailable', error: 'That payment method is not configured.' });
  }));
  app.get('/api/orders/mine', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.myOrders(u)); }));
  app.post('/api/orders/:id/proof', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.submitPaymentProof(u, req.params.id, req.body || {})); }));
  app.post('/api/orders/:id/cancel', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.cancelOrder(u, req.params.id)); }));

  /* ---- profiles & content ---- */
  app.get('/api/profile/:handle', h(async (req, res) => send(res, await engine.publicProfile(req.params.handle))));
  app.get('/api/site/content', h(async (req, res) => send(res, await engine.content())));

  /* ---- admin (auth + role check enforced inside the engine) ---- */
  const admin = fn => h(async (req, res) => {
    const u = await needAuth(req, res);
    if (!u) return;
    send(res, await fn(u, req));
  });
  app.post('/api/admin/orders/:id/review', admin(async (u, req) => engine.adminReviewManualOrder(u, req.params.id, (req.body || {}).decision, (req.body || {}).note)));
  app.get('/api/admin/payment-config', admin(async u => engine.getPaymentConfig()));
  app.post('/api/admin/payment-config', admin(async (u, req) => engine.adminSetPaymentConfig(u, req.body || {})));
  app.get('/api/admin/imgur-settings', admin(async u => engine.getImgurSettings()));
  app.post('/api/admin/imgur-settings', admin(async (u, req) => engine.adminSetImgurSettings(u, req.body || {})));
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
  app.post('/api/admin/users/:id/vip', admin(async (u, req) => engine.setVipRole(u, req.params.id, !!(req.body || {}).on)));
  app.post('/api/admin/users/:id/tags', admin(async (u, req) => engine.adminSetTags(u, req.params.id, (req.body || {}).tags)));
  app.get('/api/admin/sessions', admin(async u => engine.adminSessions(u)));
  app.get('/api/admin/emails', admin(async u => engine.adminEmails(u)));
  app.post('/api/admin/emails/send', admin(async (u, req) => engine.adminSendEmail(u, req.body || {})));
  app.get('/api/admin/emails/blasts', admin(async u => engine.adminListBlasts(u)));
  app.delete('/api/admin/emails/blasts/:id', admin(async (u, req) => engine.adminDeleteBlast(u, req.params.id)));
  app.get('/api/admin/emails/history/:userId', admin(async (u, req) => engine.adminEmailHistory(u, req.params.userId)));
  app.get('/api/admin/emails/inbound', admin(async u => engine.adminListInbound(u)));
  app.post('/api/admin/users/:id/unsubscribe', admin(async (u, req) => engine.adminSetUnsubscribed(u, req.params.id, !!(req.body || {}).unsubscribed)));
  /* Brevo webhook — replies, bounces, unsubscribes (see README setup). */
  app.post('/api/webhooks/mail', async (req, res) => {
    try {
      const events = Array.isArray(req.body) ? req.body : (req.body && req.body.events) || [req.body];
      for (const ev of events || []) {
        await engine.inboundMailEvent({
          email: ev.email || ev.recipient || ev.to,
          event: ev.event || ev['event-type'] || 'reply',
          subject: ev.subject,
          body: ev.body || ev.rawtext || null,
          detail: ev.reason || ev.error || ev.sg_message_id || null,
        });
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[mail] webhook failed:', e && e.message || e);
      res.status(500).json({ ok: false });
    }
  });
  app.get('/api/admin/systems', admin(async u => engine.adminSystems(u)));
  app.get('/api/admin/systems/:id', admin(async (u, req) => engine.adminSystemDetail(u, req.params.id)));
  app.get('/api/admin/subscribers/:id', admin(async (u, req) => engine.adminSubscriberDetail(u, req.params.id)));
  app.post('/api/admin/systems/:id/delete', admin(async (u, req) => engine.adminDeleteSystem(u, req.params.id)));
  app.post('/api/admin/systems/:id/state', admin(async (u, req) => engine.adminSetSystemState(u, req.params.id, req.body || {})));
  app.get('/api/admin/reports', admin(async u => engine.adminReports(u)));
  app.post('/api/admin/reports/:id/resolve', admin(async (u, req) => engine.adminResolveReport(u, req.params.id)));
  app.get('/api/admin/orders', admin(async u => engine.adminOrders(u)));
  app.post('/api/admin/orders/:id/complete', admin(async (u, req) => engine.adminCompleteOrder(u, req.params.id)));
  /* Staff moderation: restrict users, disable/restore posts, request sub revocation. */
  app.post('/api/admin/users/:id/restrict', admin(async (u, req) => engine.adminSetRestriction(u, req.params.id, req.body || {})));
  app.post('/api/admin/assets/:id/status', admin(async (u, req) => engine.adminSetAssetStatus(u, req.params.id, (req.body || {}).status)));
  app.get('/api/admin/assets/:id/take-file', admin(async (u, req) => engine.adminTakeFile(u, req.params.id)));
  app.get('/api/admin/site-status', admin(async u => engine.siteStatus(u)));
  app.post('/api/admin/sub-revokes', admin(async (u, req) => engine.adminRequestSubRevoke(u, (req.body || {}).targetId, (req.body || {}).reason)));
  app.post('/api/admin/users/:id/unsubscribe-plan', admin(async (u, req) => engine.adminUnsubscribePlan(u, req.params.id, (req.body || {}).reason)));
  app.post('/api/admin/sub-revokes/:id/resolve', admin(async (u, req) => engine.adminResolveSubRevoke(u, req.params.id, (req.body || {}).decision)));
  app.get('/api/admin/sub-revokes', admin(async u => engine.adminListSubRevokes(u)));
  /* Seller order queue (Licensed Dashboard → Orders). */
  app.get('/api/dashboard/orders', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.sellerOrders(u)); }));
  app.post('/api/dashboard/orders/:id/approval', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.setOrderApproval(u, req.params.id, (req.body || {}).decision, (req.body || {}).note)); }));
  app.post('/api/dashboard/orders/:id/review-proof', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.sellerReviewProof(u, req.params.id, (req.body || {}).decision, (req.body || {}).note)); }));
  /* ---- announcements (admin) ---- */
  app.post('/api/admin/announcements', admin(async (u, req) => engine.createAnnouncement(u, req.body || {})));
  app.patch('/api/admin/announcements/:id', admin(async (u, req) => engine.updateAnnouncement(u, req.params.id, req.body || {})));
  app.delete('/api/admin/announcements/:id', admin(async (u, req) => engine.deleteAnnouncement(u, req.params.id)));

  /* ---- portfolio is admin-published showcase content ---- */
  app.post('/api/site/portfolio', admin(async (u, req) => engine.createPortfolio(u, req.body || {})));
  app.patch('/api/site/portfolio/:id', admin(async (u, req) => engine.updatePortfolio(u, req.params.id, req.body || {})));
  app.delete('/api/site/portfolio/:id', admin(async (u, req) => engine.deletePortfolio(u, req.params.id)));
  /* ---- creators are admin-published (like portfolio) ---- */
  app.post('/api/site/creators', admin(async (u, req) => engine.createCreator(u, req.body || {})));
  app.patch('/api/site/creators/:id', admin(async (u, req) => engine.updateCreator(u, req.params.id, req.body || {})));
  app.delete('/api/site/creators/:id', admin(async (u, req) => engine.deleteCreator(u, req.params.id)));

  /* ---- system registering (creator → Roblox Studio licensing) ---- */
  /* Public endpoints called by the copyable Lua script in Roblox Studio. */
  app.post('/api/systems/activate', rateLimitSystems, h(async (req, res) => send(res, await engine.systemActivate(req.body || {}))));
  app.post('/api/systems/heartbeat', rateLimitSystems, h(async (req, res) => send(res, await engine.systemHeartbeat(req.body || {}))));
  app.post('/api/systems/device', rateLimitSystems, h(async (req, res) => send(res, await engine.registerSystemDevice(req.body || {}))));
  /* Authenticated endpoints for the Dashboard UI. */
  app.post('/api/systems/register', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.registerSystem(u, req.body || {})); }));
  app.get('/api/systems/mine', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.listSystems(u)); }));
  app.post('/api/systems/:id/refresh-games', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.refreshSystemGames(u, req.params.id)); }));
  app.delete('/api/systems/:id', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.deleteSystem(u, req.params.id)); }));
  app.post('/api/systems/:id/status', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.setSystemStatus(u, req.params.id, (req.body || {}).status)); }));
  app.post('/api/systems/devices/:id/revoke', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.revokeSystemDevice(u, req.params.id)); }));
  app.post('/api/systems/devices/:id/authorize', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.authorizeSystemDevice(u, req.params.id)); }));
  app.post('/api/systems/games/:id/status', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.setSystemGameStatus(u, req.params.id, (req.body || {}).status)); }));
  app.post('/api/systems/:id/enforcement', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.setSystemEnforcement(u, req.params.id, req.body || {})); }));
  app.delete('/api/systems/games/:id', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.removeSystemGame(u, req.params.id)); }));

  /* ---- support tickets & chat ---- */
  app.post('/api/tickets/new', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.createTicket(u, req.body || {})); }));
  app.get('/api/tickets/mine', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.listMyTickets(u)); }));
  app.get('/api/tickets/:id', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.getTicket(u, req.params.id)); }));
  app.post('/api/tickets/:id/messages', h(async (req, res) => { const u = await needAuth(req, res); if (!u) return; send(res, await engine.addTicketMessage(u, req.params.id, (req.body || {}).body)); }));
  /* ---- admin ticket management ---- */
  app.get('/api/admin/tickets', admin(async u => engine.adminListTickets(u)));
  app.post('/api/admin/tickets/:id/close', admin(async (u, req) => engine.adminCloseTicket(u, req.params.id)));
  app.delete('/api/admin/tickets/:id', admin(async (u, req) => engine.adminDeleteTicket(u, req.params.id)));

  /* ---- FAQ (public read, staff write) ---- */
  app.get('/api/faqs', h(async (req, res) => send(res, engine.getFaqs())));
  app.post('/api/admin/faqs', admin(async (u, req) => engine.saveFaqs(u, (req.body || {}).faqs)));
  app.get('/api/legal/:key', h(async (req, res) => send(res, engine.getLegalDoc(String(req.params.key)))));
  app.post('/api/admin/legal/:key', admin(async (u, req) => engine.saveLegalDoc(u, String(req.params.key), (req.body || {}).body)));

  /* ---- Founder grant: set plan tiers directly (Co-Founder / Founder only) ---- */
  app.post('/api/admin/users/:id/plan', admin(async (u, req) => engine.adminSetUserPlan(u, req.params.id, req.body || {})));

  /* ---- the app (single-file SPA) ---- */
  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  app.get('/logo.png', (req, res) => {
    const p = path.join(ROOT, 'public', 'logo.png');
    if (fs.existsSync(p)) { res.setHeader('content-type', 'image/png'); res.setHeader('cache-control', 'public, max-age=86400'); res.sendFile(p); }
    else res.status(404).end();
  });

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
