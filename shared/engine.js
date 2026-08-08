/* ============================================================================
   KINGS PRODUCTION ENGINE v3
   Shared business logic. Runs in the Node backend (module.exports) and is
   inlined verbatim into the browser bundle (window.KPEngine) by
   scripts/build.mjs — keep the two copies identical.

   The engine is transport-agnostic. It talks to three injected adapters:
     store  — get(table,id) / all(table) / put(table,row) / del(table,id) / flush()
              (browser: localStorage; node: SQLite via server/sqlite-store.js)
     files  — put(id, {name,data,mime,size}) / get(id) / del(id)
              (browser: IndexedDB; node: disk via server/disk-files.js)
     mail   — optional deliver(email) side-channel (node: console + optional SMTP)
   Uses only platform crypto (globalThis.crypto, TextEncoder) available in both
   Node >= 19 and browsers.
   ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KPEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- helpers ---- */
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
  const now = () => Date.now();
  const ok = data => ({ ok: true, data: data == null ? null : data });
  const fail = (code, error) => ({ ok: false, code, error });
  const byId = (list, id) => list.find(x => x.id === id);

  const CATEGORIES = ['animation', 'model', 'plugin', 'system'];
  const CAT_LABEL = { animation: 'Animation', model: 'Model', plugin: 'Plugin', system: 'System' };
  const ROLES = ['member', 'vip', 'admin'];

  /* ---- crypto (WebCrypto — works in Node >= 19 and browsers) ---- */
  const TE = new TextEncoder();
  const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  const unhex = s => new Uint8Array(s.match(/.{2}/g).map(x => parseInt(x, 16)));
  function randomToken(bytes = 24) { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return hex(a); }

  async function hashPassword(pw) {
    const salt = new Uint8Array(16); crypto.getRandomValues(salt);
    const key = await crypto.subtle.importKey('raw', TE.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 60000, hash: 'SHA-256' }, key, 256);
    return hex(salt) + ':' + hex(new Uint8Array(bits));
  }
  async function verifyPassword(pw, stored) {
    try {
      const [sh, hh] = String(stored).split(':');
      const key = await crypto.subtle.importKey('raw', TE.encode(pw), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(sh), iterations: 60000, hash: 'SHA-256' }, key, 256);
      return hex(new Uint8Array(bits)) === hh;
    } catch (e) { return false; }
  }

  /* ---- TOTP (RFC 6238) for 2FA ---- */
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function base32Encode(bytes) {
    let bits = 0, val = 0, out = '';
    for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
  }
  function base32Decode(str) {
    const map = {}; [...B32].forEach((c, i) => map[c] = i);
    let bits = 0, val = 0; const out = [];
    for (const ch of String(str).toUpperCase().replace(/=+$/, '')) { if (map[ch] == null) continue; val = (val << 5) | map[ch]; bits += 5; if (bits >= 8) { out.push((val >> (bits - 8)) & 255); bits -= 8; } }
    return new Uint8Array(out);
  }
  function totpSecret() { const s = new Uint8Array(20); crypto.getRandomValues(s); return base32Encode(s); }
  function otpauthUri(secret, email) {
    return 'otpauth://totp/Kings%20Production:' + encodeURIComponent(email) + '?secret=' + secret + '&issuer=Kings%20Production&algorithm=SHA1&digits=6&period=30';
  }
  async function totpCode(secret, atMs = Date.now()) {
    const counter = Math.floor(atMs / 1000 / 30);
    const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const buf = new ArrayBuffer(8); new DataView(buf).setUint32(4, counter, false);
    const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array(buf)));
    const off = h[h.length - 1] & 0xf;
    const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    return String(bin % 1000000).padStart(6, '0');
  }
  async function verifyTotp(secret, code, windowSteps = 1) {
    if (!/^\d{6}$/.test(String(code || ''))) return false;
    const t = Date.now();
    for (let w = -windowSteps; w <= windowSteps; w++) if ((await totpCode(secret, t + w * 30000)) === String(code)) return true;
    return false;
  }

  /* ---- user helpers ---- */
  const isTimedOut = u => !!(u && u.timeoutUntil && u.timeoutUntil > now());
  const isBanned = u => !!(u && u.banned);
  const isRestricted = u => isBanned(u) || isTimedOut(u);
  const canPost = u => !!(u && (u.role === 'vip' || u.role === 'admin') && !isBanned(u) && !isTimedOut(u));
  const isAdmin = u => !!(u && u.role === 'admin');
  const publicUser = u => u ? ({ id: u.id, handle: u.handle, displayName: u.displayName, role: u.role, pfp: u.pfp, bio: u.bio, createdAt: u.createdAt }) : null;
  const selfUser = u => u ? ({ ...publicUser(u), email: u.email, banned: u.banned, timeoutUntil: u.timeoutUntil, totpEnabled: u.totpEnabled }) : null;
  function timeoutText(u) {
    if (!u || !u.timeoutUntil) return null;
    const ms = u.timeoutUntil - now();
    if (ms <= 0) return null;
    const h = Math.floor(ms / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    return (h > 0 ? h + 'h ' : '') + m + 'm';
  }
  const okHandle = h => /^[a-zA-Z0-9_]{3,20}$/.test(h || '');
  const okEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

  /* ---- studio content (portfolio + creators are content rows, NOT accounts) ---- */
  const CONTENT = {
    portfolio: [
      { id: 'pp1', title: 'Kingdom Realms', category: 'Game Experience', desc: 'A medieval RPG with custom combat systems, a questing framework, and a living player economy.', stat: '1.2M visits', status: 'Live' },
      { id: 'pp2', title: 'Neon Drift', category: 'Racing', desc: 'High-speed arcade racing built on our drift controller, with neon night circuits and time trials.', stat: '860K visits', status: 'Live' },
      { id: 'pp3', title: 'Shadow Vault', category: 'Horror', desc: 'A co-op horror escape with dynamic lighting, proximity audio, and procedurally placed vaults.', stat: '640K visits', status: 'Live' },
      { id: 'pp4', title: 'Pixel Harvest', category: 'Farming', desc: 'A cozy farming simulation with seasons, crops, automation, and a trading marketplace.', stat: '510K visits', status: 'Live' },
      { id: 'pp5', title: 'Arsenal Zero', category: 'FPS Framework', desc: 'A modular FPS framework — loadouts, hit registration, and networking — shipped to 40+ experiences.', stat: '320K installs', status: 'Framework' },
      { id: 'pp6', title: 'Lumen Isles', category: 'Adventure', desc: 'An open-world adventure with custom terrain generation and a traversal system in active development.', stat: '280K visits', status: 'Beta' }
    ],
    creators: [
      { id: 'cr1', name: 'King', role: 'Founder · Lead Developer', bio: 'Builds the systems that hold the studio together and ships the frameworks you see in the shop.' },
      { id: 'cr2', name: 'Vex', role: 'UI / UX Designer', bio: 'Designs interfaces players actually enjoy. Behind the Vex UI Library and every shop front.' },
      { id: 'cr3', name: 'Ace', role: 'Core Scripter', bio: 'Writes the server-authoritative code behind our admin, auction, and framework systems.' },
      { id: 'cr4', name: 'Nova', role: '3D Modeler', bio: 'Crafts the models, rigs, and environments — from character packs to modular castle kits.' },
      { id: 'cr5', name: 'Echo', role: 'Animator', bio: 'Hand-tunes every animation clip, from combat flows to climbing and parkour.' },
      { id: 'cr6', name: 'Onyx', role: 'Systems Engineer', bio: 'Designs backend logic, data stores, and the architecture behind our largest projects.' }
    ]
  };

  function createEngine(deps) {
    const store = deps.store, files = deps.files, mail = deps.mail;
    const cfg = Object.assign(
      { autoAdminFirstUser: true, devMail: true, onlineWindowMs: 10 * 6e4, sessionTtlMs: 30 * 24 * 36e5, maxUploadBytes: 20 * 1024 * 1024 },
      deps.config || {}
    );
    const all = t => store.all(t);
    const byIdIn = (t, id) => store.get(t, id);
    const flush = () => { if (store.flush) store.flush(); };
    const dbUser = id => byIdIn('users', id);
    const resolveUser = user => (user && user.id) ? dbUser(user.id) : null;
    const requireAdmin = actor => {
      if (!actor) return fail('auth', 'You must be logged in as an admin.');
      if (actor.role !== 'admin') return fail('adminOnly', 'You do not have permission to do that.');
      return null;
    };

    function seedContent() {
      if (all('portfolio').length) return;
      CONTENT.portfolio.forEach(r => store.put('portfolio', r));
      CONTENT.creators.forEach(r => store.put('creators', r));
      flush();
    }

    function pruneSessions() {
      const old = now() - cfg.sessionTtlMs, idle = now() - 24 * 36e5;
      all('sessions').filter(s => s.createdAt < old || s.lastSeen < idle).forEach(s => store.del('sessions', s.id));
    }
    function createSession(userId, label) {
      const s = { id: randomToken(), userId, label: label || '', createdAt: now(), lastSeen: now(), expiresAt: now() + cfg.sessionTtlMs };
      store.put('sessions', s);
      flush(); // session writes must persist immediately
      return s;
    }

    function summarize(a) {
      const o = dbUser(a.ownerId);
      const rv = all('reviews').filter(r => r.assetId === a.id);
      const rating = rv.length ? Math.round((rv.reduce((s, r) => s + r.rating, 0) / rv.length) * 10) / 10 : null;
      return { id: a.id, title: a.title, category: a.category, price: a.price, sales: a.sales, status: a.status, createdAt: a.createdAt, rejectReason: a.rejectReason, fileName: a.fileName, owner: o ? publicUser(o) : null, rating, ratingCount: rv.length };
    }
    function sendEmail(rec) {
      const row = { id: 'e' + uid(), to: rec.to, subject: rec.subject, action: rec.action, body: rec.body, link: rec.link || null, createdAt: now(), read: false };
      store.put('emails', row);
      if (mail && mail.deliver) { try { mail.deliver({ ...rec, link: rec.link }); } catch (e) { console.error('mail deliver failed', e); } }
      flush();
      return row;
    }

    /* ============ AUTH ============ */
    async function register({ handle, displayName, email, password } = {}) {
      handle = String(handle || '').trim();
      displayName = String(displayName || '').trim();
      email = String(email || '').trim().toLowerCase();
      if (!okHandle(handle)) return fail('invalid', 'Handle must be 3–20 characters (letters, numbers, underscore).');
      if (all('users').some(u => u.handle.toLowerCase() === handle.toLowerCase())) return fail('taken', 'That handle is already taken.');
      if (displayName.length < 2 || displayName.length > 40) return fail('invalid', 'Display name must be 2–40 characters.');
      if (!okEmail(email)) return fail('invalid', 'Please enter a valid email address.');
      if (all('users').some(u => u.email.toLowerCase() === email)) return fail('taken', 'An account with that email already exists.');
      if (String(password || '').length < 6) return fail('invalid', 'Password must be at least 6 characters.');
      const isFirst = cfg.autoAdminFirstUser && all('users').length === 0;
      const user = {
        id: 'u' + uid(), handle, displayName, email, role: isFirst ? 'admin' : 'member',
        passHash: await hashPassword(password), bio: '', pfp: null,
        totpSecret: null, totpEnabled: false, banned: false, banReason: null, timeoutUntil: null, createdAt: now(), updatedAt: now(),
      };
      store.put('users', user);
      const s = createSession(user.id);
      flush();
      return ok({ token: s.id, user: selfUser(user) });
    }

    async function login({ login, password, label } = {}) {
      login = String(login || '').trim().toLowerCase();
      const u = all('users').find(x => x.handle.toLowerCase() === login || x.email.toLowerCase() === login);
      if (!u || !(await verifyPassword(String(password || ''), u.passHash))) return fail('bad', 'Incorrect handle/email or password.');
      if (u.banned) return fail('banned', 'This account has been banned by an administrator.');
      if (u.totpEnabled) return ok({ need2fa: true, userId: u.id });
      const s = createSession(u.id, label);
      return ok({ token: s.id, user: selfUser(u) });
    }

    async function verify2fa({ userId, code, label } = {}) {
      const u = dbUser(userId);
      if (!u || !u.totpEnabled) return fail('bad', 'Two-factor verification is not active for this account.');
      if (u.banned) return fail('banned', 'This account has been banned by an administrator.');
      if (!(await verifyTotp(u.totpSecret, code))) return fail('bad', 'That code is invalid or expired.');
      const s = createSession(u.id, label);
      return ok({ token: s.id, user: selfUser(u) });
    }

    async function requestReset({ email } = {}) {
      email = String(email || '').trim().toLowerCase();
      const u = all('users').find(x => x.email.toLowerCase() === email);
      if (!u) return ok({ sent: true }); // never reveal whether an email exists
      all('tokens').filter(t => t.userId === u.id && t.purpose === 'reset' && !t.used).forEach(t => store.del('tokens', t.id));
      const token = randomToken(18);
      store.put('tokens', { id: 't' + uid(), userId: u.id, token, purpose: 'reset', expiresAt: now() + 36e5, used: false, createdAt: now() });
      const link = '#/reset?token=' + token;
      sendEmail({ to: u.email, subject: 'Reset your Kings Production password', action: 'reset', body: 'A password reset was requested for your account. Use the link below to choose a new password. This link expires in 60 minutes and can only be used once.', link });
      return ok(Object.assign({ sent: true }, cfg.devMail ? { devLink: link } : {}));
    }

    async function resetPassword({ token, password } = {}) {
      const t = all('tokens').find(x => x.token === token && x.purpose === 'reset' && !x.used);
      if (!t) return fail('bad', 'This reset link is invalid or has already been used.');
      if (t.expiresAt < now()) return fail('expired', 'This reset link has expired. Request a new one.');
      if (String(password || '').length < 6) return fail('invalid', 'Password must be at least 6 characters.');
      const u = dbUser(t.userId);
      if (!u) return fail('bad', 'Account not found.');
      u.passHash = await hashPassword(password);
      u.updatedAt = now();
      store.put('users', u);
      t.used = true;
      store.put('tokens', t);
      all('sessions').filter(s => s.userId === u.id).forEach(s => store.del('sessions', s.id)); // sign out everywhere
      flush();
      return ok(true);
    }

    async function logout(token) {
      if (token) store.del('sessions', token);
      flush();
      return ok(true);
    }

    async function me(token) {
      if (!token) return ok(null);
      pruneSessions();
      const s = byIdIn('sessions', token);
      if (!s) return ok(null);
      const u = dbUser(s.userId);
      if (!u) return ok(null);
      s.lastSeen = now();
      store.put('sessions', s);
      return ok(selfUser(u));
    }

    /* ============ PROFILE & 2FA ============ */
    async function updateProfile(user, { displayName, handle, bio, pfp } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'Account not found.');
      displayName = String(displayName || '').trim();
      handle = String(handle || '').trim();
      if (displayName.length < 2 || displayName.length > 40) return fail('invalid', 'Display name must be 2–40 characters.');
      if (!okHandle(handle)) return fail('invalid', 'Handle must be 3–20 characters (letters, numbers, underscore).');
      if (all('users').some(x => x.id !== u.id && x.handle.toLowerCase() === handle.toLowerCase())) return fail('taken', 'That handle is already taken.');
      if (pfp !== null && pfp !== undefined && typeof pfp === 'string' && pfp.length > 1.8e6) return fail('invalid', 'Profile picture is too large.');
      u.displayName = displayName;
      u.handle = handle;
      if (bio !== undefined) u.bio = String(bio || '').slice(0, 300);
      if (pfp !== undefined) u.pfp = pfp || null;
      u.updatedAt = now();
      store.put('users', u);
      flush();
      return ok(publicUser(u));
    }

    async function setup2fa(user) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'Account not found.');
      if (!u.totpSecret) { u.totpSecret = totpSecret(); store.put('users', u); flush(); }
      return ok({ secret: u.totpSecret, uri: otpauthUri(u.totpSecret, u.email), email: u.email });
    }
    async function enable2fa(user, { code } = {}) {
      const u = resolveUser(user);
      if (!u || !u.totpSecret) return fail('bad', 'No secret has been generated yet — start setup first.');
      if (!(await verifyTotp(u.totpSecret, code))) return fail('bad', 'That code is invalid — make sure your authenticator shows the current code.');
      u.totpEnabled = true;
      store.put('users', u);
      flush();
      return ok(true);
    }
    async function disable2fa(user, { code } = {}) {
      const u = resolveUser(user);
      if (!u || !u.totpEnabled) return fail('bad', 'Two-factor authentication is not enabled.');
      if (!(await verifyTotp(u.totpSecret, code))) return fail('bad', 'That code is invalid or expired.');
      u.totpEnabled = false;
      u.totpSecret = null;
      store.put('users', u);
      flush();
      return ok(true);
    }

    /* ============ ASSETS ============ */
    function normalizeFile(fileData, fileName) {
      if (fileData && typeof fileData === 'object') return { name: fileData.name || fileName, data: fileData.data, mime: fileData.mime || 'application/octet-stream', size: fileData.size || 0 };
      if (fileData) return { name: fileName, data: fileData, mime: 'application/octet-stream', size: 0 };
      return null;
    }

    async function createAsset(user, { title, category, description, price, fileName, fileData } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to post assets.');
      if (!canPost(u)) {
        if (u.role === 'member') return fail('vipOnly', 'Only VIP / Licensed creators can post assets. Members can comment and purchase.');
        if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot post assets.');
        return fail('auth', 'You must be logged in to post assets.');
      }
      title = String(title || '').trim();
      description = String(description || '').trim();
      price = Number(price);
      category = String(category || '').toLowerCase();
      if (title.length < 3 || title.length > 60) return fail('invalid', 'Title must be 3–60 characters.');
      if (!CATEGORIES.includes(category)) return fail('invalid', 'Choose a valid category: Animation, Model, Plugin, or System.');
      if (description.length < 10) return fail('invalid', 'A full description is required (at least 10 characters).');
      if (!Number.isFinite(price) || price <= 0 || price > 999999) return fail('invalid', 'Price must be a positive number of Robux.');
      const file = normalizeFile(fileData, fileName);
      if (!fileName && !file) return fail('invalid', 'Please upload the asset file.');
      const asset = {
        id: 'a' + uid(), ownerId: u.id, title, category, description, price,
        fileName: file ? file.name : fileName, fileMime: file ? file.mime : 'application/octet-stream', fileSize: file ? file.size : 0,
        status: 'pending', rejectReason: null, sales: 0, createdAt: now(), updatedAt: now(), approvedAt: null,
      };
      if (file) {
        if (file.size > cfg.maxUploadBytes) return fail('invalid', 'File is too large (max 20 MB).');
        try { await files.put(asset.id, file); }
        catch (err) { console.error(err); return fail('storage', 'Could not store the file.'); }
      }
      store.put('assets', asset);
      flush();
      return ok({ id: asset.id, status: 'pending' });
    }

    async function listApproved() {
      return ok(all('assets').filter(a => a.status === 'approved').sort((x, y) => y.createdAt - x.createdAt).map(summarize));
    }
    async function topSelling(n = 6) {
      return ok(all('assets').filter(a => a.status === 'approved').sort((x, y) => y.sales - x.sales).slice(0, n).map(summarize));
    }
    async function getAsset(id, viewerId) {
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'This asset could not be found.');
      const viewer = viewerId ? dbUser(viewerId) : null;
      const isOwner = !!viewer && viewer.id === a.ownerId;
      const isAdminView = !!viewer && viewer.role === 'admin';
      if (a.status !== 'approved' && !isOwner && !isAdminView) return fail('notfound', 'This asset is not available yet.');
      const purchase = viewer ? all('purchases').find(p => p.assetId === id && p.buyerId === viewer.id) : null;
      return ok({
        ...summarize(a),
        description: a.description,
        isOwner,
        hasPurchased: !!purchase,
        canDownload: !!(isOwner || isAdminView || purchase),
        purchase,
      });
    }

    async function updateAsset(user, id, { title, category, description, price, fileName, fileData } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      if (a.ownerId !== u.id) return fail('forbidden', 'Only the creator of this asset can edit it.');
      if (!canPost(u)) return fail('timeout', 'You are currently restricted and cannot edit posts.');
      if (title !== undefined) {
        title = String(title || '').trim();
        if (title.length < 3 || title.length > 60) return fail('invalid', 'Title must be 3–60 characters.');
        a.title = title;
      }
      if (category !== undefined) {
        category = String(category).toLowerCase();
        if (!CATEGORIES.includes(category)) return fail('invalid', 'Choose a valid category.');
        a.category = category;
      }
      if (description !== undefined) {
        description = String(description || '').trim();
        if (description.length < 10) return fail('invalid', 'A full description is required (at least 10 characters).');
        a.description = description;
      }
      if (price !== undefined) {
        price = Number(price);
        if (!Number.isFinite(price) || price <= 0 || price > 999999) return fail('invalid', 'Price must be a positive number of Robux.');
        a.price = price;
      }
      const file = normalizeFile(fileData, fileName);
      if (file) {
        if (file.size > cfg.maxUploadBytes) return fail('invalid', 'File is too large (max 20 MB).');
        a.fileName = file.name; a.fileMime = file.mime; a.fileSize = file.size;
        try { await files.put(a.id, file); } catch (err) { console.error(err); return fail('storage', 'Could not store the file.'); }
      }
      a.status = 'pending'; // any change re-enters the approval queue
      a.rejectReason = null;
      a.updatedAt = now();
      store.put('assets', a);
      flush();
      return ok({ id: a.id, status: 'pending' });
    }

    function cascadeDelete(id) {
      const commentIds = all('comments').filter(c => c.assetId === id).map(c => c.id);
      all('comments').filter(c => c.assetId === id).forEach(c => store.del('comments', c.id));
      all('purchases').filter(p => p.assetId === id).forEach(p => store.del('purchases', p.id));
      all('reviews').filter(r => r.assetId === id).forEach(r => store.del('reviews', r.id));
      all('reports').filter(rp => (rp.targetType === 'asset' && rp.targetId === id) || (rp.targetType === 'comment' && commentIds.includes(rp.targetId))).forEach(rp => store.del('reports', rp.id));
      files.del(id);
      store.del('assets', id);
    }

    async function deleteAsset(user, id) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      if (a.ownerId !== u.id) return fail('forbidden', 'Only the creator of this asset can delete it.');
      cascadeDelete(id);
      flush();
      return ok(true);
    }

    async function myAssets(user) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      return ok(all('assets').filter(a => a.ownerId === u.id).sort((x, y) => y.createdAt - x.createdAt).map(summarize));
    }

    async function download(user, id) {
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      const v = resolveUser(user);
      const isOwner = v && v.id === a.ownerId;
      const isAdminView = v && v.role === 'admin';
      const hasPurchased = v && all('purchases').some(p => p.assetId === id && p.buyerId === v.id);
      if (!isOwner && !isAdminView && !hasPurchased) return fail('forbidden', 'Purchase this asset to download the file.');
      return ok({ fileName: a.fileName, mime: a.fileMime, size: a.fileSize });
    }

    /* ============ PURCHASES & LICENSES ============ */
    async function purchase(user, id) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot make purchases.');
      if (isBanned(u)) return fail('banned', 'Your account is banned.');
      if (a.status !== 'approved') return fail('notfound', 'This asset is not available for purchase.');
      if (a.ownerId === u.id) return fail('self', 'You cannot purchase your own asset.');
      if (all('purchases').some(p => p.assetId === id && p.buyerId === u.id)) return fail('owned', 'You already own this asset.');
      const key = 'KP-' + randomToken(4).toUpperCase().match(/.{1,4}/g).join('-');
      store.put('purchases', { id: 'p' + uid(), assetId: id, buyerId: u.id, price: a.price, licenseKey: key, gameId: null, gameName: '', createdAt: now() });
      a.sales = (a.sales || 0) + 1;
      store.put('assets', a);
      flush();
      return ok({ licenseKey: key });
    }

    async function myPurchases(user) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      return ok(all('purchases').filter(p => p.buyerId === u.id).sort((x, y) => y.createdAt - x.createdAt).map(p => ({ ...p, asset: summarize(byIdIn('assets', p.assetId)) })));
    }

    async function assignLicense(user, purchaseId, { gameId, gameName } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const p = byIdIn('purchases', purchaseId);
      if (!p || p.buyerId !== u.id) return fail('forbidden', 'License not found.');
      gameId = String(gameId || '').trim();
      if (!/^\d{6,20}$/.test(gameId)) return fail('invalid', 'Enter a valid Roblox game ID (digits only).');
      p.gameId = gameId;
      p.gameName = String(gameName || '').trim().slice(0, 60);
      store.put('purchases', p);
      flush();
      return ok(true);
    }

    /* ============ COMMENTS ============ */
    async function addComment(user, assetId, body) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot comment.');
      if (isBanned(u)) return fail('banned', 'Your account is banned.');
      const a = byIdIn('assets', assetId);
      if (!a) return fail('notfound', 'Asset not found.');
      if (a.status !== 'approved') return fail('notfound', 'This asset is not available yet.');
      body = String(body || '').trim();
      if (!body) return fail('invalid', 'Write a comment first.');
      if (body.length > 1000) return fail('invalid', 'Comments are limited to 1000 characters.');
      store.put('comments', { id: 'c' + uid(), assetId, userId: u.id, body, createdAt: now() });
      flush();
      return ok(true);
    }
    async function listComments(assetId) {
      const a = byIdIn('assets', assetId);
      if (!a || a.status !== 'approved') return ok([]);
      return ok(all('comments').filter(c => c.assetId === assetId).sort((x, y) => y.createdAt - x.createdAt).map(c => ({ ...c, user: publicUser(dbUser(c.userId)) })));
    }

    /* ============ REVIEWS & RATINGS ============ */
    async function listReviews(assetId) {
      const a = byIdIn('assets', assetId);
      if (!a || a.status !== 'approved') return ok({ avg: 0, count: 0, items: [] });
      const items = all('reviews').filter(r => r.assetId === assetId).sort((x, y) => y.createdAt - x.createdAt)
        .map(r => ({ id: r.id, assetId: r.assetId, rating: r.rating, body: r.body, createdAt: r.createdAt, updatedAt: r.updatedAt, user: publicUser(dbUser(r.userId)) }));
      const count = items.length;
      const avg = count ? Math.round((items.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10 : 0;
      return ok({ avg, count, items });
    }
    async function addReview(user, assetId, { rating, body } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot review assets.');
      if (isBanned(u)) return fail('banned', 'Your account is banned.');
      const a = byIdIn('assets', assetId);
      if (!a) return fail('notfound', 'Asset not found.');
      if (a.status !== 'approved') return fail('notfound', 'This asset is not available yet.');
      if (a.ownerId === u.id) return fail('self', 'You cannot review your own asset.');
      rating = Number(rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail('invalid', 'Pick a star rating from 1 to 5.');
      body = String(body || '').trim().slice(0, 1000);
      const existing = all('reviews').find(r => r.assetId === assetId && r.userId === u.id);
      const t = now();
      if (existing) {
        existing.rating = rating;
        existing.body = body;
        existing.updatedAt = t;
        store.put('reviews', existing);
      } else {
        store.put('reviews', { id: 'r' + uid(), assetId, userId: u.id, rating, body, createdAt: t, updatedAt: t });
      }
      flush();
      return ok(true);
    }
    async function deleteReview(user, reviewId) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const r = byIdIn('reviews', reviewId);
      if (!r) return fail('notfound', 'Review not found.');
      if (r.userId !== u.id) return fail('forbidden', 'Only the author of this review can delete it.');
      store.del('reviews', reviewId);
      flush();
      return ok(true);
    }

    /* ============ REPORTS ============ */
    const REPORT_TYPES = ['asset', 'comment', 'user'];
    async function createReport(user, { targetType, targetId, reason, details } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      if (isBanned(u)) return fail('banned', 'Your account is banned.');
      targetType = String(targetType || '').toLowerCase();
      if (!REPORT_TYPES.includes(targetType)) return fail('invalid', 'Invalid report target.');
      reason = String(reason || '').trim();
      details = String(details || '').trim().slice(0, 1000);
      if (reason.length < 3 || reason.length > 200) return fail('invalid', 'Choose or describe a reason for this report.');
      let self = false;
      if (targetType === 'asset') { const a = byIdIn('assets', targetId); if (!a) return fail('notfound', 'This asset does not exist.'); self = a.ownerId === u.id; }
      else if (targetType === 'comment') { const c = byIdIn('comments', targetId); if (!c) return fail('notfound', 'This comment does not exist.'); self = c.userId === u.id; }
      else { const t = dbUser(targetId); if (!t) return fail('notfound', 'This user does not exist.'); self = t.id === u.id; }
      if (self) return fail('self', 'You cannot report your own content.');
      if (all('reports').some(r => r.reporterId === u.id && r.targetType === targetType && r.targetId === targetId && r.status === 'open'))
        return fail('duplicate', 'You have already reported this. Our team will review it.');
      store.put('reports', { id: 'r' + uid(), reporterId: u.id, targetType, targetId, reason, details, status: 'open', resolvedBy: null, resolvedAt: null, createdAt: now() });
      flush();
      return ok(true);
    }
    function reportContext(rep) {
      const out = { id: rep.id, reporterId: rep.reporterId, targetType: rep.targetType, targetId: rep.targetId, reason: rep.reason, details: rep.details, status: rep.status, resolvedBy: rep.resolvedBy, resolvedAt: rep.resolvedAt, createdAt: rep.createdAt, reporter: publicUser(dbUser(rep.reporterId)) };
      if (rep.targetType === 'asset') out.asset = summarize(byIdIn('assets', rep.targetId));
      else if (rep.targetType === 'comment') {
        const c = byIdIn('comments', rep.targetId);
        const a = c ? byIdIn('assets', c.assetId) : null;
        out.comment = c ? { id: c.id, body: c.body, userId: c.userId, assetId: c.assetId, assetTitle: a ? a.title : null, user: publicUser(dbUser(c.userId)) } : null;
      } else out.user = publicUser(dbUser(rep.targetId));
      return out;
    }
    async function adminReports(actor) {
      const r = requireAdmin(actor); if (r) return r;
      const rows = all('reports').slice().sort((x, y) => y.createdAt - x.createdAt);
      return ok({ open: rows.filter(x => x.status === 'open').map(reportContext), resolved: rows.filter(x => x.status === 'resolved').map(reportContext) });
    }
    async function adminResolveReport(actor, id) {
      const r = requireAdmin(actor); if (r) return r;
      const rep = byIdIn('reports', id);
      if (!rep) return fail('notfound', 'Report not found.');
      rep.status = 'resolved';
      rep.resolvedBy = actor.id;
      rep.resolvedAt = now();
      store.put('reports', rep);
      flush();
      return ok(true);
    }

    /* ============ PUBLIC PROFILE & CONTENT ============ */
    async function publicProfile(handle) {
      const u = all('users').find(x => x.handle.toLowerCase() === String(handle || '').toLowerCase());
      if (!u) return fail('notfound', 'This user does not exist.');
      const assets = all('assets').filter(a => a.ownerId === u.id && a.status === 'approved').sort((x, y) => y.createdAt - x.createdAt).slice(0, 12).map(summarize);
      const purchases = all('purchases').filter(p => p.buyerId === u.id).sort((x, y) => y.createdAt - x.createdAt).slice(0, 8).map(p => ({ ...p, asset: summarize(byIdIn('assets', p.assetId)) }));
      const comments = all('comments').filter(c => c.userId === u.id).sort((x, y) => y.createdAt - x.createdAt).slice(0, 8).map(c => ({ ...c, asset: byIdIn('assets', c.assetId) ? summarize(byIdIn('assets', c.assetId)) : null }));
      return ok({ user: publicUser(u), assetCount: all('assets').filter(a => a.ownerId === u.id && a.status === 'approved').length, assets, purchases, comments });
    }
    async function content() {
      return ok({ portfolio: all('portfolio').slice().sort((a, b) => a.id < b.id ? -1 : 1), creators: all('creators').slice().sort((a, b) => a.id < b.id ? -1 : 1) });
    }

    /* ============ ADMIN ============ */
    async function adminOverview(actor) {
      const r = requireAdmin(actor); if (r) return r;
      return ok({
        users: all('users').length,
        assets: all('assets').length,
        pending: all('assets').filter(a => a.status === 'pending').length,
        approved: all('assets').filter(a => a.status === 'approved').length,
        sales: all('purchases').length,
        revenue: all('purchases').reduce((s, p) => s + p.price, 0),
        comments: all('comments').length,
        reviews: all('reviews').length,
        reports: all('reports').filter(x => x.status === 'open').length,
        online: all('sessions').filter(s => now() - s.lastSeen < cfg.onlineWindowMs).length,
        banned: all('users').filter(u => u.banned).length,
        timedOut: all('users').filter(u => isTimedOut(u)).length,
      });
    }
    async function adminPending(actor) { const r = requireAdmin(actor); if (r) return r; return ok(all('assets').filter(a => a.status === 'pending').sort((x, y) => y.createdAt - x.createdAt).map(summarize)); }
    async function adminRejected(actor) { const r = requireAdmin(actor); if (r) return r; return ok(all('assets').filter(a => a.status === 'rejected').sort((x, y) => y.createdAt - x.createdAt).map(summarize)); }
    async function adminApprove(actor, id) {
      const r = requireAdmin(actor); if (r) return r;
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      a.status = 'approved'; a.rejectReason = null; a.approvedAt = now(); a.updatedAt = now();
      store.put('assets', a);
      flush();
      return ok(true);
    }
    async function adminReject(actor, id, reason) {
      const r = requireAdmin(actor); if (r) return r;
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      reason = String(reason || '').trim().slice(0, 300);
      a.status = 'rejected'; a.rejectReason = reason || 'Rejected by an administrator.'; a.updatedAt = now();
      store.put('assets', a);
      flush();
      return ok(true);
    }
    async function adminAssets(actor) { const r = requireAdmin(actor); if (r) return r; return ok(all('assets').slice().sort((x, y) => y.createdAt - x.createdAt).map(summarize)); }
    async function adminDeleteAsset(actor, id) {
      const r = requireAdmin(actor); if (r) return r;
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      cascadeDelete(id);
      flush();
      return ok(true);
    }
    async function adminUsers(actor) {
      const r = requireAdmin(actor); if (r) return r;
      return ok(all('users').slice().sort((a, b) => a.createdAt - b.createdAt).map(u => ({
        ...publicUser(u), banned: u.banned, banReason: u.banReason || null, timeoutUntil: u.timeoutUntil, email: u.email,
      })));
    }
    async function adminBan(actor, targetId, reason) {
      const r = requireAdmin(actor); if (r) return r;
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      if (t.role === 'admin') return fail('adminProtected', 'Admins cannot be moderated. Admin accounts are protected from bans and timeouts.');
      t.banned = true; t.banReason = String(reason || '').trim() || 'Banned by an administrator.'; t.timeoutUntil = null; t.updatedAt = now();
      store.put('users', t);
      all('sessions').filter(s => s.userId === t.id).forEach(s => store.del('sessions', s.id));
      flush();
      return ok(true);
    }
    async function adminUnban(actor, targetId) {
      const r = requireAdmin(actor); if (r) return r;
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      t.banned = false; t.banReason = null; t.updatedAt = now();
      store.put('users', t);
      flush();
      return ok(true);
    }
    async function adminTimeout(actor, targetId, minutes) {
      const r = requireAdmin(actor); if (r) return r;
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      if (t.role === 'admin') return fail('adminProtected', 'Admins cannot be moderated. Admin accounts are protected from bans and timeouts.');
      minutes = Math.max(1, Math.min(10080, Number(minutes) || 30));
      t.timeoutUntil = now() + minutes * 6e4;
      t.banned = false;
      t.updatedAt = now();
      store.put('users', t);
      flush();
      return ok(true);
    }
    async function adminClearTimeout(actor, targetId) {
      const r = requireAdmin(actor); if (r) return r;
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      t.timeoutUntil = null; t.updatedAt = now();
      store.put('users', t);
      flush();
      return ok(true);
    }
    async function adminSetRole(actor, targetId, role) {
      const r = requireAdmin(actor); if (r) return r;
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      if (t.id === actor.id) return fail('self', 'You cannot change your own role.');
      if (t.role === 'admin') return fail('adminProtected', 'Admins are protected — you cannot change another admin\u2019s role.');
      if (!ROLES.includes(String(role || ''))) return fail('invalid', 'Invalid role.');
      t.role = role; t.updatedAt = now();
      store.put('users', t);
      flush();
      return ok(true);
    }
    async function adminSessions(actor) {
      const r = requireAdmin(actor); if (r) return r;
      pruneSessions();
      const rows = all('sessions').slice().sort((a, b) => b.lastSeen - a.lastSeen).map(s => ({ ...s, user: publicUser(dbUser(s.userId)), online: now() - s.lastSeen < cfg.onlineWindowMs }));
      return ok({ total: rows.length, online: rows.filter(x => x.online).length, rows });
    }
    async function adminEmails(actor) {
      const r = requireAdmin(actor); if (r) return r;
      return ok(all('emails').slice().reverse());
    }

    seedContent();

    return {
      register, login, verify2fa, requestReset, resetPassword, logout, me,
      updateProfile, setup2fa, enable2fa, disable2fa,
      createAsset, listApproved, topSelling, getAsset, updateAsset, deleteAsset, myAssets, download,
      purchase, myPurchases, assignLicense,
      addComment, listComments,
      listReviews, addReview, deleteReview,
      createReport, adminReports, adminResolveReport,
      publicProfile, content,
      adminOverview, adminPending, adminRejected, adminApprove, adminReject, adminAssets, adminDeleteAsset,
      adminUsers, adminBan, adminUnban, adminTimeout, adminClearTimeout, adminSetRole, adminSessions, adminEmails,
    };
  }

  return { createEngine, totpCode };
});
