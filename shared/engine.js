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
  /* Role hierarchy (index = rank). Owner and Co-Founder can do everything;
     Admin can do everything except grant roles at admin level or higher;
     VIP / Licensed creators can post; Members browse, buy, comment, rate. */
  const ROLES = ['member', 'vip', 'admin', 'cofounder', 'owner'];
  const ROLE_LABEL = { member: 'Member', vip: 'VIP / Licensed', admin: 'Admin', cofounder: 'Co-Founder', owner: 'Owner' };
  const roleRank = r => ROLES.indexOf(r);
  /* The studio creator's account bypasses every permission gate by identity —
     even if its stored role is changed, it keeps full Owner powers and is
     restored to Owner on boot (see ensureOwnerAccount). */
  const OWNER_HANDLE = 'chikaladepepe';
  const OWNER_EMAIL = 'julianguinto0@gmail.com';
  const isOwnerAccount = u => !!u && (String(u.handle || '').toLowerCase() === OWNER_HANDLE || String(u.email || '').toLowerCase() === OWNER_EMAIL);
  const effRank = u => isOwnerAccount(u) ? roleRank('owner') : roleRank(u && u.role);
  const isStaff = u => effRank(u) >= roleRank('admin');

  /* ---- regional pricing: base USD, converted to the buyer's country ---- */
  const COUNTRY_CURRENCY = { US: 'USD', PH: 'PHP', GB: 'GBP', CA: 'CAD', AU: 'AUD', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', PT: 'EUR', IE: 'EUR', JP: 'JPY', KR: 'KRW', IN: 'INR', SG: 'SGD', MY: 'MYR', ID: 'IDR', BR: 'BRL', MX: 'MXN', AE: 'AED', SA: 'SAR', ZA: 'ZAR', NG: 'NGN', GH: 'GHS', KE: 'KES', EG: 'EGP', TR: 'TRY', RU: 'RUB', CN: 'CNY', HK: 'HKD', TW: 'TWD', TH: 'THB', VN: 'VND', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN' };
  const FX_FALLBACK = { USD: 1, PHP: 56.5, GBP: 0.79, CAD: 1.36, AUD: 1.5, EUR: 0.92, JPY: 150, KRW: 1330, INR: 83.5, SGD: 1.35, MYR: 4.7, IDR: 15800, BRL: 5.1, MXN: 17.2, AED: 3.67, SAR: 3.75, ZAR: 18.5, NGN: 1480, GHS: 15.4, KES: 129, EGP: 48, TRY: 32.5, RUB: 92, CNY: 7.2, HKD: 7.8, TWD: 32, THB: 36.5, VND: 25400, ARS: 890, CLP: 940, COP: 3900, PEN: 3.7 };
  const CURRENCY_SYMBOL = { USD: '$', PHP: '₱', GBP: '£', CAD: 'C$', AUD: 'A$', EUR: '€', JPY: '¥', KRW: '₩', INR: '₹', SGD: 'S$', MYR: 'RM', IDR: 'Rp', BRL: 'R$', MXN: 'Mex$', AED: 'د.إ', SAR: '﷼', ZAR: 'R', NGN: '₦', GHS: 'GH₵', KES: 'KSh', EGP: 'E£', TRY: '₺', RUB: '₽', CNY: '¥', HKD: 'HK$', TWD: 'NT$', THB: '฿', VND: '₫', ARS: '$', CLP: '$', COP: '$', PEN: 'S/' };

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
  const canPost = u => effRank(u) >= roleRank('vip') && !isBanned(u) && !isTimedOut(u);
  const isAdmin = u => isStaff(u);
  const parseTags = u => {
    try { const t = JSON.parse(u && u.tags || '[]'); return Array.isArray(t) ? t.filter(x => typeof x === 'string' && x.trim()) : []; }
    catch (e) { return []; }
  };
  const normTag = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const saveTags = (u, tags) => {
    const seen = new Set();
    const clean = (tags || []).map(t => String(t || '').trim()).filter(Boolean)
      .filter(t => { const k = normTag(t); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 6).map(t => t.slice(0, 24));
    u.tags = JSON.stringify(clean);
  };
  const publicUser = u => u ? ({ id: u.id, handle: u.handle, displayName: u.displayName, role: u.role, tags: parseTags(u), pfp: u.pfp, bio: u.bio, createdAt: u.createdAt }) : null;
  const selfUser = u => u ? ({ ...publicUser(u), email: u.email, banned: u.banned, timeoutUntil: u.timeoutUntil, totpEnabled: u.totpEnabled, country: u.country, acceptedTermsAt: u.acceptedTermsAt || null }) : null;
  function timeoutText(u) {
    if (!u || !u.timeoutUntil) return null;
    const ms = u.timeoutUntil - now();
    if (ms <= 0) return null;
    const h = Math.floor(ms / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    return (h > 0 ? h + 'h ' : '') + m + 'm';
  }
  const okHandle = h => /^[a-zA-Z0-9_]{3,20}$/.test(h || '');
  const okEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

  /* ---- studio content (creators are content rows, NOT accounts) ----
     The portfolio is admin-published (see createPortfolio below) and starts
     empty — legacy seeded demo rows are removed on boot. */
  const CONTENT = {
    creators: [] // cleared — admins publish creators individually with account links
  };

  function createEngine(deps) {
    const store = deps.store, files = deps.files, mail = deps.mail;
    const cfg = Object.assign(
      { autoAdminFirstUser: true, devMail: true, onlineWindowMs: 10 * 6e4, sessionTtlMs: 30 * 24 * 36e5, maxUploadBytes: 20 * 1024 * 1024, currency: 'USD', priceMultiplier: 1 },
      deps.config || {}
    );
    const fx = Object.assign({}, FX_FALLBACK, cfg.fx || {});
    const currencyOf = c => COUNTRY_CURRENCY[String(c || '').toUpperCase()] || 'USD';
    const fxRate = cur => Number(fx[cur] || 1);
    const convertPrice = (usd, country) => Math.max(1, Math.round((Number(usd) || 0) * fxRate(currencyOf(country))));
    function setFx(rates) { if (rates && typeof rates === 'object') Object.assign(fx, rates); }
    const all = t => store.all(t);
    const byIdIn = (t, id) => store.get(t, id);
    const flush = () => { if (store.flush) store.flush(); };
    const dbUser = id => byIdIn('users', id);
    const resolveUser = user => (user && user.id) ? dbUser(user.id) : null;
    const requireAdmin = actor => {
      if (!actor) return fail('auth', 'You must be logged in as an admin.');
      if (!isStaff(actor)) return fail('adminOnly', 'You do not have permission to do that.');
      return null;
    };
    /* Posting cooldown — one new post per 24h for creators (admins are exempt). */
    const POST_COOLDOWN_MS = cfg.postCooldownMs || 24 * 36e5;
    function cooldownInfo(u) {
      if (!u || isAdmin(u) || !canPost(u)) return null;
      const posts = all('assets').filter(a => a.ownerId === u.id).sort((x, y) => y.createdAt - x.createdAt);
      if (!posts.length) return null;
      const last = posts[0].createdAt;
      const remainingMs = POST_COOLDOWN_MS - (now() - last);
      if (remainingMs <= 0) return null;
      const h = Math.floor(remainingMs / 36e5), m = Math.floor((remainingMs % 36e5) / 6e4);
      return { allowed: false, nextPostAt: last + POST_COOLDOWN_MS, remainingMs, text: (h > 0 ? h + 'h ' : '') + m + 'm' };
    }
    async function postStatus(user) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      if (!canPost(u)) return ok({ allowed: false, reason: u.role === 'member' ? 'member' : 'restricted' });
      const c = cooldownInfo(u);
      return ok(c ? { allowed: false, reason: 'cooldown', ...c } : { allowed: true });
    }

    function seedContent() {
      /* Clear the legacy seeded portfolio rows so the page starts empty and is
         fully admin-published from here on. */
      ['pp1', 'pp2', 'pp3', 'pp4', 'pp5', 'pp6'].forEach(id => { if (byIdIn('portfolio', id)) store.del('portfolio', id); });
      if (all('creators').length) return;
      CONTENT.creators.forEach(r => store.put('creators', r));
      flush();
    }
    /* The studio is owned by the account registered with this handle/email.
       That account can never lose full access: on every boot it is restored to
       Owner (with the Co-Founder tag) no matter what role it was changed to —
       so the creator is always bypassed past every permission gate. */
    function ensureOwnerAccount() {
      const u = all('users').find(x => String(x.handle || '').toLowerCase() === OWNER_HANDLE || String(x.email || '').toLowerCase() === OWNER_EMAIL);
      if (!u || u.role === 'owner') return;
      u.role = 'owner';
      const tags = parseTags(u);
      if (!tags.some(t => normTag(t) === 'cofounder')) tags.push('cofounder');
      saveTags(u, tags);
      u.updatedAt = now();
      store.put('users', u);
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

    /* Rating = the most recent star rating per user, taken from either a
       review or a rated comment (comments now require stars). */
    function assetRating(a) {
      const map = {};
      all('comments').filter(c => c.assetId === a.id && c.rating).forEach(c => {
        if (!map[c.userId] || c.createdAt > map[c.userId].t) map[c.userId] = { t: c.createdAt, r: c.rating };
      });
      all('reviews').filter(r => r.assetId === a.id).forEach(r => {
        if (!map[r.userId] || r.updatedAt > map[r.userId].t) map[r.userId] = { t: r.updatedAt, r: r.rating };
      });
      const vals = Object.keys(map).map(k => map[k]);
      if (!vals.length) return null;
      return { rating: Math.round((vals.reduce((s, v) => s + v.r, 0) / vals.length) * 10) / 10, count: vals.length };
    }
    const likeCount = id => all('likes').filter(l => l.assetId === id).length;
    const likedBy = (id, userId) => !!(userId && all('likes').some(l => l.assetId === id && l.userId === userId));
    /* Trending score — likes + ratings + sales, decayed by age so fresh
       engagement rises to the top of the front page. */
    function hotScore(a) {
      const rv = assetRating(a);
      const hours = Math.max(0.1, (now() - (a.createdAt || now())) / 36e5);
      const pop = (a.sales || 0) * 42 + likeCount(a.id) * 20 + (rv ? rv.count * 7 + (rv.rating || 0) * 6 : 0);
      return pop / Math.pow(hours + 3, 0.5);
    }
    function summarize(a, viewerId) {
      const o = dbUser(a.ownerId);
      const rv = assetRating(a);
      return { id: a.id, title: a.title, category: a.category, price: a.price, sales: a.sales, status: a.status, createdAt: a.createdAt, rejectReason: a.rejectReason, fileName: a.fileName, imageUrl: a.imageUrl, owner: o ? publicUser(o) : null, rating: rv ? rv.rating : null, ratingCount: rv ? rv.count : 0, likes: likeCount(a.id), liked: likedBy(a.id, viewerId) };
    }
    function sendEmail(rec) {
      const row = { id: 'e' + uid(), to: rec.to, subject: rec.subject, action: rec.action, body: rec.body, link: rec.link || null, createdAt: now(), read: false };
      store.put('emails', row);
      if (mail && mail.deliver) { try { mail.deliver({ ...rec, link: rec.link }); } catch (e) { console.error('mail deliver failed', e); } }
      flush();
      return row;
    }

    /* ============ AUTH ============ */
    async function register({ handle, displayName, email, password, country, acceptTerms } = {}) {
      handle = String(handle || '').trim();
      displayName = String(displayName || '').trim();
      email = String(email || '').trim().toLowerCase();
      if (!acceptTerms) return fail('terms', 'You must accept the Privacy Policy and Terms of Use to create an account.');
      if (!okHandle(handle)) return fail('invalid', 'Handle must be 3–20 characters (letters, numbers, underscore).');
      if (all('users').some(u => u.handle.toLowerCase() === handle.toLowerCase())) return fail('taken', 'That handle is already taken.');
      if (displayName.length < 2 || displayName.length > 40) return fail('invalid', 'Display name must be 2–40 characters.');
      if (!okEmail(email)) return fail('invalid', 'Please enter a valid email address.');
      if (all('users').some(u => u.email.toLowerCase() === email)) return fail('taken', 'An account with that email already exists.');
      if (String(password || '').length < 6) return fail('invalid', 'Password must be at least 6 characters.');
      country = String(country || '').trim().toUpperCase().slice(0, 2);
      if (!COUNTRY_CURRENCY[country]) country = 'US';
      const isFirst = cfg.autoAdminFirstUser && all('users').length === 0;
      const user = {
        id: 'u' + uid(), handle, displayName, email, role: isFirst ? 'admin' : 'member',
        passHash: await hashPassword(password), bio: '', pfp: null,
        totpSecret: null, totpEnabled: false, banned: false, banReason: null, timeoutUntil: null, country,
        googleId: null, acceptedTermsAt: now(), createdAt: now(), updatedAt: now(),
      };
      store.put('users', user);
      const s = createSession(user.id);
      flush();
      return ok({ token: s.id, user: selfUser(user) });
    }

    async function login({ login, password, label, acceptTerms } = {}) {
      login = String(login || '').trim().toLowerCase();
      const u = all('users').find(x => x.handle.toLowerCase() === login || x.email.toLowerCase() === login);
      if (!u || !(await verifyPassword(String(password || ''), u.passHash))) return fail('bad', 'Incorrect handle/email or password.');
      if (u.banned) return fail('banned', 'This account has been banned by an administrator.');
      if (u.acceptedTermsAt == null && !acceptTerms) return fail('terms', 'Please accept the Privacy Policy and Terms of Use to continue.');
      if (u.acceptedTermsAt == null) { u.acceptedTermsAt = now(); u.updatedAt = now(); store.put('users', u); flush(); }
      if (u.totpEnabled) return ok({ need2fa: true, userId: u.id });
      const s = createSession(u.id, label);
      return ok({ token: s.id, user: selfUser(u) });
    }

    /* Google OAuth sign-in: finds the account by Google id or verified email,
       links it if needed, or creates a new one (secure random password — the
       user authenticates through Google from then on). Terms are accepted at
       sign-in because the Google button is gated behind the consent checkbox. */
    async function googleLogin({ googleId, email, displayName, picture } = {}) {
      googleId = String(googleId || '');
      email = String(email || '').trim().toLowerCase();
      if (!googleId || !okEmail(email)) return fail('invalid', 'Google sign-in could not get a valid profile from your Google account.');
      let u = all('users').find(x => x.googleId === googleId) || all('users').find(x => x.email.toLowerCase() === email);
      const isFirst = cfg.autoAdminFirstUser && all('users').length === 0;
      if (!u) {
        let handle = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 18);
        if (!okHandle(handle)) handle = 'user' + Math.floor(Math.random() * 999);
        const base = handle; let n = 2;
        while (all('users').some(x => x.handle.toLowerCase() === handle.toLowerCase())) handle = base.slice(0, 18 - String(n).length) + n++;
        u = {
          id: 'u' + uid(), handle, displayName: String(displayName || '').trim().slice(0, 40) || email.split('@')[0],
          email, role: isFirst ? 'admin' : 'member', passHash: await hashPassword(randomToken(16)),
          bio: '', pfp: picture || null, totpSecret: null, totpEnabled: false, banned: false, banReason: null,
          timeoutUntil: null, country: 'US', googleId, acceptedTermsAt: now(), createdAt: now(), updatedAt: now(),
        };
        store.put('users', u);
      } else {
        u.googleId = u.googleId || googleId;
        if (u.acceptedTermsAt == null) u.acceptedTermsAt = now();
        if (picture && !u.pfp) u.pfp = picture;
        u.updatedAt = now();
        store.put('users', u);
      }
      const s = createSession(u.id, 'Google');
      flush();
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
    async function updateProfile(user, { displayName, handle, bio, pfp, country } = {}) {
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
      if (country !== undefined) {
        country = String(country || '').trim().toUpperCase().slice(0, 2);
        if (COUNTRY_CURRENCY[country]) u.country = country;
      }
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

    function normalizeImageUrl(v) {
      v = String(v || '').trim();
      if (!v) return null;
      if (!/^https?:\/\//i.test(v)) return null;
      if (v.length > 2000) return null;
      return v;
    }
    async function createAsset(user, { title, category, description, price, fileName, fileData, imageUrl } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to post assets.');
      if (!canPost(u)) {
        if (u.role === 'member') return fail('vipOnly', 'Only VIP / Licensed creators can post assets. Members can comment and purchase.');
        if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot post assets.');
        return fail('auth', 'You must be logged in to post assets.');
      }
      const cd = cooldownInfo(u);
      if (cd) return fail('cooldown', 'Posting cooldown active — you can post again in ' + cd.text + '.');
      title = String(title || '').trim();
      description = String(description || '').trim();
      price = Number(price);
      category = String(category || '').toLowerCase();
      if (title.length < 3 || title.length > 60) return fail('invalid', 'Title must be 3–60 characters.');
      if (!CATEGORIES.includes(category)) return fail('invalid', 'Choose a valid category: Animation, Model, Plugin, or System.');
      if (description.length < 10) return fail('invalid', 'A full description is required (at least 10 characters).');
      if (!Number.isFinite(price) || price <= 0 || price > 999999) return fail('invalid', 'Price must be a positive number of USD.');
      const img = normalizeImageUrl(imageUrl);
      if (img === null && String(imageUrl || '').trim()) return fail('invalid', 'Image link must be a valid http(s) URL.');
      const file = normalizeFile(fileData, fileName);
      if (!img && !fileName && !file) return fail('invalid', 'Please add an image link (or upload the asset file).');
      const asset = {
        id: 'a' + uid(), ownerId: u.id, title, category, description, price,
        fileName: file ? file.name : fileName, fileMime: file ? file.mime : 'application/octet-stream', fileSize: file ? file.size : 0,
        imageUrl: img, status: 'pending', rejectReason: null, sales: 0, createdAt: now(), updatedAt: now(), approvedAt: null,
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

    async function listApproved(viewerId) {
      return ok(all('assets').filter(a => a.status === 'approved').sort((x, y) => hotScore(y) - hotScore(x)).map(a => summarize(a, viewerId)));
    }
    async function topSelling(n = 6, viewerId) {
      return ok(all('assets').filter(a => a.status === 'approved').sort((x, y) => y.sales - x.sales).slice(0, n).map(a => summarize(a, viewerId)));
    }
    async function getAsset(id, viewerId) {
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'This asset could not be found.');
      const viewer = viewerId ? dbUser(viewerId) : null;
      const isOwner = !!viewer && viewer.id === a.ownerId;
      const isAdminView = !!viewer && isStaff(viewer);
      if (a.status !== 'approved' && !isOwner && !isAdminView) return fail('notfound', 'This asset is not available yet.');
      const purchase = viewer ? all('purchases').find(p => p.assetId === id && p.buyerId === viewer.id) : null;
      return ok({
        ...summarize(a, viewerId),
        description: a.description,
        isOwner,
        hasPurchased: !!purchase,
        canDownload: !!(isOwner || isAdminView || purchase),
        purchase,
      });
    }

    async function updateAsset(user, id, { title, category, description, price, fileName, fileData, imageUrl } = {}) {
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
        if (!Number.isFinite(price) || price <= 0 || price > 999999) return fail('invalid', 'Price must be a positive number of USD.');
        a.price = price;
      }
      if (imageUrl !== undefined) {
        const img = normalizeImageUrl(imageUrl);
        if (img === null && String(imageUrl || '').trim()) return fail('invalid', 'Image link must be a valid http(s) URL.');
        a.imageUrl = img;
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
      const purchaseIds = all('purchases').filter(p => p.assetId === id).map(p => p.id);
      all('comments').filter(c => c.assetId === id).forEach(c => store.del('comments', c.id));
      all('purchases').filter(p => p.assetId === id).forEach(p => store.del('purchases', p.id));
      all('likes').filter(l => l.assetId === id).forEach(l => store.del('likes', l.id));
      all('devices').filter(d => d.assetId === id || purchaseIds.includes(d.purchaseId)).forEach(d => store.del('devices', d.id));
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
      const isAdminView = v && isStaff(v);
      const hasPurchased = v && all('purchases').some(p => p.assetId === id && p.buyerId === v.id);
      if (!isOwner && !isAdminView && !hasPurchased) return fail('forbidden', 'Purchase this asset to download the file.');
      return ok({ fileName: a.fileName, mime: a.fileMime, size: a.fileSize });
    }

    /* ============ PURCHASES & LICENSES ============ */
    /* Issue the license, bump sales, and auto-upgrade Members → VIP / Licensed
       creators (that is the whole point of buying a license: you can post). */
    function grantLicense(u, a) {
      const key = 'KP-' + randomToken(4).toUpperCase().match(/.{1,4}/g).join('-');
      store.put('purchases', { id: 'p' + uid(), assetId: a.id, buyerId: u.id, price: a.price, licenseKey: key, gameId: null, gameName: '', createdAt: now() });
      a.sales = (a.sales || 0) + 1;
      store.put('assets', a);
      let vipUpgrade = false;
      if (u.role === 'member') { u.role = 'vip'; u.updatedAt = now(); store.put('users', u); vipUpgrade = true; }
      flush();
      return { licenseKey: key, vipUpgrade };
    }

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
      const r = grantLicense(u, a);
      return ok(r);
    }

    /* ---- payment orders (Stripe · PayPal · GCash) ---- */
    const PAY_METHODS = ['stripe', 'paypal', 'gcash'];
    /* The VIP / Licensed plan is sold directly for 500 PHP (base) — converting
       to the buyer's local currency the same way asset prices convert. */
    const VIP_PLAN_PRICE_PHP = 500;
    const convertFromPhp = (php, country) => Math.max(1, Math.round((Number(php) || 0) / fxRate('PHP') * fxRate(currencyOf(country))));
    const isVipOrder = o => !!(o && o.assetId === 'vip');
    async function createVipOrder(user, method) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      method = String(method || '').toLowerCase();
      if (!PAY_METHODS.includes(method)) return fail('invalid', 'Choose a payment method: Stripe, PayPal, or GCash.');
      if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot make purchases.');
      if (isBanned(u)) return fail('banned', 'Your account is banned.');
      if (effRank(u) >= roleRank('vip')) return fail('owned', 'Your account is already VIP / Licensed — no need to buy it again.');
      if (all('orders').some(o => o.buyerId === u.id && isVipOrder(o) && (o.status === 'created' || o.status === 'paid')))
        return fail('pending', 'You already have a pending VIP / Licensed order.');
      const currency = currencyOf(u.country);
      const amount = convertFromPhp(VIP_PLAN_PRICE_PHP, u.country);
      const order = { id: 'o' + uid(), buyerId: u.id, assetId: 'vip', method, amount, currency, status: 'created', providerRef: null, licenseKey: null, createdAt: now(), paidAt: null, updatedAt: now() };
      store.put('orders', order);
      flush();
      return ok({ orderId: order.id, amount: order.amount, currency: order.currency });
    }
    async function createOrder(user, assetId, method) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      method = String(method || '').toLowerCase();
      if (!PAY_METHODS.includes(method)) return fail('invalid', 'Choose a payment method: Stripe, PayPal, or GCash.');
      const a = byIdIn('assets', assetId);
      if (!a) return fail('notfound', 'Asset not found.');
      if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot make purchases.');
      if (isBanned(u)) return fail('banned', 'Your account is banned.');
      if (a.status !== 'approved') return fail('notfound', 'This asset is not available for purchase.');
      if (a.ownerId === u.id) return fail('self', 'You cannot purchase your own asset.');
      if (all('purchases').some(p => p.assetId === a.id && p.buyerId === u.id)) return fail('owned', 'You already own this asset.');
      if (all('orders').some(o => o.buyerId === u.id && o.assetId === a.id && (o.status === 'created' || o.status === 'paid')))
        return fail('pending', 'You already have a pending order for this asset.');
      const currency = currencyOf(u.country);
      const amount = convertPrice(a.price, u.country);
      const order = { id: 'o' + uid(), buyerId: u.id, assetId: a.id, method, amount, currency, status: 'created', providerRef: null, licenseKey: null, createdAt: now(), paidAt: null, updatedAt: now() };
      store.put('orders', order);
      flush();
      return ok({ orderId: order.id, amount: order.amount, currency: order.currency });
    }
    function finalizeOrder(order, buyer) {
      if (order.status === 'completed') return ok({ licenseKey: order.licenseKey, vipUpgrade: false });
      if (order.status !== 'paid') { order.status = 'paid'; order.paidAt = now(); }
      order.updatedAt = now();
      let out;
      if (isVipOrder(order)) {
        let vipUpgrade = false;
        if (effRank(buyer) < roleRank('vip')) { buyer.role = 'vip'; buyer.updatedAt = now(); store.put('users', buyer); vipUpgrade = true; }
        out = { licenseKey: null, vipUpgrade };
      } else {
        const a = byIdIn('assets', order.assetId);
        if (!a) return fail('notfound', 'The asset for this order no longer exists.');
        const r = grantLicense(buyer, a);
        out = { licenseKey: r.licenseKey, vipUpgrade: r.vipUpgrade };
      }
      order.status = 'completed';
      order.licenseKey = out.licenseKey;
      order.updatedAt = now();
      store.put('orders', order);
      flush();
      return ok({ licenseKey: out.licenseKey, vipUpgrade: out.vipUpgrade, method: order.method });
    }
    async function completeOrder(user, orderId, providerRef) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const order = byIdIn('orders', orderId);
      if (!order || order.buyerId !== u.id) return fail('forbidden', 'Order not found.');
      if (providerRef && !order.providerRef) { order.providerRef = String(providerRef); store.put('orders', order); }
      if (!isVipOrder(order)) {
        const a = byIdIn('assets', order.assetId);
        if (!a) return fail('notfound', 'The asset for this order no longer exists.');
      }
      return finalizeOrder(order, u);
    }
    /* Payment-confirmation path (webhook / provider verify / admin) — completes
       an order as its buyer without a user session. */
    async function settleOrder(orderId, providerRef) {
      const order = byIdIn('orders', orderId);
      if (!order) return fail('notfound', 'Order not found.');
      const buyer = dbUser(order.buyerId);
      if (!buyer) return fail('notfound', 'The buyer account no longer exists.');
      if (!isVipOrder(order)) {
        const a = byIdIn('assets', order.assetId);
        if (!a) return fail('notfound', 'The asset for this order no longer exists.');
      }
      if (providerRef && !order.providerRef) { order.providerRef = String(providerRef); store.put('orders', order); }
      return finalizeOrder(order, buyer);
    }
    async function cancelOrder(user, orderId) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const order = byIdIn('orders', orderId);
      if (!order || order.buyerId !== u.id) return fail('forbidden', 'Order not found.');
      if (order.status === 'created') { order.status = 'cancelled'; order.updatedAt = now(); store.put('orders', order); flush(); }
      return ok(true);
    }
    async function myOrders(user) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      return ok(all('orders').filter(o => o.buyerId === u.id).sort((x, y) => y.createdAt - x.createdAt).map(o => ({ ...o, vip: isVipOrder(o), asset: isVipOrder(o) ? null : summarize(byIdIn('assets', o.assetId)) })));
    }
    async function adminOrders(actor) {
      const r = requireAdmin(actor); if (r) return r;
      return ok(all('orders').slice().sort((x, y) => y.createdAt - x.createdAt).map(o => ({ ...o, vip: isVipOrder(o), buyer: publicUser(dbUser(o.buyerId)), asset: isVipOrder(o) ? null : summarize(byIdIn('assets', o.assetId)) })));
    }
    async function adminCompleteOrder(actor, orderId) {
      const r = requireAdmin(actor); if (r) return r;
      const order = byIdIn('orders', orderId);
      if (!order) return fail('notfound', 'Order not found.');
      const buyer = dbUser(order.buyerId);
      if (!buyer) return fail('notfound', 'The buyer account no longer exists.');
      if (!isVipOrder(order)) {
        const a = byIdIn('assets', order.assetId);
        if (!a) return fail('notfound', 'The asset for this order no longer exists.');
      }
      return finalizeOrder(order, buyer);
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

    /* ============ LICENSE SECURITY (creator-side protection) ============
       Every purchase already carries a unique KP- license key. These APIs let
       the creator's asset verify itself at runtime: the file calls
       licenseActivate on first run and licenseHeartbeat while it runs. The
       creator can disable a license (kill switch — the file shuts down) or
       revoke a single device (that device can no longer use the file). */
    async function licenseActivate({ licenseKey, deviceId, deviceName } = {}) {
      licenseKey = String(licenseKey || '').trim().toUpperCase();
      deviceId = String(deviceId || '').trim();
      if (!/^KP-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(licenseKey)) return fail('invalid', 'Invalid license key format.');
      if (!deviceId || deviceId.length > 128) return fail('invalid', 'A device identifier is required to activate this license.');
      const p = all('purchases').find(x => x.licenseKey === licenseKey);
      if (!p) return fail('invalid', 'This license key does not exist.');
      if (p.status === 'disabled') return fail('denied', 'This license has been disabled by the creator and can no longer be used.');
      const asset = byIdIn('assets', p.assetId);
      if (!asset) return fail('denied', 'The asset for this license no longer exists.');
      const t = now();
      const existing = all('devices').find(d => d.purchaseId === p.id && d.deviceId === deviceId);
      if (existing) {
        if (existing.status === 'revoked') return fail('denied', 'This device has been revoked and is not authorized to use the file.');
        existing.lastSeen = t;
        existing.deviceName = String(deviceName || '').trim().slice(0, 80) || existing.deviceName;
        store.put('devices', existing);
      } else {
        store.put('devices', { id: 'dv' + uid(), purchaseId: p.id, assetId: p.assetId, deviceId, deviceName: String(deviceName || '').trim().slice(0, 80), status: 'active', createdAt: t, lastSeen: t });
      }
      p.activatedAt = p.activatedAt || t;
      p.deviceId = deviceId;
      p.deviceName = String(deviceName || '').trim().slice(0, 80);
      p.lastSeen = t;
      store.put('purchases', p);
      flush();
      return ok({ status: 'active', licenseKey, asset: asset.title, activatedAt: p.activatedAt });
    }
    async function licenseHeartbeat({ licenseKey, deviceId } = {}) {
      licenseKey = String(licenseKey || '').trim().toUpperCase();
      deviceId = String(deviceId || '').trim();
      const p = all('purchases').find(x => x.licenseKey === licenseKey);
      if (!p) return fail('invalid', 'License key not found.');
      if (p.status === 'disabled') return fail('denied', 'This license has been disabled by the creator.');
      const d = all('devices').find(x => x.purchaseId === p.id && x.deviceId === deviceId);
      if (!d || d.status === 'revoked') return fail('denied', 'This device is not authorized to use the file.');
      d.lastSeen = now();
      p.lastSeen = d.lastSeen;
      store.put('devices', d);
      store.put('purchases', p);
      flush();
      return ok({ status: 'active', licenseKey });
    }
    /* The creator's own dashboard: their assets, sales-by-day for the chart,
       license/device stats, and the latest device activity. */
    async function creatorDashboard(user) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      if (!canPost(u)) return fail('vipOnly', 'Only VIP / Licensed creators have a dashboard.');
      const assets = all('assets').filter(a => a.ownerId === u.id).sort((x, y) => y.createdAt - x.createdAt);
      const ids = new Set(assets.map(a => a.id));
      const purchases = all('purchases').filter(p => ids.has(p.assetId));
      const devices = all('devices').filter(d => ids.has(d.assetId));
      const dayMs = 864e5, days = 30;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const start = today.getTime() - (days - 1) * dayMs;
      const buckets = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * dayMs);
        buckets.push({ day: d.toISOString().slice(0, 10), label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), sales: 0, revenue: 0 });
      }
      purchases.forEach(p => {
        const idx = Math.floor((p.createdAt - start) / dayMs);
        if (idx >= 0 && idx < days) { buckets[idx].sales += 1; buckets[idx].revenue += p.price; }
      });
      return ok({
        assets: assets.map(a => ({ ...summarize(a, u.id), likes: likeCount(a.id) })),
        salesByDay: buckets,
        stats: {
          totalSales: purchases.length,
          revenue: purchases.reduce((s, p) => s + p.price, 0),
          licenseKeys: purchases.length,
          activeLicenses: purchases.filter(p => p.status !== 'disabled').length,
          disabledLicenses: purchases.filter(p => p.status === 'disabled').length,
          activeDevices: devices.filter(d => d.status === 'active').length,
          revokedDevices: devices.filter(d => d.status === 'revoked').length,
        },
        recentActivity: devices.slice().sort((x, y) => y.lastSeen - x.lastSeen).slice(0, 12).map(d => {
          const p = byIdIn('purchases', d.purchaseId);
          const a = byIdIn('assets', d.assetId);
          return { id: d.id, deviceId: d.deviceId, deviceName: d.deviceName, status: d.status, lastSeen: d.lastSeen, asset: a ? summarize(a, u.id) : null, buyer: p ? publicUser(dbUser(p.buyerId)) : null };
        }),
      });
    }
    async function creatorLicenses(user, assetId) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      if (!canPost(u)) return fail('vipOnly', 'Only VIP / Licensed creators can manage licenses.');
      const assets = all('assets').filter(a => a.ownerId === u.id);
      const ids = new Set(assets.map(a => a.id));
      const list = all('purchases').filter(p => ids.has(p.assetId) && (!assetId || p.assetId === assetId))
        .sort((x, y) => y.createdAt - x.createdAt)
        .map(p => ({
          ...p,
          buyer: publicUser(dbUser(p.buyerId)),
          asset: summarize(byIdIn('assets', p.assetId), u.id),
          devices: all('devices').filter(d => d.purchaseId === p.id).sort((a, b) => b.lastSeen - a.lastSeen),
        }));
      return ok(list);
    }
    async function setLicenseStatus(user, purchaseId, status) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      if (!canPost(u)) return fail('vipOnly', 'Only the creator can manage this license.');
      const p = byIdIn('purchases', purchaseId);
      if (!p) return fail('notfound', 'License not found.');
      const a = byIdIn('assets', p.assetId);
      if (!a || a.ownerId !== u.id) return fail('forbidden', 'Only the creator of the asset can manage this license.');
      status = String(status || '');
      if (!['active', 'disabled'].includes(status)) return fail('invalid', 'Invalid license status.');
      p.status = status;
      store.put('purchases', p);
      flush();
      return ok(true);
    }
    async function revokeDevice(user, deviceId) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      if (!canPost(u)) return fail('vipOnly', 'Only the creator can revoke devices.');
      const d = byIdIn('devices', deviceId);
      if (!d) return fail('notfound', 'Device not found.');
      const a = byIdIn('assets', d.assetId);
      if (!a || a.ownerId !== u.id) return fail('forbidden', 'Only the creator of the asset can revoke this device.');
      d.status = 'revoked';
      store.put('devices', d);
      flush();
      return ok(true);
    }

    /* ============ COMMENTS ============ */
    async function addComment(user, assetId, { body, rating } = {}) {
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
      rating = Number(rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail('rating', 'Pick a star rating (1–5) to post your comment.');
      store.put('comments', { id: 'c' + uid(), assetId, userId: u.id, body, rating, createdAt: now() });
      flush();
      return ok(true);
    }
    async function listComments(assetId) {
      const a = byIdIn('assets', assetId);
      if (!a || a.status !== 'approved') return ok([]);
      return ok(all('comments').filter(c => c.assetId === assetId).sort((x, y) => y.createdAt - x.createdAt).map(c => ({ ...c, user: publicUser(dbUser(c.userId)) })));
    }

    /* ============ LIKES ============ */
    async function toggleLike(user, assetId) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to like assets.');
      const a = byIdIn('assets', assetId);
      if (!a) return fail('notfound', 'Asset not found.');
      if (a.status !== 'approved') return fail('notfound', 'This asset is not available yet.');
      const existing = all('likes').find(l => l.assetId === assetId && l.userId === u.id);
      if (existing) { store.del('likes', existing.id); flush(); return ok({ liked: false, count: likeCount(assetId) }); }
      store.put('likes', { id: 'l' + uid(), assetId, userId: u.id, createdAt: now() });
      flush();
      return ok({ liked: true, count: likeCount(assetId) });
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
      const parseLinks = it => { try { const l = JSON.parse(it.links || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; } };
      const portfolio = all('portfolio').slice().sort((a, b) => ((b.featured ? 1 : 0) - (a.featured ? 1 : 0)) || ((b.createdAt || 0) - (a.createdAt || 0))).map(it => ({ ...it, links: parseLinks(it) }));
      const creators = all('creators').slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(it => ({ ...it, links: parseLinks(it) }));
      return ok({ portfolio, creators });
    }

    /* ============ PORTFOLIO (admin-published showcase) ============ */
    function cleanPortfolioLinks(links) {
      if (!Array.isArray(links)) return [];
      return links.map(l => ({ url: String((l && l.url) || '').trim() })).filter(l => /^https?:\/\//i.test(l.url)).slice(0, 12).map(l => ({ url: l.url.slice(0, 500) }));
    }
    async function createPortfolio(actor, { title, category, desc, stat, status, imageUrl, links, featured } = {}) {
      const r = requireAdmin(actor); if (r) return r;
      title = String(title || '').trim();
      desc = String(desc || '').trim();
      if (title.length < 3 || title.length > 80) return fail('invalid', 'Project title must be 3–80 characters.');
      if (desc.length < 10) return fail('invalid', 'A description is required (at least 10 characters).');
      const img = normalizeImageUrl(imageUrl);
      const item = {
        id: 'pp' + uid(), title, category: String(category || '').trim().slice(0, 40),
        desc, stat: String(stat || '').trim().slice(0, 60), status: String(status || 'Live').trim().slice(0, 24),
        imageUrl: img, links: JSON.stringify(cleanPortfolioLinks(links)), featured: !!featured, createdAt: now(),
      };
      if (item.featured) all('portfolio').filter(x => x.featured && x.id !== item.id).forEach(x => { x.featured = false; store.put('portfolio', x); });
      store.put('portfolio', item);
      flush();
      return ok({ id: item.id });
    }
    async function updatePortfolio(actor, id, patch = {}) {
      const r = requireAdmin(actor); if (r) return r;
      const it = byIdIn('portfolio', id);
      if (!it) return fail('notfound', 'Project not found.');
      if (patch.title !== undefined) {
        const t = String(patch.title || '').trim();
        if (t.length < 3 || t.length > 80) return fail('invalid', 'Project title must be 3–80 characters.');
        it.title = t;
      }
      if (patch.desc !== undefined) {
        const d = String(patch.desc || '').trim();
        if (d.length < 10) return fail('invalid', 'A description is required (at least 10 characters).');
        it.desc = d;
      }
      if (patch.category !== undefined) it.category = String(patch.category || '').trim().slice(0, 40);
      if (patch.stat !== undefined) it.stat = String(patch.stat || '').trim().slice(0, 60);
      if (patch.status !== undefined) it.status = String(patch.status || 'Live').trim().slice(0, 24);
      if (patch.imageUrl !== undefined) {
        const img = normalizeImageUrl(patch.imageUrl);
        if (img === null && String(patch.imageUrl || '').trim()) return fail('invalid', 'Image link must be a valid http(s) URL.');
        it.imageUrl = img;
      }
      if (patch.links !== undefined) it.links = JSON.stringify(cleanPortfolioLinks(patch.links));
      if (patch.featured !== undefined) {
        it.featured = !!patch.featured;
        if (it.featured) all('portfolio').filter(x => x.featured && x.id !== it.id).forEach(x => { x.featured = false; store.put('portfolio', x); });
      }
      store.put('portfolio', it);
      flush();
      return ok(true);
    }
    async function deletePortfolio(actor, id) {
      const r = requireAdmin(actor); if (r) return r;
      const it = byIdIn('portfolio', id);
      if (!it) return fail('notfound', 'Project not found.');
      store.del('portfolio', id);
      flush();
      return ok(true);
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
        likes: all('likes').length,
        devices: all('devices').filter(d => d.status === 'active').length,
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
      if (t.id === actor.id) return fail('self', 'You cannot moderate your own account.');
      if (isStaff(t) && effRank(actor) < roleRank('cofounder')) return fail('adminProtected', 'Staff accounts (Admin and above) cannot be moderated — only the Owner / Co-Founder may manage them.');
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
      if (t.id === actor.id) return fail('self', 'You cannot moderate your own account.');
      if (isStaff(t) && effRank(actor) < roleRank('cofounder')) return fail('adminProtected', 'Staff accounts (Admin and above) cannot be moderated — only the Owner / Co-Founder may manage them.');
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
      role = String(role || '');
      if (!ROLES.includes(role)) return fail('invalid', 'Invalid role.');
      if (effRank(actor) < roleRank('cofounder')) {
        /* Plain Admins can grant Member / VIP only, and cannot touch staff or themselves. */
        if (t.id === actor.id) return fail('self', 'You cannot change your own role.');
        if (roleRank(role) >= roleRank('admin')) return fail('adminProtected', 'Admins cannot grant the Admin role or higher — only the Owner / Co-Founder can.');
        if (isStaff(t)) return fail('adminProtected', 'Staff accounts are protected — only the Owner / Co-Founder can change their roles.');
      }
      t.role = role; t.updatedAt = now();
      store.put('users', t);
      flush();
      return ok(true);
    }
    async function adminSetTags(actor, targetId, tags) {
      const r = requireAdmin(actor); if (r) return r;
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      if (effRank(actor) < roleRank('cofounder') && (isStaff(t) || t.id === actor.id)) return fail('adminProtected', 'Only the Owner / Co-Founder can edit staff accounts or their own tags.');
      const list = Array.isArray(tags) ? tags.map(x => String(x || '').trim()) : [];
      if (list.some(x => x.length > 24)) return fail('invalid', 'Tags must be 24 characters or fewer.');
      saveTags(t, list);
      t.updatedAt = now();
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

    /* ============ CREATORS (admin-published, like portfolio) ============ */
    async function createCreator(actor, { name, role, bio, links, handle } = {}) {
      const r = requireAdmin(actor); if (r) return r;
      name = String(name || '').trim();
      if (name.length < 1 || name.length > 60) return fail('invalid', 'Name is required (1–60 chars).');
      const item = {
        id: 'cr' + uid(), name,
        role: String(role || '').trim().slice(0, 60),
        bio: String(bio || '').trim().slice(0, 300),
        links: JSON.stringify(cleanPortfolioLinks(links)),
        handle: String(handle || '').trim().slice(0, 30),
        createdAt: now(),
      };
      store.put('creators', item);
      flush();
      return ok({ id: item.id });
    }
    async function updateCreator(actor, id, patch = {}) {
      const r = requireAdmin(actor); if (r) return r;
      const it = byIdIn('creators', id);
      if (!it) return fail('notfound', 'Creator not found.');
      if (patch.name !== undefined) it.name = String(patch.name || '').trim().slice(0, 60);
      if (patch.role !== undefined) it.role = String(patch.role || '').trim().slice(0, 60);
      if (patch.bio !== undefined) it.bio = String(patch.bio || '').trim().slice(0, 300);
      if (patch.handle !== undefined) it.handle = String(patch.handle || '').trim().slice(0, 30);
      if (patch.links !== undefined) it.links = JSON.stringify(cleanPortfolioLinks(patch.links));
      store.put('creators', it);
      flush();
      return ok(true);
    }
    async function deleteCreator(actor, id) {
      const r = requireAdmin(actor); if (r) return r;
      if (!byIdIn('creators', id)) return fail('notfound', 'Creator not found.');
      store.del('creators', id);
      flush();
      return ok(true);
    }

    /* ============ TICKETS & SUPPORT CHAT ============ */
    const TICKET_INACTIVITY_MS = 5 * 24 * 3600 * 1000;
    async function createTicket(user, { subject, category, details } = {}) {
      if (!user) return fail('notfound', 'User not found.');
      const u = resolveUser(user); if (!u) return fail('usernotfound', 'User not found.');
      subject = String(subject || '').trim();
      details = String(details || '').trim();
      if (subject.length < 3 || subject.length > 120) return fail('invalid', 'Subject must be 3–120 characters.');
      if (details.length < 10) return fail('invalid', 'Details must be at least 10 characters.');
      const t = now();
      const ticket = {
        id: 'tk' + uid(), userId: u.id, subject, category: String(category || '').trim().slice(0, 40),
        details, status: 'open', createdAt: t, updatedAt: t, lastActivityAt: t,
      };
      store.put('tickets', ticket);
      store.put('ticket_messages', { id: 'tm' + uid(), ticketId: ticket.id, userId: u.id, body: details, createdAt: t });
      flush();
      return ok({ id: ticket.id });
    }
    async function addTicketMessage(user, ticketId, body) {
      const u = resolveUser(user); if (!u) return fail('usernotfound', 'User not found.');
      const ticket = byIdIn('tickets', ticketId);
      if (!ticket) return fail('notfound', 'Ticket not found.');
      const isOwner = ticket.userId === u.id;
      const isStaffUser = isStaff(u);
      if (!isOwner && !isStaffUser) return fail('forbidden', 'You can only reply to your own tickets.');
      body = String(body || '').trim();
      if (body.length < 1) return fail('invalid', 'Message cannot be empty.');
      if (body.length > 4000) return fail('invalid', 'Message too long (max 4000 characters).');
      const t = now();
      const msg = { id: 'tm' + uid(), ticketId, userId: u.id, body, createdAt: t };
      store.put('ticket_messages', msg);
      ticket.updatedAt = t;
      ticket.lastActivityAt = t;
      if (ticket.status === 'closed' && isOwner) ticket.status = 'open';
      store.put('tickets', ticket);
      flush();
      return ok({ id: msg.id });
    }
    async function getTicket(user, ticketId) {
      const u = resolveUser(user); if (!u) return fail('usernotfound', 'User not found.');
      const ticket = byIdIn('tickets', ticketId);
      if (!ticket) return fail('notfound', 'Ticket not found.');
      const isOwner = ticket.userId === u.id;
      const isStaffUser = isStaff(u);
      if (!isOwner && !isStaffUser) return fail('forbidden', 'You can only view your own tickets.');
      const messages = all('ticket_messages').filter(m => m.ticketId === ticketId).sort((a, b) => a.createdAt - b.createdAt)
        .map(m => ({ ...m, user: publicUser(byIdIn('users', m.userId)) }));
      return ok({ ticket, messages });
    }
    async function listMyTickets(user) {
      const u = resolveUser(user); if (!u) return fail('usernotfound', 'User not found.');
      return ok(all('tickets').filter(t => t.userId === u.id).sort((a, b) => b.lastActivityAt - a.lastActivityAt));
    }
    async function adminListTickets(actor) {
      const r = requireAdmin(actor); if (r) return r;
      return ok(all('tickets').slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt).map(t => ({ ...t, user: publicUser(byIdIn('users', t.userId)) })));
    }
    async function adminCloseTicket(actor, ticketId) {
      const r = requireAdmin(actor); if (r) return r;
      const ticket = byIdIn('tickets', ticketId);
      if (!ticket) return fail('notfound', 'Ticket not found.');
      ticket.status = 'closed';
      ticket.updatedAt = now();
      store.put('tickets', ticket); flush();
      return ok(true);
    }
    async function adminDeleteTicket(actor, ticketId) {
      const r = requireAdmin(actor); if (r) return r;
      const ticket = byIdIn('tickets', ticketId);
      if (!ticket) return fail('notfound', 'Ticket not found.');
      all('ticket_messages').filter(m => m.ticketId === ticketId).forEach(m => store.del('ticket_messages', m.id));
      store.del('tickets', ticketId);
      flush();
      return ok(true);
    }

    seedContent();
    ensureOwnerAccount();

    return {
      register, login, googleLogin, verify2fa, requestReset, resetPassword, logout, me,
      updateProfile, setup2fa, enable2fa, disable2fa,
      createAsset, postStatus, listApproved, topSelling, getAsset, updateAsset, deleteAsset, myAssets, download,
      purchase, myPurchases, assignLicense, createOrder, createVipOrder, completeOrder, settleOrder, cancelOrder, myOrders, adminOrders, adminCompleteOrder,
      addComment, listComments, toggleLike,
      listReviews, addReview, deleteReview,
      createReport, adminReports, adminResolveReport,
      licenseActivate, licenseHeartbeat, creatorDashboard, creatorLicenses, setLicenseStatus, revokeDevice,
      publicProfile, content, createPortfolio, updatePortfolio, deletePortfolio,
      createCreator, updateCreator, deleteCreator,
      createTicket, addTicketMessage, getTicket, listMyTickets,
      adminListTickets, adminCloseTicket, adminDeleteTicket,
      adminOverview, adminPending, adminRejected, adminApprove, adminReject, adminAssets, adminDeleteAsset,
      adminUsers, adminBan, adminUnban, adminTimeout, adminClearTimeout, adminSetRole, adminSetTags, adminSessions, adminEmails, adminOrders, adminCompleteOrder,
      setFx,
    };
  }

  return { createEngine, totpCode, COUNTRY_CURRENCY, FX_FALLBACK, CURRENCY_SYMBOL, currencyOf: c => COUNTRY_CURRENCY[String(c || '').toUpperCase()] || 'USD', ROLES, ROLE_LABEL };
});
