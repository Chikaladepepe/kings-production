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

  const CATEGORIES = ['animation', 'model', 'plugin', 'system', 'tool'];
  const CAT_LABEL = { animation: 'Animation', model: 'Model', plugin: 'Plugin', system: 'System' };
  /* Role hierarchy (index = rank). Owner and Co-Founder can do everything;
     Admin can do everything except grant roles at admin level or higher;
     Licensed sellers can post; Members browse, buy, comment, rate. */
  /* 'vip' = complimentary VIP tier (Founder-granted, plays at Subscription-1
     limits, can Try the studio's own systems). 'licensed' = sellers who bought
     the Licensed upgrade. Admin+ are staff. */
  const ROLES = ['member', 'test', 'vip', 'licensed', 'admin', 'cofounder', 'owner'];
  const ROLE_LABEL = { member: 'Verified', test: 'Test', vip: 'VIP', licensed: 'Licensed', admin: 'Admin', cofounder: 'Co-Founder', owner: 'Founder' };
  const isTestRole = u => !!(u && u.role === 'test');
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
  const isRestricted = u => isBanned(u) || isTimedOut(u) || !!(u && u.restrictedUntil && u.restrictedUntil > now());
  /* Email verification: existing accounts are verified by default; new
     registrations must confirm their email. The owner account always bypasses. */
  const isVerified = u => isOwnerAccount(u) || u == null || (u.emailVerified !== false && u.emailVerified !== 0);
  /* Email verification is OPTIONAL — it only exists so a forgotten password
     can be reset. It never gates posting or purchasing. */    const canPost = u => (effRank(u) >= roleRank('licensed') || isTester(u)) && !isBanned(u) && !isTimedOut(u);
  const isAdmin = u => isStaff(u);
  /* "Test" tag — assigned by admins for QA: can grab any system/asset without
     paying so the studio can verify things work before release. */
  const isTester = u => !!(u && (u.role === 'test' || parseTags(u).some(t => String(t).trim().toLowerCase() === 'test')));
  const parseTags = u => {
    try { const t = JSON.parse(u && u.tags || '[]'); return Array.isArray(t) ? t.filter(x => typeof x === 'string' && x.trim()) : []; }
    catch (e) { return []; }
  };
  /* Complimentary VIP is a TAG, so it stacks with any role (member, licensed,
     even staff): a user can be Licensed AND VIP at once. `role` stays the
     earning/moderation tier; the tag grants VIP powers. */
  const isVipUser = u => !!(u && (u.role === 'vip' || parseTags(u).some(t => String(t).trim().toLowerCase() === 'vip')));
  const normTag = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const saveTags = (u, tags) => {
    const seen = new Set();
    const clean = (tags || []).map(t => String(t || '').trim()).filter(Boolean)
      .filter(t => { const k = normTag(t); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 6).map(t => t.slice(0, 24));
    u.tags = JSON.stringify(clean);
  };
  const publicUser = u => u ? ({ id: u.id, handle: u.handle, displayName: u.displayName, role: u.role, roleLabel: ROLE_LABEL[u.role] || 'Verified', tags: parseTags(u), pfp: u.pfp, bio: u.bio, createdAt: u.createdAt, protectionTier: Number(u.protectionTier) || 0, contractTier: Number(u.contractTier) || 0 }) : null;
  const selfUser = u => u ? ({ ...publicUser(u), email: u.email, banned: u.banned, timeoutUntil: u.timeoutUntil, totpEnabled: u.totpEnabled, country: u.country, acceptedTermsAt: u.acceptedTermsAt || null, emailVerified: u.emailVerified !== false && u.emailVerified !== 0, unsubscribed: !!(u.unsubscribed), needsPasswordSetup: !!u.needsPasswordSetup, protectionTier: Number(u.protectionTier) || 0, contractTier: Number(u.contractTier) || 0 }) : null;
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
    /* Showcase content (portfolio + creators) is the studio's voice — plain
       Admins are moderation-only and cannot create or edit it. */
    const requireCofounder = (actor, what) => {
      if (!actor) return fail('auth', 'You must be logged in.');
      if (effRank(actor) < roleRank('cofounder')) return fail('forbidden', 'Only the Co-Founder or Founder can ' + (what || 'do that') + '.');
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
    /* Free-claim reach: how many distinct users have the free system
       (completed free order). Shown as "N users" instead of "N sold". */
    const usersOf = id => new Set(all('orders').filter(o => o.assetId === id && o.method === 'free' && o.status === 'completed').map(o => o.buyerId)).size;
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
      let images = [], paymentMethods = [], sellerPaymentDetails = null;
      try { images = a.images ? JSON.parse(a.images) : []; } catch (e) {}
      try { paymentMethods = a.paymentMethods ? JSON.parse(a.paymentMethods) : []; } catch (e) {}
      try { sellerPaymentDetails = a.sellerPaymentDetails ? JSON.parse(a.sellerPaymentDetails) : null; } catch (e) {}
      return { id: a.id, title: a.title, category: a.category, description: a.description, price: a.price, sales: a.sales, users: usersOf(a.id), freeLicensed: !!a.freeLicensed, status: a.status, createdAt: a.createdAt, rejectReason: a.rejectReason, fileName: a.fileName, fileUrl: a.fileUrl || null, imageUrl: a.imageUrl, images, paymentMethods, sellerPaymentDetails, deliverDuringPending: !!a.deliverDuringPending, owner: o ? publicUser(o) : null, rating: rv ? rv.rating : null, ratingCount: rv ? rv.count : 0, likes: likeCount(a.id), liked: likedBy(a.id, viewerId) };
    }
    function sendEmail(rec) {
      const row = { id: 'e' + uid(), to: rec.to, subject: rec.subject, action: rec.action, body: rec.body, link: rec.link || null, createdAt: now(), read: false };
      store.put('emails', row);
      if (mail && mail.deliver) { try { mail.deliver({ ...rec, link: rec.link }); } catch (e) { console.error('mail deliver failed', e); } }
      flush();
      return row;
    }

    /* ============ AUTH ============ */
    /* Pre-registration email code: every new account must first request a
       6-digit code at this address and include it in register() — stops bot
       farms from stuffing the user table with dummy emails. Codes are
       single-use and expire after 15 minutes. */
    async function requestRegisterCode({ email } = {}) {
      email = String(email || '').trim().toLowerCase();
      if (!okEmail(email)) return fail('invalid', 'Please enter a valid email address.');
      if (all('users').some(u => u.email.toLowerCase() === email)) return fail('taken', 'An account with that email already exists.');
      const recent = all('pending_regs').filter(r => r.email === email).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (recent && recent.createdAt > now() - 45e3) return fail('ratelimit', 'A code was already sent — check your inbox (and spam), or wait a minute to resend.');
      all('pending_regs').filter(r => r.email === email).forEach(r => store.del('pending_regs', r.id));
      const code = String(Math.floor(100000 + Math.random() * 900000));
      store.put('pending_regs', { id: 'pr' + uid(), email, code, expiresAt: now() + 15 * 60e3, createdAt: now() });
      sendEmail({ to: email, subject: 'Your Kings Production verification code', action: 'registercode', body: 'Your verification code is: ' + code + '\n\nEnter it on the sign-up page to create your account. It expires in 15 minutes and can only be used once.', link: '#/register' });
      flush();
      return ok(Object.assign({ sent: true }, cfg.devMail ? { devCode: code } : {}));
    }
    function consumeRegisterCode(email, code) {
      const pr = all('pending_regs').find(r => r.email === email && String(r.code) === String(code || '').trim());
      if (!pr) return null;
      if (pr.expiresAt < now()) { store.del('pending_regs', pr.id); flush(); return null; }
      store.del('pending_regs', pr.id);
      flush();
      return pr;
    }
    async function register({ handle, displayName, email, password, country, acceptTerms, code } = {}) {
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
      if (!consumeRegisterCode(email, code)) return fail('code', 'Enter the 6-digit verification code we emailed you (it expires in 15 minutes).');
      country = String(country || '').trim().toUpperCase().slice(0, 2);
      if (!COUNTRY_CURRENCY[country]) country = 'US';
      const isFirst = cfg.autoAdminFirstUser && all('users').length === 0;
      const user = {
        id: 'u' + uid(), handle, displayName, email, role: isFirst ? 'admin' : 'member',
        passHash: await hashPassword(password), bio: '', pfp: null,
        totpSecret: null, totpEnabled: false, banned: false, banReason: null, timeoutUntil: null, country,
        googleId: null, acceptedTermsAt: now(), createdAt: now(), updatedAt: now(),
        emailVerified: 1, // email is OPTIONAL (account recovery only) — never gates posting
      };
      store.put('users', user);
      const s = createSession(user.id);
      /* Welcome + email verification — first (auto-admin) account is trusted. */
      let verifyLink = null;
      if (!isFirst) {
        const token = randomToken(18);
        store.put('tokens', { id: 't' + uid(), userId: user.id, token, purpose: 'verify', expiresAt: now() + 72 * 36e5, used: false, createdAt: now() });
        verifyLink = '#/verify?token=' + token;
        sendEmail({ to: user.email, subject: 'Welcome to Kings Production — verify your email (optional)', action: 'verify', body: 'Welcome to Kings Production! Verification is optional and does not unlock anything — it only lets you reset your password if you ever forget it. This link expires in 72 hours and can only be used once.', link: verifyLink });
      }
      flush();
      return ok(Object.assign({ token: s.id, user: selfUser(user) }, cfg.devMail && verifyLink ? { verifyLink } : {}));
    }
    async function verifyEmail({ token } = {}) {
      const t = all('tokens').find(x => x.token === String(token || '') && x.purpose === 'verify' && !x.used);
      if (!t) return fail('bad', 'This verification link is invalid or has already been used.');
      if (t.expiresAt < now()) return fail('expired', 'This verification link has expired. Request a new one from Settings.');
      const u = dbUser(t.userId);
      if (!u) return fail('bad', 'Account not found.');
      u.emailVerified = 1;
      u.updatedAt = now();
      store.put('users', u);
      t.used = true;
      store.put('tokens', t);
      /* Auto-welcome: once the account is verified, send the branded
         onboarding email — how to shop, licenses, and support. */
      if (u.role !== 'admin' && !isOwnerAccount(u)) {
        sendEmail({
          to: u.email, subject: 'Welcome to Kings Production, ' + (u.displayName || u.handle) + ' 👑', action: 'welcome', link: '#/shop',
          body: 'Your email is confirmed — your account is fully unlocked.\n\nHere is how to get the most out of Kings Production:\n\n• Browse the Marketplace and grab your first asset — scripts, models, plugins, animations, and systems, all hand-checked by our team.\n• Buy the VIP/Subscription plan to unlock community posting and the Licensed Dashboard, with sales analytics and device-secured licensing.\n• Register systems on the Subscription page and manage authorized devices — if a file ever leaks, the anti-tamper lock keeps it unusable to anyone else.\n\nNeed anything? Open a ticket from the Support tab and our team will reply fast.\n\nWhere excellence meets innovation.',
        });
        flush();
      }
      return ok(true);
    }
    async function resendVerification(user) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'Account not found.');
      if (isVerified(u)) return fail('already', 'Your email is already verified.');
      all('tokens').filter(t => t.userId === u.id && t.purpose === 'verify' && !t.used).forEach(t => store.del('tokens', t.id));
      const token = randomToken(18);
      store.put('tokens', { id: 't' + uid(), userId: u.id, token, purpose: 'verify', expiresAt: now() + 72 * 36e5, used: false, createdAt: now() });
      const link = '#/verify?token=' + token;
      sendEmail({ to: u.email, subject: 'Verify your Kings Production email (optional)', action: 'verify', body: 'Verification is optional — it only enables password reset for account recovery. This link expires in 72 hours.', link });
      flush();
      return ok(Object.assign({ sent: true }, cfg.devMail ? { devLink: link } : {}));
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
          email, role: isFirst ? 'admin' : 'member',          passHash: await hashPassword(randomToken(16)), needsPasswordSetup: true,
          bio: '', pfp: picture || null, totpSecret: null, totpEnabled: false, banned: false, banReason: null,
          timeoutUntil: null, country: 'US', googleId, acceptedTermsAt: now(), createdAt: now(), updatedAt: now(),
          emailVerified: 1, // Google verified this email
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
    async function updateProfile(user, { displayName, handle, bio, pfp, country, password } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'Account not found.');
      if (password !== undefined) {
        const pw = String(password || '');
        if (pw.length < 6) return fail('invalid', 'Password must be at least 6 characters.');
        u.passHash = await hashPassword(pw);
        u.needsPasswordSetup = 0;
      }
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
    /* Seller payment details keyed by accepted method — the buyer sees these
       at checkout for manual methods (QR image, account name/number, notes). */
    function cleanSellerPaymentDetails(pms, details) {
      const out = {};
      const src = details && typeof details === 'object' ? details : {};
      (Array.isArray(pms) ? pms : []).forEach(m => {
        const d = src[m]; if (!d || typeof d !== 'object') return;
        const entry = {};
        if (d.qrUrl !== undefined) entry.qrUrl = String(d.qrUrl || '').trim().slice(0, 300) || null;
        if (d.accountName !== undefined) entry.accountName = String(d.accountName || '').trim().slice(0, 80) || null;
        if (d.accountNumber !== undefined) entry.accountNumber = String(d.accountNumber || '').trim().slice(0, 80) || null;
        if (d.instructions !== undefined) entry.instructions = String(d.instructions || '').trim().slice(0, 600) || null;
        if (Object.values(entry).some(v => v)) out[m] = entry;
      });
      return out;
    }
    async function createAsset(user, { title, category, description, price, fileName, fileData, fileUrl, backupUrl, imageUrl, images, paymentMethods, sellerPaymentDetails, deliverDuringPending, freeLicensed } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to post assets.');
      if (!canPost(u)) {
        if (u.role === 'member') return fail('vipOnly', 'Only Licensed sellers can post assets. Members can comment and purchase.');
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
      if (!CATEGORIES.includes(category)) return fail('invalid', 'Choose a valid category: Animation, Model, Plugin, System, or Tool.');
      if (description.length < 10) return fail('invalid', 'A full description is required (at least 10 characters).');
      if (!Number.isFinite(price) || price < 0 || price > 999999) return fail('invalid', 'Price must be 0 (free) or a positive number of USD.');
      const img = normalizeImageUrl(imageUrl);
      if (img === null && String(imageUrl || '').trim()) return fail('invalid', 'Image link must be a valid http(s) URL.');
      const file = normalizeFile(fileData, fileName);
      /* The deliverable is mandatory. It can arrive as raw bytes (stored
         locally) or as a fileUrl hosted on the image/file host (Catbox) —
         in which case the database keeps only the URL. */
      const hostedFileUrl = normalizeImageUrl(fileUrl);
      if (!file && !fileName && !hostedFileUrl) return fail('invalid', 'A system file is required — attach the actual file buyers will receive (.lua, .rbxm, .rbxl, .zip…).');
      if (!img) return fail('invalid', 'An image link is required — staff compare the post picture with the file when verifying.');
      /* Required mirror link (MediaFire / Mega / GoFile…) — buyers fall back to
         it automatically if the primary host refuses the download. */
      const backup = normalizeImageUrl(backupUrl);
      if (!backup) return fail('invalid', 'A backup download link is required — upload the same file to MediaFire, Mega, GoFile, or Drive and paste the link.');
      const founderLevel = effRank(u) >= roleRank('cofounder'); // Founder / Co-Founder posts skip the approval queue
      const cleanImages = Array.isArray(images) ? images.map(x => normalizeImageUrl(x)).filter(Boolean).slice(0, 12) : [];
      const allowedPm = ['stripe', 'paypal', 'gcash', 'kofi'];
      const sellerPm = Array.isArray(paymentMethods) ? paymentMethods.filter(m => allowedPm.includes(m)).slice(0, 4) : [];
      /* Accepted payment methods are REQUIRED on paid posts — buyers can only
         pay with methods the seller actually checked. Free posts (price 0)
         skip payment entirely, so no methods are needed. */
      if (Number(price) > 0 && !sellerPm.length) return fail('invalid', 'Select at least one accepted payment method (GCash, Ko-fi, PayPal, or Stripe) — buyers can only pay with methods you accept. (Set the price to 0 to post for free instead.)');
      const asset = {
        id: 'a' + uid(), ownerId: u.id, title, category, description, price,
        fileName: file ? file.name : (fileName || (hostedFileUrl ? hostedFileUrl.split('/').pop().split('?')[0] || 'system-file' : 'system-file')), fileMime: file ? file.mime : 'application/octet-stream', fileSize: file ? file.size : 0,
        fileUrl: hostedFileUrl || null,
        backupUrl: backup || null,
        images: JSON.stringify(cleanImages), paymentMethods: JSON.stringify(sellerPm), sellerPaymentDetails: JSON.stringify(cleanSellerPaymentDetails(sellerPm, sellerPaymentDetails)), deliverDuringPending: deliverDuringPending ? 1 : 0, freeLicensed: Number(price) > 0 ? 0 : (freeLicensed ? 1 : 0),
        imageUrl: img, status: founderLevel ? 'approved' : 'pending', rejectReason: null, sales: 0, createdAt: now(), updatedAt: now(), approvedAt: founderLevel ? now() : null,
      };
      if (file) {
        if (file.size > cfg.maxUploadBytes) return fail('invalid', 'File is too large (max 20 MB).');
        try { await files.put(asset.id, file); }
        catch (err) { console.error(err); return fail('storage', 'Could not store the file.'); }
      }
      store.put('assets', asset);
      flush();
      return ok({ id: asset.id, status: asset.status });
    }

    /* Restricted sellers' posts are blanked from the shop until the
       restriction is lifted (admin moderation power). */
    const ownerRestricted = a => { const o = byIdIn('users', a.ownerId); return !!(o && isRestricted(o)); };
    async function listApproved(viewerId) {
      return ok(all('assets').filter(a => a.status === 'approved' && !ownerRestricted(a)).sort((x, y) => hotScore(y) - hotScore(x)).map(a => summarize(a, viewerId)));
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
        /* Mirror link is private — only entitled viewers ever see it. */
        backupUrl: (isOwner || isAdminView || purchase) ? (a.backupUrl || null) : null,
        purchase,
        sellerResponse: sellerResponseStats(a.ownerId),
        canRate: isVerifiedBuyer(viewer, id),
      });
    }

    async function updateAsset(user, id, { title, category, description, price, fileName, fileData, fileUrl, backupUrl, imageUrl, images, paymentMethods, sellerPaymentDetails, deliverDuringPending, freeLicensed } = {}) {
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
        if (!Number.isFinite(price) || price < 0 || price > 999999) return fail('invalid', 'Price must be 0 (free) or a positive number of USD.');
        a.price = price;
      }
      if (imageUrl !== undefined) {
        const img = normalizeImageUrl(imageUrl);
 if (img === null && String(imageUrl || '').trim()) return fail('invalid', 'Image link must be a valid http(s) URL.');
        a.imageUrl = img;
      }
      if (images !== undefined) {
        const list = Array.isArray(images) ? images.map(x => normalizeImageUrl(x)).filter(Boolean).slice(0, 12) : [];
        a.images = JSON.stringify(list);
      }
      if (paymentMethods !== undefined) {
        const allowedPm = ['stripe', 'paypal', 'gcash', 'kofi'];
        a.paymentMethods = JSON.stringify(Array.isArray(paymentMethods) ? paymentMethods.filter(m => allowedPm.includes(m)).slice(0, 4) : []);
      }
      if (sellerPaymentDetails !== undefined) {
        const pms = Array.isArray(paymentMethods) ? paymentMethods.filter(m => ['stripe', 'paypal', 'gcash', 'kofi'].includes(m)).slice(0, 4) : (() => { try { return JSON.parse(a.paymentMethods || '[]'); } catch (e) { return []; } })();
        let prev = {};
        try { prev = JSON.parse(a.sellerPaymentDetails || '{}') || {}; } catch (e) {}
        a.sellerPaymentDetails = JSON.stringify(cleanSellerPaymentDetails(pms, Object.assign({}, prev, sellerPaymentDetails)));
      }
      if (deliverDuringPending !== undefined) a.deliverDuringPending = !!deliverDuringPending ? 1 : 0;
      if (freeLicensed !== undefined) a.freeLicensed = !!freeLicensed ? 1 : 0;
      if (backupUrl !== undefined) {
        const bu = normalizeImageUrl(backupUrl);
        if (!bu) return fail('invalid', 'A backup download link is required — upload the same file to MediaFire, Mega, GoFile, or Drive and paste the link.');
        a.backupUrl = bu;
      }
      const file = normalizeFile(fileData, fileName);
      if (file) {
        if (file.size > cfg.maxUploadBytes) return fail('invalid', 'File is too large (max 20 MB).');
        a.fileName = file.name; a.fileMime = file.mime; a.fileSize = file.size;
        a.fileUrl = null; // raw bytes replace any hosted URL
        try { await files.put(a.id, file); } catch (err) { console.error(err); return fail('storage', 'Could not store the file.'); }
      } else if (fileUrl !== undefined) {
        const hosted = normalizeImageUrl(fileUrl);
        if (hosted) { a.fileUrl = hosted; a.fileName = fileName || a.fileName; }
      }
      const founderLevel = effRank(u) >= roleRank('cofounder');
      a.status = founderLevel ? 'approved' : 'pending'; // Founder / Co-Founder edits stay live; others re-enter the approval queue
      a.rejectReason = null;
      if (founderLevel) a.approvedAt = now();
      a.updatedAt = now();
      store.put('assets', a);
      flush();
      return ok({ id: a.id, status: a.status });
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
      const staff = isStaff(u);
      const founderish = effRank(u) >= roleRank('cofounder');
      /* ONLY Co-Founder / Founder can hard-delete a post. Sellers and Admins
         cannot — a seller who wants their post removed opens a Support ticket. */
      if (!founderish) return fail('forbidden', staff ? 'Admins cannot delete posts — only Disable. Ask a Co-Founder/Founder.' : 'Posts cannot be deleted directly. Open a Support ticket and staff will remove it for you.');
      cascadeDelete(id);
      flush();
      return ok(true);
    }

    /* Staff view of every registered system (Admin panel → Security). */
    async function adminSystems(actor) {
      const r = requireAdmin(actor); if (r) return r;
      return ok(all('systems').sort((a, b) => b.createdAt - a.createdAt).map(s => {
        const o = dbUser(s.userId);
        const ownerTiers = o ? { protectionTier: Number(o.protectionTier) || 0, contractTier: Number(o.contractTier) || 0, restrictedUntil: o.restrictedUntil || null, restrictReason: o.restrictReason || null, banned: !!o.banned } : null;
        return { ...systemPublic(s), owner: o ? { id: o.id, handle: o.handle, displayName: o.displayName, bio: o.bio || '', pfp: o.pfp || null, role: o.role, createdAt: o.createdAt, ...ownerTiers } : null, games: all('system_games').filter(g => g.systemId === s.id).length, devices: all('system_devices').filter(d => d.systemId === s.id).length };
      }));
    }
    /* Plain Admins may only PAUSE a system, never delete it. The pause also
       auto-expires after 24h unless a Co-Founder / Founder upholds it — an
       unanswered pause means "we do not agree, the system keeps running". */
    async function adminSetSystemState(actor, systemId, { status, staffNote } = {}) {
      const r = requireAdmin(actor); if (r) return r;
      const s = byIdIn('systems', systemId);
      if (!s) return fail('notfound', 'System not found.');
      if (status !== undefined) {
        status = String(status || '');
        if (!['active', 'disabled'].includes(status)) return fail('invalid', 'Invalid status.');
        if (status === 'disabled' && effRank(actor) < roleRank('cofounder')) {
          /* Admin pause: schedule auto-resume in 24h (Founder must uphold). */
          s.status = 'disabled';
          s.pausedBy = actor.id;
          s.pauseExpiresAt = now() + 24 * 36e5;
        } else {
          s.status = status;
          s.pausedBy = null; s.pauseExpiresAt = null;
        }
      } else if (effRank(actor) >= roleRank('cofounder')) {
        /* Founder-level edits clear any pending admin pause window. */
        s.pausedBy = null; s.pauseExpiresAt = null;
      }
      s.staffNote = String(staffNote === undefined ? (s.staffNote || '') : staffNote).trim().slice(0, 300) || null;
      s.updatedAt = now();
      store.put('systems', s);
      flush();
      return ok(true);
    }
    /* Boot/interval sweep: admin pauses expire after 24h without Founder
       approval — the system resumes automatically. */
    function processAdminPauseExpiry() {
      const t = now();
      all('systems').filter(s => s.status === 'disabled' && s.pauseExpiresAt && s.pauseExpiresAt <= t).forEach(s => {
        s.status = 'active';
        s.pausedBy = null; s.pauseExpiresAt = null;
        s.updatedAt = t;
        store.put('systems', s);
      });
      flush();
    }
    /* Founder Panel → Registered: full detail on one system, including the
       owner's profile + plans + revenue, plus staff actions (unregister,
       restrict the system with a note the owner sees). */
    async function adminSystemDetail(actor, systemId) {
      const r = requireAdmin(actor); if (r) return r;
      const s = byIdIn('systems', systemId);
      if (!s) return fail('notfound', 'System not found.');
      const o = dbUser(s.userId);
      const ownerAssets = o ? all('assets').filter(x => x.ownerId === o.id) : [];
      const ownerSales = ownerAssets.reduce((sum, x) => sum + (x.sales || 0), 0);
      const ownerRevenue = all('purchases').filter(p => ownerAssets.some(x => x.id === p.assetId)).reduce((sum, p) => sum + (p.price || 0), 0);
      return ok({
        id: s.id, name: s.name, status: s.status, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt,
        owner: o ? { id: o.id, handle: o.handle, displayName: o.displayName, bio: o.bio || '', pfp: o.pfp || null, role: o.role, email: o.email, createdAt: o.createdAt, protectionTier: Number(o.protectionTier) || 0, contractTier: Number(o.contractTier) || 0, banned: !!o.banned, restrictedUntil: o.restrictedUntil || null, restrictReason: o.restrictReason || null } : null,
        stats: { assets: ownerAssets.length, sales: ownerSales, revenue: ownerRevenue },
        games: all('system_games').filter(g => g.systemId === s.id).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
          .map(g => ({ id: g.id, placeId: g.placeId, status: g.status, gameName: g.gameName || null, gameOwner: g.gameOwner || null, lastSeenAt: g.lastSeenAt })),
        devices: all('system_devices').filter(d => d.systemId === s.id).length,
      });
    }
    /* Founder Panel → Registered: profile + plans + revenue + registered
       systems for one subscriber. */
    async function adminSubscriberDetail(actor, userId) {
      const r = requireAdmin(actor); if (r) return r;
      const u = dbUser(userId);
      if (!u) return fail('notfound', 'User not found.');
      const assets = all('assets').filter(x => x.ownerId === u.id);
      const sales = assets.reduce((s, x) => s + (x.sales || 0), 0);
      const revenue = all('purchases').filter(p => assets.some(x => x.id === p.assetId)).reduce((s, p) => s + (p.price || 0), 0);
      const systems = all('systems').filter(s => s.userId === u.id).sort((a, b) => b.createdAt - a.createdAt)
        .map(s => ({ id: s.id, name: s.name, status: s.status, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, staffNote: s.staffNote || null, games: all('system_games').filter(g => g.systemId === s.id).length, devices: all('system_devices').filter(d => d.systemId === s.id).length }));
      return ok({
        profile: { id: u.id, handle: u.handle, displayName: u.displayName, bio: u.bio || '', pfp: u.pfp || null, role: u.role, email: u.email, createdAt: u.createdAt, country: u.country || null, banned: !!u.banned, restrictedUntil: u.restrictedUntil || null, restrictReason: u.restrictReason || null },
        protectionTier: Number(u.protectionTier) || 0, contractTier: Number(u.contractTier) || 0,
        stats: { assets: assets.length, sales, revenue },
        systems,
      });
    }
    /* Staff unregister: removes a system and its games/devices entirely.
       Co-Founder / Founder ONLY — plain Admins can pause + note, then request
       deletion (their pause auto-expires in 24h without Founder approval). */
    async function adminDeleteSystem(actor, systemId) {
      const r = requireAdmin(actor); if (r) return r;
      if (effRank(actor) < roleRank('cofounder')) return fail('forbidden', 'Only the Co-Founder / Founder can delete registered systems. Pause it and add a note instead — the Founder decides deletion.');
      const s = byIdIn('systems', systemId);
      if (!s) return fail('notfound', 'System not found.');
      store.del('systems', s.id);
      all('system_games').filter(g => g.systemId === s.id).forEach(g => store.del('system_games', g.id));
      all('system_devices').filter(d => d.systemId === s.id).forEach(d => store.del('system_devices', d.id));
      flush();
      return ok(true);
    }
    /* Staff file access — admins can fetch a copy of any asset's file. */
    async function adminTakeFile(actor, id) {
      const r = requireAdmin(actor); if (r) return r;
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      return ok({ fileName: a.fileName, mime: a.fileMime, size: a.fileSize, fileUrl: a.fileUrl || null, backupUrl: a.backupUrl || null });
    }
    /* Staff post control: disable = hidden from the shop but restorable.
       Plain Admins moderate (disable/restore); deleting a post needs
       Co-Founder / Founder approval. */
    async function adminSetAssetStatus(actor, id, status) {
      const r = requireAdmin(actor); if (r) return r;
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      status = String(status || '');
      if (!['approved', 'disabled'].includes(status)) return fail('invalid', 'Invalid status.');
      a.status = status;
      a.updatedAt = now();
      store.put('assets', a);
      flush();
      return ok(true);
    }

    async function myAssets(user) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      return ok(all('assets').filter(a => a.ownerId === u.id).sort((x, y) => y.createdAt - x.createdAt).map(summarize));
    }

    /* User restriction (distinct from timeout): blocks buying + posting, and
       the restricted user's posts are blanked from the shop. Settleable from
       the Admin panel; the user may appeal via Support. */
    async function adminSetRestriction(actor, targetId, { restricted, minutes, reason } = {}) {
      const r = requireAdmin(actor); if (r) return r;
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      if (t.id === actor.id) return fail('self', 'You cannot restrict your own account.');
      if (isStaff(t) && effRank(actor) < roleRank('cofounder')) return fail('adminProtected', 'Staff accounts can only be restricted by the Co-Founder / Founder.');
      if (restricted) {
        minutes = Math.max(1, Math.min(43200, Number(minutes) || 1440));
        t.restrictedUntil = now() + minutes * 6e4;
        t.restrictReason = String(reason || '').trim().slice(0, 300) || 'No reason given — you may appeal via Support or wait out the restriction.';
      } else {
        t.restrictedUntil = null;
        t.restrictReason = null;
      }
      t.updatedAt = now();
      store.put('users', t);
      flush();
      return ok(true);
    }
    /* Temporarily lift a user's subscription (tier → 0). Requires Co-Founder
       or Founder approval — an Admin can only request it. */
    async function adminRequestSubRevoke(actor, targetId, reason) {
      const r = requireAdmin(actor); if (r) return r;
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      if (!(Number(t.protectionTier) > 0) && !(Number(t.contractTier) > 0)) return fail('invalid', 'This user has no active subscription.');
      if (all('sub_revokes').find(x => x.targetId === t.id && x.status === 'pending')) return fail('pending', 'A revocation is already awaiting Co-Founder / Founder approval.');
      store.put('sub_revokes', { id: 'sr' + uid(), actorId: actor.id, targetId: t.id, reason: String(reason || '').trim().slice(0, 300) || null, prevProtection: Number(t.protectionTier) || 0, prevContract: Number(t.contractTier) || 0, status: 'pending', createdAt: now(), resolvedBy: null, resolvedAt: null });
      flush();
      return ok(true);
    }
    async function adminResolveSubRevoke(actor, id, decision) {
      const r = requireAdmin(actor); if (r) return r;
      if (effRank(actor) < roleRank('cofounder')) return fail('forbidden', 'Only the Co-Founder or Founder can approve subscription revocations.');
      const req = byIdIn('sub_revokes', id);
      if (!req || req.status !== 'pending') return fail('notfound', 'Request not found.');
      const t = dbUser(req.targetId);
      decision = String(decision || '');
      if (!['approved', 'rejected'].includes(decision)) return fail('invalid', 'Invalid decision.');
      if (decision === 'approved' && t) {
        t.protectionTier = 0;
        t.contractTier = 0;
        t.updatedAt = now();
        store.put('users', t);
      }
      req.status = decision === 'approved' ? 'approved' : 'rejected';
      req.resolvedBy = actor.id;
      req.resolvedAt = now();
      store.put('sub_revokes', req);
      flush();
      return ok(true);
    }
    /* Immediate unsubscribe: set the user's plan tiers to zero. Founder /       Co-Founder only — Admins should use "Revoke subscription" (approval flow). */
    async function adminUnsubscribePlan(actor, targetId, reason) {
      const r = requireAdmin(actor); if (r) return r;
      if (effRank(actor) < roleRank('cofounder')) return fail('forbidden', 'Only the Co-Founder or Founder can unsubscribe a plan directly.');
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      if (!(Number(t.protectionTier) > 0) && !(Number(t.contractTier) > 0)) return fail('invalid', 'This user has no active subscription.');
      t.protectionTier = 0;
      t.contractTier = 0;
      t.updatedAt = now();
      store.put('users', t);
      flush();
      return ok(true);
    }
    async function adminListSubRevokes(actor) {
      const r = requireAdmin(actor); if (r) return r;
      return ok(all('sub_revokes').sort((a, b) => b.createdAt - a.createdAt).map(x => {
        const t = dbUser(x.targetId);
        const a = dbUser(x.actorId);
        return { ...x, targetHandle: t ? t.handle : '(deleted)', actorHandle: a ? a.handle : '(deleted)' };
      }));
    }

    async function download(user, id) {
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      const v = resolveUser(user);
      const isOwner = v && v.id === a.ownerId;
      const isAdminView = v && isStaff(v);
      const isTest = v && isTester(v);
      const hasPurchased = v && all('purchases').some(p => p.assetId === id && p.buyerId === v.id);
      if (!isOwner && !isAdminView && !isTest && !hasPurchased) return fail('forbidden', 'Purchase this asset to download the file.');
      return ok({ fileName: a.fileName, mime: a.fileMime, size: a.fileSize, fileUrl: a.fileUrl || null, backupUrl: a.backupUrl || null });
    }

    /* ============ PURCHASES & LICENSES ============ */
    /* Issue the license. Buying does NOT change the buyer's role —
       the Licensed role is for Subscription/Contract holders only; buyers stay
       Verified (or whatever role they already have). */
    function grantLicense(u, a) {
      const key = 'KP-' + randomToken(4).toUpperCase().match(/.{1,4}/g).join('-');
      store.put('purchases', { id: 'p' + uid(), assetId: a.id, buyerId: u.id, price: a.price, licenseKey: key, gameId: null, gameName: '', createdAt: now() });
      /* Free systems count USERS, not sales — the shop shows "N users" instead
         of "N sold" for zero-price posts. */
      if (Number(a.price) > 0) a.sales = (a.sales || 0) + 1;
      store.put('assets', a);
      flush();
      return { licenseKey: key, vipUpgrade: false };
    }
    /* Only buyers whose purchase was actually granted (owner / staff / tester /
       verified purchase) may rate, review, and comment on an asset. */
    function isVerifiedBuyer(u, assetId) {
      if (!u) return false;
      const a = byIdIn('assets', assetId);
      if (a && a.ownerId === u.id) return true;
      if (isStaff(u) || isTester(u)) return true;
      return all('purchases').some(p => p.assetId === assetId && p.buyerId === u.id);
    }
    /* Seller response rate — automatic. Of the manual-payment proofs sent to
       this seller in the last 30 days, the share they verified within 24h. */
    function sellerResponseStats(sellerId) {
      const cutoff = now() - 30 * 24 * 36e5;
      const rows = all('orders').filter(o => o.sellerId === sellerId && o.proof && (o.proofVerifiedAt || o.updatedAt) > cutoff);
      if (!rows.length) return null;
      const withTime = rows.map(o => { let s = 0; try { s = JSON.parse(o.proof).submittedAt || 0; } catch (e) {} return { submittedAt: s, verifiedAt: o.proofVerifiedAt || 0 }; }).filter(x => x.submittedAt && x.verifiedAt);
      const fast = rows.filter(o => { let s = 0; try { s = JSON.parse(o.proof).submittedAt || 0; } catch (e) {} return o.proofVerifiedAt && (o.proofVerifiedAt - s) <= 24 * 36e5; }).length;
      const pct = Math.round((fast / rows.length) * 100);
      const avg = withTime.length ? Math.round(withTime.reduce((s, x) => s + (x.verifiedAt - x.submittedAt), 0) / withTime.length / 36e5) : null;
      return { pct, label: pct >= 80 ? 'Fast responder' : pct >= 50 ? 'Usually responds' : 'Slow responder', avgHours: avg };
    }
    /* Auto-approve the buyer's game on the seller's registered system when a
       post with "give file during pending" is completed — the buyer's game is
       licensed immediately, matching the early file delivery. */
    function autoApproveGamesForOrder(order) {
      try {
        const a = byIdIn('assets', order.assetId);
        if (!a || !a.deliverDuringPending) return;
        let details = null; try { details = order.gameDetails ? JSON.parse(order.gameDetails) : null; } catch (e) {}
        const placeId = details && details.placeId ? String(details.placeId).trim() : '';
        if (!placeId) return;
        const games = all('system_games').filter(g => String(g.placeId) === placeId);
        const systemIds = new Set(all('systems').filter(s => s.userId === a.ownerId).map(s => s.id));
        games.forEach(g => {
          if (!systemIds.has(g.systemId)) return;
          if (g.status === 'active') return;
          g.status = 'active';
          g.approvedBy = 'auto-early-delivery';
          g.lastSeenAt = now();
          store.put('system_games', g);
        });
        flush();
      } catch (e) { /* best effort */ }
    }
    function processProofDeadlines() {
      const DAY = 24 * 36e5;
      let changed = 0;
      all('orders').filter(o => o.status === 'pending_verification' && o.proof && !o.proofVerifiedAt).forEach(o => {
        let submittedAt = 0; try { submittedAt = JSON.parse(o.proof).submittedAt || 0; } catch (e) {}
        if (!submittedAt || now() - submittedAt <= DAY) return;
        o.status = 'awaiting_proof';
        o.proofTimeouts = (Number(o.proofTimeouts) || 0) + 1;
        o.updatedAt = now();
        store.put('orders', o);
        changed++;
        const buyer = dbUser(o.buyerId);
        const seller = dbUser(o.sellerId);
        if (buyer) {
          try {
            sendEmail({
              to: buyer.email,
              subject: 'Your payment proof was not verified within 24h — Kings Production',
              action: 'proof-timeout',
              body: 'The seller' + (seller ? ' (' + seller.displayName + ')' : '') + ' did not verify your payment proof for order ' + o.id + ' within 24 hours, so the order is back to "payment proof needed".\n\nYou can submit an updated proof, use Chat with seller on the asset page to reach them directly, or open a Support ticket if they keep ignoring you. Your payment reference stays on the order.',
              link: '#/orders',
            });
          } catch (e) { /* best effort */ }
        }
      });
      if (changed) flush();
      return changed;
    }

    /* ---- Per-asset user blocks (seller's ban list) ----
       A blocked user can never (re)purchase or VIP-try THIS asset; their
       existing license is disabled and their games get denied. */
    const isAssetBlocked = (assetId, userId) => !!byIdIn('asset_blocks', assetId + ':' + userId);
    function blockAssetUser(actor, assetId, targetId, reason) {
      const u = resolveUser(actor);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const a = byIdIn('assets', assetId);
      if (!a) return fail('notfound', 'Asset not found.');
      const target = dbUser(targetId);
      if (!target) return fail('notfound', 'User not found.');
      const founderish = effRank(u) >= roleRank('cofounder');
      if (!founderish && a.ownerId !== u.id) return fail('forbidden', 'Only the creator can block users from this post.');
      if (founderish && a.ownerId !== u.id && effRank(target) >= roleRank(u.role)) return fail('forbidden', 'You cannot block an equal or higher-ranked staff account.');
      const id = assetId + ':' + targetId;
      if (isAssetBlocked(assetId, targetId)) return fail('owned', 'That user is already blocked from this post.');
      store.put('asset_blocks', { id, assetId, userId: targetId, reason: String(reason || '').trim().slice(0, 300) || null, blockedBy: u.id, createdAt: now() });
      /* Kill existing access: disable their license (system stops working on
         the next heartbeat) and remove pending/active try orders. */
      all('purchases').filter(p => p.assetId === assetId && p.buyerId === targetId).forEach(p => { p.status = 'disabled'; store.put('purchases', p); });
      all('orders').filter(o => o.buyerId === targetId && o.assetId === assetId && (o.status === 'created' || o.status === 'paid')).forEach(o => { o.status = 'rejected'; o.approval = 'rejected'; o.approvalNote = 'Blocked by the seller.'; o.updatedAt = now(); store.put('orders', o); });
      const t = dbUser(targetId);
      if (t) sendEmail({ to: t.email, subject: 'You were blocked from a system — Kings Production', action: 'asset_block', body: 'The seller of "' + a.title + '" has blocked your account from that system. Your license for it (if any) has been disabled and the system will stop working in your game.' + (reason ? ' Reason: ' + String(reason).trim().slice(0, 300) : '') + '\n\nIf you believe this was a mistake, open a Support ticket.', link: '#/orders' });
      flush();
      return ok(true);
    }
    function unblockAssetUser(actor, assetId, targetId) {
      const u = resolveUser(actor);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const a = byIdIn('assets', assetId);
      if (!a) return fail('notfound', 'Asset not found.');
      if (a.ownerId !== u.id && effRank(u) < roleRank('cofounder')) return fail('forbidden', 'Only the creator can unblock users from this post.');
      const id = assetId + ':' + targetId;
      if (!isAssetBlocked(assetId, targetId)) return fail('notfound', 'That user is not blocked from this post.');
      store.del('asset_blocks', id);
      flush();
      return ok(true);
    }
    function assetBlocksList(actor, assetId) {
      const u = resolveUser(actor);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const a = byIdIn('assets', assetId);
      if (!a) return fail('notfound', 'Asset not found.');
      if (a.ownerId !== u.id && effRank(u) < roleRank('cofounder')) return fail('forbidden', 'Only the creator can view this list.');
      return ok(all('asset_blocks').filter(b => b.assetId === assetId).sort((x, y) => y.createdAt - x.createdAt).map(b => ({ ...b, user: (() => { const t = dbUser(b.userId); return t ? { id: t.id, handle: t.handle, displayName: t.displayName } : null; })() })));
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
      if (isAssetBlocked(id, u.id)) return fail('forbidden', 'The seller has blocked your account from this system.');
      if (all('purchases').some(p => p.assetId === id && p.buyerId === u.id)) return fail('owned', 'You already own this asset.');
      if (isTester(u)) { const r = grantLicense(u, a); return ok(Object.assign(r, { test: true })); }
      const r = grantLicense(u, a);
      return ok(r);
    }

    /* ---- payment orders (Stripe · PayPal · GCash) ---- */
    const PAY_METHODS = ['stripe', 'paypal', 'gcash', 'stripe_manual', 'paypal_manual', 'gcash_manual', 'kofi_manual'];
    const MANUAL_METHODS = ['stripe_manual', 'paypal_manual', 'gcash_manual', 'kofi_manual'];
    const methodLabel = m => ({ stripe: 'Stripe (automatic)', paypal: 'PayPal (automatic)', gcash: 'GCash (automatic)', stripe_manual: 'Stripe (manual)', paypal_manual: 'PayPal (manual)', gcash_manual: 'GCash (manual)', kofi_manual: 'Ko-fi (manual)' })[m] || m;
    /* Manual-payment proof storage + staff verification queue. */
    async function submitPaymentProof(user, orderId, payload = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const order = byIdIn('orders', orderId);
      if (!order || order.buyerId !== u.id) return fail('forbidden', 'Order not found.');
      if (!MANUAL_METHODS.includes(order.method)) return fail('invalid', 'This order is not a manual payment.');
      if (order.status === 'completed') return fail('invalid', 'This order is already completed.');
      const reference = String(payload.reference || '').trim().slice(0, 80);
      if (!reference) return fail('invalid', 'A payment reference number is required.');
      order.proof = JSON.stringify({
        reference,
        proofUrl: String(payload.proofUrl || '').trim().slice(0, 300) || null,
        note: String(payload.note || '').trim().slice(0, 400) || null,
        submittedAt: now(),
      });
      order.status = 'pending_verification';
      order.proofVerifiedAt = null;
      order.updatedAt = now();
      store.put('orders', order);
      flush();
      return ok(true);
    }
    /* The seller verifies a manual-payment proof (reference etc.) — the seller
       is the first line of defense; staff can still review from the panel. */
    async function sellerReviewProof(user, orderId, decision, note) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const order = byIdIn('orders', orderId);
      if (!order || order.sellerId !== u.id) return fail('forbidden', 'Order not found.');
      if (!MANUAL_METHODS.includes(order.method)) return fail('invalid', 'This order is not a manual payment.');
      if (order.status !== 'pending_verification') return fail('invalid', 'This order has no payment proof to review.');
      decision = String(decision || '');
      if (!['approve', 'reject'].includes(decision)) return fail('invalid', 'Invalid decision.');
      if (decision === 'approve') return finalizeOrder(order, dbUser(order.buyerId));
      order.status = 'awaiting_proof';
      order.proofAttempts = (Number(order.proofAttempts) || 0) + 1;
      order.proofRejectedNote = String(note || '').trim().slice(0, 300) || null;
      order.updatedAt = now();
      store.put('orders', order);
      flush();
      return ok(true);
    }
    async function adminReviewManualOrder(actor, orderId, decision, note) {
      const r = requireAdmin(actor); if (r) return r;
      const order = byIdIn('orders', orderId);
      if (!order) return fail('notfound', 'Order not found.');
      if (order.status !== 'pending_verification') return fail('invalid', 'This order has no payment proof to review.');
      decision = String(decision || '');
      if (!['approve', 'reject'].includes(decision)) return fail('invalid', 'Invalid decision.');
      if (decision === 'approve') return finalizeOrder(order, dbUser(order.buyerId));
      order.status = 'awaiting_proof';
      order.proofAttempts = (Number(order.proofAttempts) || 0) + 1;
      order.proofRejectedNote = String(note || '').trim().slice(0, 300) || null;
      order.updatedAt = now();
      store.put('orders', order);
      flush();
      return ok(true);
    }
    /* Payment configuration (QR codes, account details, per-method instructions),
       edited by Co-Founder/Founder from the panel. */
    async function getPaymentConfig() {
      const row = byIdIn('site_settings', 'payment_config');
      const empty = { gcashQrUrl: '', gcashDetails: '', gcashInstructions: '', kofiUrl: '', kofiInstructions: '', paypalAccount: '', paypalInstructions: '', stripeInstructions: '' };
      if (!row) return ok(empty);
      try { return ok({ ...empty, ...JSON.parse(row.value) }); } catch (e) { return ok(empty); }
    }
    async function adminSetPaymentConfig(actor, cfg = {}) {
      const r = requireCofounder(actor, 'edit payment settings'); if (r) return r;
      const cur = (await getPaymentConfig()).data || {};
      const keys = ['gcashQrUrl', 'gcashDetails', 'gcashInstructions', 'kofiUrl', 'kofiInstructions', 'paypalAccount', 'paypalInstructions', 'stripeInstructions'];
      const clean = {};
      keys.forEach(k => {
        clean[k] = cfg[k] !== undefined ? String(cfg[k] || '').trim().slice(0, 4000) : (cur[k] || '');
      });
      const img = normalizeImageUrl(clean.gcashQrUrl);
      clean.gcashQrUrl = img || '';
      store.put('site_settings', { id: 'payment_config', value: JSON.stringify(clean), updatedAt: now() });
      flush();
      return ok(clean);
    }
    /* ---- image hosting (optional) ----
       Default provider is Catbox.moe — a free permanent image host with an
       anonymous API, so it works with NO key and NO account. Imgur and ImgBB
       remain selectable for those who prefer them. The site stores image URLs
       only; picking a local file uploads through the server proxy. */
    function getImgurSettings() {
      const row = byIdIn('site_settings', 'imgur_settings');
      const empty = { provider: 'catbox', clientId: '' };
      if (!row) return ok(empty);
      try { return ok({ ...empty, ...JSON.parse(row.value) }); } catch (e) { return ok(empty); } 
    }
    async function adminSetImgurSettings(actor, cfg = {}) {
      const r = requireCofounder(actor, 'edit image upload settings'); if (r) return r;
      const cur = (await getImgurSettings()).data || {};
      const prov = ['catbox', 'imgur', 'imgbb'].includes(cfg.provider) ? cfg.provider : (cur.provider || 'catbox');
      const clean = {
        provider: prov,
        clientId: String(cfg.clientId !== undefined ? cfg.clientId : cur.clientId || '').trim().slice(0, 80),
        userhash: String(cfg.userhash !== undefined ? cfg.userhash : cur.userhash || '').trim().slice(0, 80),
      };
      if (prov === 'catbox') clean.clientId = '';
      if (prov === 'imgbb' && !clean.clientId) return fail('invalid', 'ImgBB needs an API key — get one free at api.imgbb.com.');
      if (prov === 'imgur' && !clean.clientId && !cur.clientId) return fail('invalid', 'Imgur needs a Client-ID (api.imgur.com). Or just use Catbox — it needs nothing.');
      store.put('site_settings', { id: 'imgur_settings', value: JSON.stringify(clean), updatedAt: now() });
      flush();
      return ok({ provider: clean.provider, clientId: clean.clientId ? 'configured' : '', userhash: clean.userhash ? 'configured' : '' });
    }
    /* The Licensed plan is sold directly for 500 PHP (base) — converting
       to the buyer's local currency the same way asset prices convert. */
    const VIP_PLAN_PRICE_PHP = 500;
    const convertFromPhp = (php, country) => Math.max(1, Math.round((Number(php) || 0) / fxRate('PHP') * fxRate(currencyOf(country))));
    const isVipOrder = o => !!(o && o.assetId === 'vip');
    async function createVipOrder(user, method) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      method = String(method || '').toLowerCase();
      if (!PAY_METHODS.includes(method)) return fail('invalid', 'Choose a payment method: Stripe, PayPal, GCash, or Ko-fi.');
      if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot make purchases.');
      if (isBanned(u)) return fail('banned', 'Your account is banned.');
      if (effRank(u) >= roleRank('licensed')) return fail('owned', 'Your account is already Licensed — no need to buy it again.');
      if (all('orders').some(o => o.buyerId === u.id && isVipOrder(o) && (o.status === 'created' || o.status === 'paid')))
        return fail('pending', 'You already have a pending Licensed order.');
      const currency = currencyOf(u.country);
      const amount = convertFromPhp(VIP_PLAN_PRICE_PHP, u.country);
      const order = { id: 'o' + uid(), buyerId: u.id, assetId: 'vip', method, amount, currency, status: MANUAL_METHODS.includes(method) ? 'awaiting_proof' : 'created', providerRef: null, licenseKey: null, createdAt: now(), paidAt: null, updatedAt: now() };
      store.put('orders', order);
      flush();
      return ok({ orderId: order.id, amount: order.amount, currency: order.currency });
    }
    /* Subscription/Contract plans — one-time purchases that set a tier on the
       buyer. assetId encodes the plan: 'sub:<protection|contract>:<1-3>'. */
    const SUB_PLANS = {
      protection: [{ php: 300 }, { php: 500 }, { php: 1000 }],
      contract: [{ php: 500 }, { php: 700 }, { php: 1200 }],
    };
    const isSubOrder = o => !!(o && String(o.assetId || '').startsWith('sub:'));
    async function createSubscriptionOrder(user, category, tier, method) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      method = String(method || '').toLowerCase();
      if (!PAY_METHODS.includes(method)) return fail('invalid', 'Choose a payment method: Stripe, PayPal, GCash, or Ko-fi.');
      if (!SUB_PLANS[category]) return fail('invalid', 'Unknown plan category.');
      tier = Number(tier);
      if (![1, 2, 3].includes(tier)) return fail('invalid', 'Choose a valid plan tier.');
      if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot make purchases.');
      if (isBanned(u)) return fail('banned', 'Your account is banned.');
      const cur = category === 'protection' ? (Number(u.protectionTier) || 0) : (Number(u.contractTier) || 0);
      if (cur >= tier) return fail('owned', 'You already have this plan or a higher one.');
      if (all('orders').some(o => o.buyerId === u.id && o.assetId === 'sub:' + category + ':' + tier && (o.status === 'created' || o.status === 'paid')))
        return fail('pending', 'You already have a pending order for this plan.');
      const currency = currencyOf(u.country);
      const amount = convertFromPhp(SUB_PLANS[category][tier - 1].php, u.country);
      const order = { id: 'o' + uid(), buyerId: u.id, assetId: 'sub:' + category + ':' + tier, method, amount, currency, status: MANUAL_METHODS.includes(method) ? 'awaiting_proof' : 'created', providerRef: null, licenseKey: null, createdAt: now(), paidAt: null, updatedAt: now() };
      store.put('orders', order);
      flush();
      return ok({ orderId: order.id, amount: order.amount, currency: order.currency });
    }
    /* ===== VIP — complimentary tier granted by the Founder ===== */
    async function setVipRole(actor, targetId, on) {
      const r = requireCofounder(actor, 'grant or remove VIP'); if (r) return r;
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      if (isOwnerAccount(t) || effRank(t) >= roleRank('admin')) return fail('forbidden', 'Staff accounts cannot be given the VIP tier.');
      if (t.id === actor.id) return fail('self', 'You cannot change your own VIP status.');
      on = !!on;
      if (on) {
        if (isVipUser(t)) return fail('owned', 'That user is already VIP.');
        if (effRank(t) < roleRank('licensed')) {
          /* Verified (or test) — VIP replaces the role. */
          t.role = 'vip';
        } else {
          /* Licensed and above — VIP stacks as a tag, role stays intact. */
          const tg = parseTags(t);
          if (!tg.some(x => String(x).trim().toLowerCase() === 'vip')) { tg.push('vip'); t.tags = JSON.stringify(tg); }
        }
      } else {
        if (t.role === 'vip') t.role = 'member';
        const tg = parseTags(t).filter(x => String(x).trim().toLowerCase() !== 'vip');
        t.tags = JSON.stringify(tg);
      }
      t.vipGrantedBy = actor.id;
      t.vipGrantedAt = now();
      t.updatedAt = now();
      store.put('users', t);
      flush();
      return ok(true);
    }
    /* VIP "Try" order — zero-cost checkout of a studio-owned system. The buyer
       still fills in game details and waits for the seller's approval + license
       activation, exactly like a paid purchase. Studio systems only: the
       seller must be staff. Everyone else's posts must be bought normally. */
    async function createVipTrialOrder(user, assetId, method, gameDetails) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      if (!isVipUser(u)) return fail('forbidden', 'Try is a VIP perk — it unlocks the studio\'s own systems.');
      if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot make purchases.');
      if (isBanned(u)) return fail('banned', 'Your account is banned.');
      const a = byIdIn('assets', assetId);
      if (isRestricted(u)) return fail('restricted', 'Your account is restricted — you cannot make purchases right now.');
      if (!a) return fail('notfound', 'Asset not found.');
      if (a.status !== 'approved') return fail('notfound', 'This asset is not available for purchase.');
      const owner = dbUser(a.ownerId);
      if (!isStaff(owner)) return fail('forbidden', 'Try only works on systems posted by Kings Production.');
      if (isAssetBlocked(a.id, u.id)) return fail('forbidden', 'The seller has blocked your account from this system.');
      if (all('purchases').some(p => p.assetId === a.id && p.buyerId === u.id)) return fail('owned', 'You already own this asset.');
      /* An existing pending request is FOLLOWED UP, not blocked: the new
         details replace the old ones and the request moves back to the top
         of the queue. Rejected requests are freed automatically. */
      const pendingTry = all('orders').find(o => o.buyerId === u.id && o.assetId === a.id && (o.status === 'created' || o.status === 'paid'));
      if (pendingTry) {
        const gd0 = gameDetails && typeof gameDetails === 'object' ? gameDetails : {};
        pendingTry.gameDetails = JSON.stringify({
          gameName: String(gd0.gameName || '').trim().slice(0, 80) || null,
          placeId: String(gd0.placeId || '').trim().slice(0, 20) || null,
          gameOwner: String(gd0.gameOwner || '').trim().slice(0, 80) || null,
          notes: (String(gd0.notes || '').trim() + ' [VIP try]').slice(0, 400) || null,
        });
        pendingTry.followedUpAt = now();
        pendingTry.updatedAt = now();
        store.put('orders', pendingTry);
        flush();
        return ok({ orderId: pendingTry.id, amount: 0, currency: pendingTry.currency, vipTrial: true, followUp: true });
      }
      const gd = gameDetails && typeof gameDetails === 'object' ? gameDetails : {};
      const details = {
        gameName: String(gd.gameName || '').trim().slice(0, 80) || null,
        placeId: String(gd.placeId || '').trim().slice(0, 20) || null,
        gameOwner: String(gd.gameOwner || '').trim().slice(0, 80) || null,
        notes: (String(gd.notes || '').trim() + ' [VIP try]').slice(0, 400) || null,
      };
      const currency = currencyOf(u.country);
      const order = { id: 'o' + uid(), buyerId: u.id, assetId: a.id, method: 'vip_try', amount: 0, currency, status: 'paid', providerRef: 'vip-try', licenseKey: null, gameDetails: JSON.stringify(details), sellerId: a.ownerId, approval: 'pending', vipTrial: 1, createdAt: now(), paidAt: now(), updatedAt: now() };
      store.put('orders', order);
      flush();
      return ok({ orderId: order.id, amount: 0, currency, vipTrial: true });
    }
    /* Buy an asset. The buyer also supplies GAME DETAILS (game name, place ID
       and owner) for the seller to verify before activation. Staff get a
       parallel "seller copy" order so the seller's My Orders stays clean. */
    async function createOrder(user, assetId, method, gameDetails) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      /* Free claims arrive with method 'free' — skip the payment-method gate. */
      const isFreeClaim = String(method || '').toLowerCase() === 'free';
      method = String(method || '').toLowerCase();
      if (!isFreeClaim && !PAY_METHODS.includes(method)) return fail('invalid', 'Choose a payment method: Stripe, PayPal, GCash, or Ko-fi.');
      const a = byIdIn('assets', assetId);
      if (isRestricted(u)) return fail('restricted', 'Your account is restricted — you cannot make purchases right now. You may appeal or wait out the restriction.');
      if (!a) return fail('notfound', 'Asset not found.');
      if (isTimedOut(u)) return fail('timeout', 'You are currently timed out and cannot make purchases.');
      if (isBanned(u)) return fail('banned', 'Your account is banned.');
      if (a.status !== 'approved') return fail('notfound', 'This asset is not available for purchase.');
      if (a.ownerId === u.id) return fail('self', 'You cannot purchase your own asset.');
      if (isAssetBlocked(a.id, u.id)) return fail('forbidden', 'The seller has blocked your account from this system.');
      if (all('purchases').some(p => p.assetId === a.id && p.buyerId === u.id)) return fail('owned', 'You already own this asset.');
      if (all('orders').some(o => o.buyerId === u.id && o.assetId === a.id && (o.status === 'created' || o.status === 'paid')))
        return fail('pending', 'You already have a pending order for this asset.');
      /* FREE posts (price 0): no payment, no method picker. Two flavors:
         - freeLicensed (checked): the free system still carries a license —
           the claimer fills in game details; the order waits for the seller's
           approval exactly like a paid order (Approve details → completes +
           license).
         - open source (unchecked): no license, no questions — the claim
           completes instantly and the file is downloadable right away. */
      if (!(Number(a.price) > 0)) {
        const needsDetails = !!a.freeLicensed;
        let freeDetails = null;
        if (needsDetails) {
          const gd0 = gameDetails && typeof gameDetails === 'object' ? gameDetails : {};
          freeDetails = { gameName: String(gd0.gameName || '').trim().slice(0, 80) || null, placeId: String(gd0.placeId || '').trim().slice(0, 20) || null, gameOwner: String(gd0.gameOwner || '').trim().slice(0, 80) || null, notes: String(gd0.notes || '').trim().slice(0, 400) || null };
          if (!freeDetails.gameName || !freeDetails.placeId || !freeDetails.gameOwner) return fail('invalid', 'This free system is licensed — game name, place ID, and game creator are required to claim it.');
        }
        const order0 = { id: 'o' + uid(), buyerId: u.id, assetId: a.id, method: 'free', amount: 0, currency: currencyOf(u.country), status: needsDetails ? 'paid' : 'created', providerRef: needsDetails ? 'free-claim' : null, licenseKey: null, gameDetails: JSON.stringify(freeDetails), sellerId: a.ownerId, approval: 'pending', createdAt: now(), paidAt: needsDetails ? now() : null, updatedAt: now() };
        store.put('orders', order0);
        flush();
        return needsDetails ? ok({ orderId: order0.id, amount: 0, currency: order0.currency, freeLicensed: true }) : finalizeOrder(order0, u);
      }
      const currency = currencyOf(u.country);
      const amount = convertPrice(a.price, u.country);
      const gd = gameDetails && typeof gameDetails === 'object' ? gameDetails : {};
      const details = {
        gameName: String(gd.gameName || '').trim().slice(0, 80) || null,
        placeId: String(gd.placeId || '').trim().slice(0, 20) || null,
        gameOwner: String(gd.gameOwner || '').trim().slice(0, 80) || null,
        notes: String(gd.notes || '').trim().slice(0, 400) || null,
      };
      const order = { id: 'o' + uid(), buyerId: u.id, assetId: a.id, method, amount, currency, status: MANUAL_METHODS.includes(method) ? 'awaiting_proof' : 'created', providerRef: null, licenseKey: null, gameDetails: JSON.stringify(details), sellerId: a.ownerId, approval: 'pending', createdAt: now(), paidAt: null, updatedAt: now() };
      store.put('orders', order);
      flush();
      return ok({ orderId: order.id, amount: order.amount, currency: order.currency });
    }
    /* The seller's view of orders for their own assets (pending → completed). */
    async function sellerOrders(user) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const rows = all('orders')
        .filter(o => o.sellerId === u.id && !String(o.assetId || '').startsWith('sub:') && o.assetId !== 'vip')
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(o => {
          const a = byIdIn('assets', o.assetId);
          const b = dbUser(o.buyerId);
          let details = null;
          try { details = o.gameDetails ? JSON.parse(o.gameDetails) : null; } catch (e) {}
          let proof = null;
          try { proof = o.proof ? JSON.parse(o.proof) : null; } catch (e) {}
          return { id: o.id, assetId: o.assetId, assetTitle: a ? a.title : '(deleted asset)', amount: o.amount, currency: o.currency, method: o.method, manual: MANUAL_METHODS.includes(o.method), proof, status: o.status, approval: o.approval || (o.status === 'completed' ? 'approved' : 'pending'), buyer: b ? { id: b.id, handle: b.handle, displayName: b.displayName } : null, gameDetails: details, createdAt: o.createdAt, completedAt: o.updatedAt };
        });
      return ok(rows);
    }
    /* Seller approval of an order's game details — required before completion. */
    async function setOrderApproval(user, orderId, decision, note) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const order = byIdIn('orders', orderId);
      if (!order || order.sellerId !== u.id) return fail('forbidden', 'Order not found.');
      decision = String(decision || '');
      if (!['approved', 'rejected'].includes(decision)) return fail('invalid', 'Invalid decision.');
      /* Unapprove: rejecting a COMPLETED order revokes its license — the
         system stops working for that buyer on the next heartbeat. */
      if (order.status === 'completed' && decision === 'rejected') {
        order.approval = 'rejected';
        order.approvalNote = String(note || '').trim().slice(0, 300) || null;
        order.status = 'rejected';
        order.rejectedAt = now();
        order.unapprovedAt = now();
        if (order.licenseKey) {
          const lic = all('purchases').find(p => p.licenseKey === order.licenseKey);
          if (lic) { lic.status = 'disabled'; store.put('purchases', lic); }
        }
        const buyer0 = dbUser(order.buyerId);
        const aTitle0 = (byIdIn('assets', order.assetId) || {}).title || 'your order';
        if (buyer0) sendEmail({ to: buyer0.email, subject: 'Your order approval was revoked — Kings Production', action: 'order_unapproved', body: 'The seller revoked the approval for your order of "' + aTitle0 + '". The license is now disabled and the system will stop working in your game.' + (order.approvalNote ? ' Their note: ' + order.approvalNote : '') + '\n\nIf you believe this was a mistake, open a Support ticket.', link: '#/orders' });
        store.put('orders', order);
        flush();
        return ok(true);
      }
      /* Re-approve a previously rejected order: re-enable the license and
         complete the order again. */
      if (order.status === 'rejected' && decision === 'approved') {
        order.approval = 'approved';
        order.approvalNote = String(note || '').trim().slice(0, 300) || null;
        order.status = 'completed';
        order.updatedAt = now();
        if (order.licenseKey) {
          const lic = all('purchases').find(p => p.licenseKey === order.licenseKey);
          if (lic) { lic.status = 'active'; store.put('purchases', lic); }
        }
        const buyerR = dbUser(order.buyerId);
        const aTitleR = (byIdIn('assets', order.assetId) || {}).title || 'your order';
        if (buyerR) sendEmail({ to: buyerR.email, subject: 'Your order was re-approved — Kings Production', action: 'order_reapproved', body: 'The seller re-approved your order of "' + aTitleR + '". The license is active again and the system works in your game.', link: '#/orders' });
        store.put('orders', order);
        flush();
        return ok(true);
      }
      if (order.status === 'completed') return fail('invalid', 'This order is already completed.');
      order.approval = decision;
      order.approvalNote = String(note || '').trim().slice(0, 300) || null;
      order.updatedAt = now();
      /* FREE licensed claims complete on approval: the seller accepts the
         claimer's game details and the license is issued right here — no
         payment ever happened, so there is nothing else to verify. */
      if (decision === 'approved' && order.method === 'free' && order.status === 'paid') {
        const buyerF = dbUser(order.buyerId);
        const outF = finalizeOrder(order, buyerF);
        return outF;
      }
      /* A rejected order leaves pending for good: it moves to the buyer's
         Rejected list (they can delete it there) and the buyer is emailed. */
      if (decision === 'rejected') {
        order.status = 'rejected';
        order.rejectedAt = now();
        const buyer = dbUser(order.buyerId);
        const aTitle = (byIdIn('assets', order.assetId) || {}).title || 'your order';
        if (buyer) sendEmail({ to: buyer.email, subject: 'Your order was rejected — Kings Production', action: 'order_rejected', body: 'The seller rejected the game details for your order of "' + aTitle + '".' + (order.approvalNote ? ' Their note: ' + order.approvalNote : '') + '\n\nYou can view or delete the rejected order on your Orders page. If you believe this was a mistake, open a Support ticket.', link: '#/orders' });
      }
      store.put('orders', order);
      flush();
      return ok(true);
    }
    /* Buyer-side cleanup: a rejected order can be deleted from their list. */
    async function deleteOrder(user, orderId) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const order = byIdIn('orders', orderId);
      if (!order || order.buyerId !== u.id) return fail('forbidden', 'Order not found.');
      if (order.status !== 'rejected') return fail('invalid', 'Only rejected orders can be deleted.');
      store.del('orders', order.id);
      flush();
      return ok(true);
    }
    /* Seller-side cleanup: the seller can delete ANY of their orders (pending,
       completed, rejected). Deleting a completed order also disables its
       license so the buyer keeps no working copy. */
    async function sellerDeleteOrder(user, orderId) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const order = byIdIn('orders', orderId);
      if (!order || (order.sellerId !== u.id && effRank(u) < roleRank('cofounder'))) return fail('forbidden', 'Order not found.');
      if (order.status === 'completed' && order.licenseKey) {
        const lic = all('purchases').find(p => p.licenseKey === order.licenseKey);
        if (lic) { lic.status = 'disabled'; store.put('purchases', lic); }
      }
      store.del('orders', order.id);
      flush();
      return ok(true);
    }
    function finalizeOrder(order, buyer) {
      if (order.status === 'completed') return ok({ licenseKey: order.licenseKey, vipUpgrade: false });
      if (order.status !== 'paid') { order.status = 'paid'; order.paidAt = now(); }
      if (order.proof && !order.proofVerifiedAt) order.proofVerifiedAt = now();
      order.updatedAt = now();
      let out;
      if (isVipOrder(order)) {
        let vipUpgrade = false;
        if (effRank(buyer) < roleRank('licensed')) {
          /* Upgrade to Licensed, but PRESERVE complimentary VIP: it moves to a
             tag so the user holds both roles — VIP powers (Try, dashboard)
             stack with Licensed posting. */
          const wasVip = isVipUser(buyer);
          buyer.role = 'licensed';
          if (wasVip) {
            const tg = parseTags(buyer);
            if (!tg.some(x => String(x).trim().toLowerCase() === 'vip')) { tg.push('vip'); buyer.tags = JSON.stringify(tg); }
          }
          buyer.updatedAt = now(); store.put('users', buyer); vipUpgrade = true;
        }
        out = { licenseKey: null, vipUpgrade };
      } else if (isSubOrder(order)) {
        /* Plan purchase — raise the buyer's tier (never lower it) + VIP role. */
        const [, cat, tierS] = String(order.assetId).split(':');
        const tier = Number(tierS);
        let vipUpgrade = false;
        if (effRank(buyer) < roleRank('licensed')) { buyer.role = 'licensed'; buyer.updatedAt = now(); store.put('users', buyer); vipUpgrade = true; }
        const cur = cat === 'protection' ? (Number(buyer.protectionTier) || 0) : (Number(buyer.contractTier) || 0);
        if (tier > cur) {
          if (cat === 'protection') buyer.protectionTier = tier; else buyer.contractTier = tier;
          buyer.updatedAt = now();
          store.put('users', buyer);
        }
        out = { licenseKey: null, vipUpgrade, subscription: { category: cat, tier: Math.max(tier, cur) } };
      } else {
        const a = byIdIn('assets', order.assetId);
        if (!a) return fail('notfound', 'The asset for this order no longer exists.');
        /* The seller can hand the file over early, while the order is still
           waiting on their license activation — optional, set at posting. */
        if (a.deliverDuringPending && a.ownerId !== buyer.id) {
          try {
            const cfgRow = byIdIn('site_settings', 'payment_config');
            const cfg = cfgRow ? JSON.parse(cfgRow.value) : {};
            sendEmail({
              to: buyer.email,
              subject: 'Your system file — ' + a.title + ' (Kings Production)',
              action: 'receipt',
              body: 'The seller of "' + a.title + '" has released the system file while your license activation is still pending.\n\nDownload it from the asset page: ' + (cfg.siteUrl || '') + '#/asset/' + a.id + '\n\nYou can download it there any time. Your license will be activated by the seller after they verify your game details.',
              link: '#/asset/' + a.id,
            });
          } catch (e) { console.error('early-delivery email failed', e); }
        }
        const r = grantLicense(buyer, a);
        out = { licenseKey: r.licenseKey, vipUpgrade: r.vipUpgrade };
      }
      order.status = 'completed';
      order.licenseKey = out.licenseKey;
      order.updatedAt = now();
      store.put('orders', order);
      /* "Give file during pending" posts auto-license the buyer's game on the
         seller's registered system the moment the order completes. */
      autoApproveGamesForOrder(order);
      /* Purchase receipt — delivered to the buyer with their license key. */
      try {
        const subM = isSubOrder(order) ? String(order.assetId).split(':').slice(1) : null;
        const assetT = (isVipOrder(order) || subM) ? null : byIdIn('assets', order.assetId);
        sendEmail({
          to: buyer.email,
          subject: isVipOrder(order) ? 'You are now Licensed — Kings Production'
            : subM ? 'Your ' + (subM[0] === 'protection' ? 'Subscription' : 'Contract') + ' ' + subM[1] + ' plan is active — Kings Production'
            : 'Your purchase & license key — ' + (assetT ? assetT.title : 'Kings Production'),
          action: 'receipt',
          body: isVipOrder(order)
            ? 'Your Licensed upgrade is complete! Your account can now post assets to the marketplace. Manage your systems and licenses from the Licensed Dashboard — thank you for supporting Kings Production!'
            : subM
            ? 'Your ' + (subM[0] === 'protection' ? 'Subscription' : 'Contract') + ' ' + subM[1] + ' plan is now active. Head to the Licensed Dashboard to register systems, track revenue, and control the games using your licenses.'
            : 'Thank you for your purchase of "' + (assetT ? assetT.title : 'this asset') + '". Your license key is: ' + out.licenseKey + '\n\nAssign it to a Roblox game from the Subscription page to activate it. Want to sell your own systems? A Contract plan on the Subscription page unlocks posting.',
          link: '#/subscription',
        });
      } catch (e) { console.error('receipt email failed', e); }
      flush();
      return ok({ licenseKey: out.licenseKey, vipUpgrade: out.vipUpgrade, method: order.method });
    }
    async function completeOrder(user, orderId, providerRef) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const order = byIdIn('orders', orderId);
      if (!order || order.buyerId !== u.id) return fail('forbidden', 'Order not found.');
      if (providerRef && !order.providerRef) { order.providerRef = String(providerRef); store.put('orders', order); }
      if (!isVipOrder(order) && !isSubOrder(order)) {
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
      if (!isVipOrder(order) && !isSubOrder(order)) {
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
      return ok(all('orders').filter(o => o.buyerId === u.id).sort((x, y) => y.createdAt - x.createdAt).map(o => {
        let proof = null;
        try { proof = o.proof ? JSON.parse(o.proof) : null; } catch (e) {}
        return { ...o, proof, manual: MANUAL_METHODS.includes(o.method), vip: isVipOrder(o), sub: isSubOrder(o) ? { category: String(o.assetId).split(':')[1], tier: Number(String(o.assetId).split(':')[2]) } : null, asset: (isVipOrder(o) || isSubOrder(o)) ? null : summarize(byIdIn('assets', o.assetId)) };
      }));
    }
    async function adminOrders(actor) {
      const r = requireAdmin(actor); if (r) return r;
      return ok(all('orders').slice().sort((x, y) => y.createdAt - x.createdAt).map(o => ({ ...o, vip: isVipOrder(o), buyer: publicUser(dbUser(o.buyerId)), asset: (isVipOrder(o) || isSubOrder(o)) ? null : summarize(byIdIn('assets', o.assetId)) })));
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
      /* VIPs get the dashboard too — capped at Subscription-1 limits when
         registering systems (enforced in registerSystem). */
      if (!canPost(u) && u.role !== 'vip') return fail('vipOnly', 'The dashboard is for Licensed sellers and VIPs.');
      /* Founder / Co-Founder own the platform — the dashboard is theirs too;
         plain Admins still need a Contract plan to use it. */
      if (isStaff(u) && effRank(u) < roleRank('cofounder')) return fail('vipOnly', 'Staff use the Admin Panel — the Licensed Dashboard needs a Contract plan (granted on the Founder Panel or the Subscription page).');
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
      if (!canPost(u)) return fail('vipOnly', 'Only Licensed sellers can manage licenses.');
      if (isStaff(u) && effRank(u) < roleRank('cofounder') && !(Number(u.contractTier) > 0)) return fail('vipOnly', 'Staff manage licenses only with a Contract plan.');
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
      if (isStaff(u) && effRank(u) < roleRank('cofounder') && !(Number(u.contractTier) > 0)) return fail('vipOnly', 'Staff manage licenses only with a Contract plan.');
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
      if (isStaff(u) && effRank(u) < roleRank('cofounder') && !(Number(u.contractTier) > 0)) return fail('vipOnly', 'Staff manage licenses only with a Contract plan.');
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
      if (!isVerifiedBuyer(u, assetId)) return fail('buyersOnly', 'Only verified buyers can rate and comment here.');
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
      if (!isVerifiedBuyer(u, assetId)) return fail('buyersOnly', 'Only verified buyers can rate and review here.');
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
      const portfolio = all('portfolio').slice().sort((a, b) => ((b.featured ? 1 : 0) - (a.featured ? 1 : 0)) || ((b.createdAt || 0) - (a.createdAt || 0))).map(it => {
        let imgs = [];
        try { imgs = JSON.parse(it.images || '[]'); if (!Array.isArray(imgs)) imgs = []; } catch (e) { imgs = []; }
        return { ...it, images: imgs, links: parseLinks(it) };
      });
      /* Creators are listed in publish order — new ones append after existing. */
      const creators = all('creators').slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(it => ({ ...it, links: parseLinks(it) }));
      return ok({ portfolio, creators });
    }

    /* ============ PORTFOLIO (admin-published showcase) ============ */
    function cleanPortfolioLinks(links) {
      if (!Array.isArray(links)) return [];
      return links.map(l => ({ url: String((l && l.url) || '').trim() })).filter(l => /^https?:\/\//i.test(l.url)).slice(0, 12).map(l => ({ url: l.url.slice(0, 500) }));
    }
    async function createPortfolio(actor, { title, category, desc, stat, status, imageUrl, images, links, featured, creatorId } = {}) {
      const r = requireCofounder(actor, 'create portfolio posts'); if (r) return r;
      title = String(title || '').trim();
      desc = String(desc || '').trim();
      if (title.length < 3 || title.length > 80) return fail('invalid', 'Project title must be 3–80 characters.');
      if (desc.length < 10) return fail('invalid', 'A description is required (at least 10 characters).');
      const img = normalizeImageUrl(imageUrl);
      const imgs = (Array.isArray(images) ? images : [])
        .map(x => normalizeImageUrl(x)).filter(Boolean).slice(0, 12);
      const item = {
        id: 'pp' + uid(), title, category: String(category || '').trim().slice(0, 40),
        desc, stat: String(stat || '').trim().slice(0, 60), status: String(status || 'Live').trim().slice(0, 24),
        imageUrl: img, images: JSON.stringify(imgs), links: JSON.stringify(cleanPortfolioLinks(links)), featured: !!featured, creatorId: String(creatorId || '').trim() || null, createdAt: now(),
      };
      if (item.featured) all('portfolio').filter(x => x.featured && x.id !== item.id).forEach(x => { x.featured = false; store.put('portfolio', x); });
      store.put('portfolio', item);
      flush();
      return ok({ id: item.id });
    }
    async function updatePortfolio(actor, id, patch = {}) {
      const r = requireCofounder(actor, 'edit portfolio posts'); if (r) return r;
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
      if (patch.images !== undefined) {
        const imgs = (Array.isArray(patch.images) ? patch.images : [])
          .map(x => normalizeImageUrl(x)).filter(x => !!x).slice(0, 12);
        it.images = JSON.stringify(imgs);
      }
      if (patch.links !== undefined) it.links = JSON.stringify(cleanPortfolioLinks(patch.links));
      if (patch.creatorId !== undefined) it.creatorId = String(patch.creatorId || '').trim() || null;
      if (patch.featured !== undefined) {
        it.featured = !!patch.featured;
        if (it.featured) all('portfolio').filter(x => x.featured && x.id !== it.id).forEach(x => { x.featured = false; store.put('portfolio', x); });
      }
      store.put('portfolio', it);
      flush();
      return ok(true);
    }
    /* Portfolio & creators are the studio's showcase — only the Founder (or
       the studio Owner account) may delete entries; other staff can edit. */
    async function deletePortfolio(actor, id) {
      const r = requireAdmin(actor); if (r) return r;
      if (effRank(actor) < roleRank('cofounder')) return fail('forbidden', 'Only the Co-Founder or Founder can delete portfolio posts.');
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
      if (effRank(actor) < roleRank('cofounder')) return fail('forbidden', 'Admins moderate posts (disable/restore) — deletion needs Co-Founder / Founder approval.');
      const a = byIdIn('assets', id);
      if (!a) return fail('notfound', 'Asset not found.');
      cascadeDelete(id);
      flush();
      return ok(true);
    }
    async function adminUsers(actor) {
      const r = requireAdmin(actor); if (r) return r;
      return ok(all('users').slice().sort((a, b) => a.createdAt - b.createdAt).map(u => ({
        ...publicUser(u), banned: u.banned, banReason: u.banReason || null, timeoutUntil: u.timeoutUntil, restrictedUntil: u.restrictedUntil || null, restrictReason: u.restrictReason || null, email: u.email, unsubscribed: !!u.unsubscribed,
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
        return fail('forbidden', 'Only the Co-Founder / Founder can change roles.');
      }
      if (t.id === actor.id && role !== 'owner') return fail('self', 'You cannot change your own role.');
      if (t.id !== actor.id && isOwnerAccount(t) && role !== 'owner') return fail('adminProtected', 'The Founder account is protected.');
      t.role = role; t.updatedAt = now();
      store.put('users', t);
      flush();
      return ok(true);
    }
    /* Founder grant: set a user's Subscription / Contract tiers directly
       (Co-Founder / Founder only) — e.g. giving an Admin a Contract so they
       can use the Licensed Dashboard. */
    async function adminSetUserPlan(actor, targetId, { protectionTier, contractTier, note } = {}) {
      const r = requireAdmin(actor); if (r) return r;
      if (effRank(actor) < roleRank('cofounder')) return fail('forbidden', 'Only the Co-Founder / Founder can grant plans directly.');
      const t = dbUser(targetId);
      if (!t) return fail('notfound', 'User not found.');
      const pT = Number(protectionTier), cT = Number(contractTier);
      if (![0, 1, 2, 3].includes(pT) || ![0, 1, 2, 3].includes(cT)) return fail('invalid', 'Tiers must be 0–3.');
      t.protectionTier = pT;
      t.contractTier = cT;
      t.updatedAt = now();
      store.put('users', t);
      flush();
      return ok({ protectionTier: pT, contractTier: cT });
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
    /* Admin email blasts — drafts, immediate sends, and scheduled sends.
       The branded HTML shell is applied automatically by the mailer; admins
       only write the subject + main content. Users who unsubscribed are
       always skipped (see the unsubscribe route + Brevo webhook below). */
    function blastTargets(userIds) {
      let targets = all('users');
      if (Array.isArray(userIds) && userIds.length) {
        const set = new Set(userIds.map(String));
        targets = targets.filter(u => set.has(u.id));
      }
      return targets.filter(u => okEmail(u.email) && !u.unsubscribed);
    }
    function deliverBlast(blast) {
      let targets;
      try { targets = JSON.parse(blast.recipients || '[]'); } catch (e) { targets = []; }
      if (!Array.isArray(targets) || !targets.length) return 0;
      let sent = 0;
      for (const uid of targets) {
        const u = dbUser(uid);
        if (!u || !okEmail(u.email) || u.unsubscribed) continue;
        sendEmail({ to: u.email, subject: blast.subject, action: 'blast', body: 'Hi ' + (u.displayName || u.handle) + ',\n\n' + blast.body, link: '#/' });
        sent++;
      }
      return sent;
    }
    async function adminSendEmail(actor, { userIds, subject, body, scheduleAt, draft } = {}) {
      const r = requireAdmin(actor); if (r) return r;
      subject = String(subject || '').trim();
      body = String(body || '').trim();
      if (subject.length < 1 || subject.length > 120) return fail('invalid', 'Subject must be 1–120 characters.');
      if (body.length < 1 || body.length > 2000) return fail('invalid', 'Message must be 1–2000 characters.');
      const targets = blastTargets(userIds);
      if (!targets.length) return fail('invalid', 'No recipients matched a valid email address (unsubscribed users are skipped).');
      const recipientIds = targets.map(u => u.id);
      const when = scheduleAt ? Number(scheduleAt) : 0;
      if (when && when < now()) return fail('invalid', 'Schedule time must be in the future.');
      /* Saved as a draft (no send), scheduled (fires later), or sent now. */
      if (draft || when) {
        const blast = {
          id: 'mb' + uid(), subject, body,
          recipients: JSON.stringify(recipientIds),
          status: draft ? 'draft' : 'scheduled',
          scheduledFor: when || null, createdAt: now(), updatedAt: now(), sentAt: null,
        };
        store.put('mail_blasts', blast);
        flush();
        return ok({ saved: true, id: blast.id, status: blast.status, scheduledFor: when || null, recipients: recipientIds.length });
      }
      const sent = deliverBlast({ id: 'mb' + uid(), subject, body, recipients: JSON.stringify(recipientIds) });
      flush();
      return ok({ sent, total: recipientIds.length });
    }
    async function adminListBlasts(actor) {
      const r = requireAdmin(actor); if (r) return r;
      const rows = all('mail_blasts').slice().sort((a, b) => b.createdAt - a.createdAt);
      return ok(rows.map(b => {
        let recipients = [];
        try { recipients = JSON.parse(b.recipients || '[]'); } catch (e) {}
        return { ...b, recipientCount: recipients.length };
      }));
    }
    async function adminDeleteBlast(actor, id) {
      const r = requireAdmin(actor); if (r) return r;
      const b = byIdIn('mail_blasts', id);
      if (!b) return fail('notfound', 'Blast not found.');
      store.del('mail_blasts', id);
      flush();
      return ok(true);
    }
    /* Called by the server on an interval — fires any scheduled blasts whose
       time has come. No-op when nothing is due. */
    function processScheduledBlasts() {
      const due = all('mail_blasts').filter(b => b.status === 'scheduled' && b.scheduledFor && b.scheduledFor <= now());
      let fired = 0;
      for (const b of due) {
        const sent = deliverBlast(b);
        b.status = 'sent'; b.sentAt = now(); b.updatedAt = now();
        store.put('mail_blasts', b);
        fired += sent;
      }
      if (fired) { flush(); console.log('[blast] fired scheduled email → ' + fired + ' recipients'); }
      return fired;
    }
    /* Inbound email events from Brevo (webhook): replies, bounces, and
       unsubscribes. Unsubscribes flip the user flag so future blasts skip
       them; everything is logged for the admin Mailbox. */
    async function inboundMailEvent({ email, event, subject, body, detail } = {}) {
      email = String(email || '').trim().toLowerCase();
      if (!okEmail(email)) return fail('invalid', 'Valid email required.');
      event = String(event || '').trim().toLowerCase() || 'reply';
      store.put('mail_inbound', {
        id: 'mi' + uid(), email, event,
        subject: String(subject || '').slice(0, 200) || null,
        body: String(body || '').slice(0, 2000) || null,
        detail: String(detail || '').slice(0, 500) || null,
        createdAt: now(),
      });
      if (event === 'unsubscribe' || event === 'spamreport' || event === 'blocked') {
        const u = all('users').find(x => x.email.toLowerCase() === email);
        if (u) { u.unsubscribed = 1; u.updatedAt = now(); store.put('users', u); }
      }
      flush();
      return ok(true);
    }
    async function adminListInbound(actor) {
      const r = requireAdmin(actor); if (r) return r;
      return ok(all('mail_inbound').slice().sort((a, b) => b.createdAt - a.createdAt));
    }
    async function adminSetUnsubscribed(actor, userId, unsubscribed) {
      const r = requireAdmin(actor); if (r) return r;
      const u = dbUser(userId);
      if (!u) return fail('notfound', 'User not found.');
      if (effRank(u) >= roleRank('cofounder')) return fail('adminProtected', 'Staff accounts cannot be unsubscribed.');
      u.unsubscribed = unsubscribed ? 1 : 0;
      u.updatedAt = now();
      store.put('users', u);
      flush();
      return ok(true);
    }
    /* Per-user send history — every email that went to this account. */
    async function adminEmailHistory(actor, userId) {
      const r = requireAdmin(actor); if (r) return r;
      const u = dbUser(userId);
      if (!u) return fail('notfound', 'User not found.');
      return ok({
        user: { ...publicUser(u), email: u.email, unsubscribed: !!u.unsubscribed },
        emails: all('emails').filter(e => String(e.to).toLowerCase() === u.email.toLowerCase()).slice().sort((a, b) => b.createdAt - a.createdAt),
        inbound: all('mail_inbound').filter(e => e.email === u.email.toLowerCase()).slice().sort((a, b) => b.createdAt - a.createdAt),
      });
    }

    /* ============ CREATORS (admin-published, like portfolio) ============ */
    async function createCreator(actor, { name, role, bio, docs, links, handle, imageUrl } = {}) {
      const r = requireCofounder(actor, 'add creators'); if (r) return r;
      name = String(name || '').trim();
      if (name.length < 1 || name.length > 60) return fail('invalid', 'Name is required (1–60 chars).');
      const img = normalizeImageUrl(imageUrl);
      if (img === null && String(imageUrl || '').trim()) return fail('invalid', 'Image link must be a valid http(s) URL.');
      const item = {
        id: 'cr' + uid(), name,
        role: String(role || '').trim().slice(0, 60),
        bio: String(bio || '').trim().slice(0, 300),
        docs: String(docs || '').trim().slice(0, 12000),
        imageUrl: img,
        links: JSON.stringify(cleanPortfolioLinks(links)),
        handle: String(handle || '').trim().slice(0, 30),
        createdAt: now(),
      };
      store.put('creators', item);
      flush();
      return ok({ id: item.id });
    }
    async function updateCreator(actor, id, patch = {}) {
      const r = requireCofounder(actor, 'edit creators'); if (r) return r;
      const it = byIdIn('creators', id);
      if (!it) return fail('notfound', 'Creator not found.');
      if (patch.name !== undefined) it.name = String(patch.name || '').trim().slice(0, 60);
      if (patch.role !== undefined) it.role = String(patch.role || '').trim().slice(0, 60);
      if (patch.bio !== undefined) it.bio = String(patch.bio || '').trim().slice(0, 300);
      if (patch.docs !== undefined) it.docs = String(patch.docs || '').trim().slice(0, 12000);
      if (patch.imageUrl !== undefined) it.imageUrl = String(patch.imageUrl || '').trim().slice(0, 300) || null;
      if (patch.handle !== undefined) it.handle = String(patch.handle || '').trim().slice(0, 30);
      if (patch.links !== undefined) it.links = JSON.stringify(cleanPortfolioLinks(patch.links));
      store.put('creators', it);
      flush();
      return ok(true);
    }
    async function deleteCreator(actor, id) {
      const r = requireAdmin(actor); if (r) return r;
      if (effRank(actor) < roleRank('cofounder')) return fail('forbidden', 'Only the Co-Founder or Founder can delete creator posts.');
      if (!byIdIn('creators', id)) return fail('notfound', 'Creator not found.');
      store.del('creators', id);
      flush();
      return ok(true);
    }

    /* ============ SITE STATUS & SECURITY (Founder Panel) ============
       Lightweight in-memory event ring + a DB status snapshot. The ring is
       capped so it can never grow unbounded. */
    const SEC_EVENTS = [];
    const SEC_MAX = 400;
    function recordSecurityEvent(type, meta = {}) {
      try {
        SEC_EVENTS.push({ id: 'se' + uid(), type, at: now(), ...meta });
        if (SEC_EVENTS.length > SEC_MAX) SEC_EVENTS.splice(0, SEC_EVENTS.length - SEC_MAX);
      } catch (e) { /* never let logging break a request */ }
    }
    async function siteStatus(actor) {
      const r = requireAdmin(actor); if (r) return r;
      const count = t => all(t).length;
      /* Server health */
      const mem = process.memoryUsage();
      const upt = process.uptime();
      const loadAvg = (typeof os !== 'undefined' && os.loadavg) ? os.loadavg() : [];
      const dbStats = (() => {
        try {
          const s = store.stats ? store.stats() : null;
          if (s && s.dbBytes) return s;
          return null;
        } catch (e) { return null; }
      })();
      let dbBytes = dbStats && dbStats.dbBytes || null;
      let uploadsBytes = dbStats && dbStats.uploadsBytes || null;
      const counts = {
        users: count('users'), assets: count('assets'), pending: count('assets') && all('assets').filter(a => a.status === 'pending').length,
        purchases: count('purchases'), orders: count('orders'), ordersPendingVerification: all('orders').filter(o => o.status === 'pending_verification').length,
        systems: count('systems'), systemDevices: count('system_devices'), systemGames: count('system_games'),
        sessions: count('sessions'), online: all('sessions').filter(s => now() - s.lastSeen < cfg.onlineWindowMs).length,
        ticketsOpen: all('tickets').filter(x => x.status === 'open').length,
        reportsOpen: all('reports').filter(x => x.status === 'open').length,
        emails: count('emails'), portfolio: count('portfolio'), creators: count('creators'), comments: count('comments'), reviews: count('reviews'), likes: count('likes'),
        banned: all('users').filter(u => u.banned).length, timedOut: all('users').filter(u => isTimedOut(u)).length,
      }; 
      /* Security: failed system-credential checks (license bypass attempts) */
      const secEvents = SEC_EVENTS.slice().reverse();
      const recent = ms => secEvents.filter(e => now() - e.at < ms);
      const security = {
        total: secEvents.length,
        last24h: recent(24 * 3600e3).length,
        last1h: recent(3600e3).length,
        failedLicenseChecks24h: recent(24 * 3600e3).filter(e => e.type === 'license_check_failed').length,
        rateLimited24h: recent(24  * 3600e3).filter(e => e.type === 'rate_limited').length,
        rateLimited1h: recent(3600e3).filter(e => e.type === 'rate_limited').length,
        authFails24h: recent(24 * 3600e3).filter(e => e.type === 'auth_fail').length,
        authFails1h: rollupWindows => secEvents.filter(e => e.type === 'auth_fail' && now() - e.at < 3600e3).length,
        proofAttempts24h: recent(24 * 3600e3).filter(e => e.type === 'proof_resubmit').length,
        fakePurchaseFlags: recent(24 * 3600e3).filter(e => e.type === 'fake_purchase_flag').length,
        forbidden24h: recent(24 * 3600e0).filter(e => e.type === 'forbidden').length,
        events: secEvents.slice(0, 80),
        safeguards: [
          { name: 'Password hashing', detail: 'PBKDF2-SHA512 with per-user salt — passwords never stored in plain text.' },
          { name: 'Session tokens', detail: 'Random 144-bit tokens, 30-day expiry, revoked on logout.' },
          { name: 'License gate', detail: 'Roblox checks in with system name + password; wrong pair = no activation, logged.' },
          { name: 'License rate limit', detail: '60 license checks/min per IP — brute-force attempts get throttled (429) and logged.' },
          { name: 'Mass kick on deny', detail: 'Every leaked copy force-disconnects all its players on the next check-in.' },
          { name: 'Ban on blacklist', detail: 'Blacklisted games get real Roblox bans (BanAsync), auto-lifted when re-allowed.' },
          { name: 'Purchase proof flow', detail: 'Manual payments stay incomplete until the seller verifies the buyer\'s proof; auto-completion is excluded for manual orders.' },
          { name: 'Upload proxy', detail: 'Image/file uploads run server-side only: login required, type/size caps, DB stores URLs not bytes.' },
          { name: 'Post approval queue', detail: 'Non-staff posts enter pending and need staff approval before they appear in the shop.' },
          { name: 'Founder identity bypass', detail: 'Your account keeps Founder powers even if its role row is edited.' },
        ],
      };
      security.authFails24h = recent(24 * 3600e3).filter(e => e.type === 'auth_fail').length; // fix the accidental override above
      return ok({ server: { uptimeSeconds: Math.round(upt), memory: { rssMB: +(mem.rss / 1048576).toFixed(1), heapMB: +(mem.heapUsed / 1048576).toFixed(1) }, loadAvg, node: process.version, platform: process.platform, time: now() }, db: { bytes: dbBytes, uploadsBytes, counts, integrity: dbStats && dbStats.integrity || null }, security, paymentConfigured: (() => { try { const row = byIdIn('site_settings', 'payment_config'); if (!row) return false; const v = JSON.parse(row.value); return !!(v.gcashQrUrl || v.kofiUrl || v.paypalAccount); } catch (e) { return false; } })(), imageHost: (await getImgurSettings()).data });
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
      /* When staff replies, notify the ticket creator by email. */
      if (isStaffUser && !isOwner) {
        try {
          const creator = dbUser(ticket.userId);
          if (creator) sendEmail({
            to: creator.email,
            subject: 'New reply on your ticket — "' + ticket.subject + '"',
            action: 'ticket',
            body: 'The Kings Production team replied to your support ticket "' + ticket.subject + '":\n\n' + body.slice(0, 800) + '\n\nOpen the ticket to continue the conversation.',
            link: '#/ticket/' + ticket.id,
          });
        } catch (e) { console.error('ticket reply email failed', e); }
      }
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
    /* ============ CHAT WITH SELLER (per-asset ephemeral chat) ============
       A lightweight buyer↔seller conversation attached to an asset. Messages
       are EPHEMERAL: any message older than 24h is pruned on read, only the
       stable chat code ("ticket number") survives, so nothing is kept forever. */
    /* ---- FAQ (editable from the Founder/Admin Panel) ----
       Persisted in site_settings as JSON so staff can edit Q&A from the web. */
    const FAQ_DEFAULTS = [
      { q: 'What is Kings Production?', a: 'Kings Production is a marketplace for Roblox Studio assets — animations, models, plugins, and protected systems — built by verified creators.' },
      { q: 'How do I become a Licensed seller?', a: 'Head to the Subscription page and grab a Subscription (protect + register your own systems) or a Contract plan (post and sell on the marketplace). Your account upgrades instantly after approval.' },
      { q: 'Why do I need to verify my email?', a: 'Email verification is optional — you can browse and post without it. But if you ever forget your password, a verified email is the only way to recover your account, so we strongly recommend it (Settings → Verify email).' },
      { q: 'What is a system license?', a: 'When you register a system you get a Lua block for Studio. Paste it at the top of your server script: it phones home, checks the license and the game\'s permission, and only then runs your actual code. Revoke a game on the web and every copy stops within minutes.' },
      { q: 'Someone is using my system without permission — what do I do?', a: 'Open the Licensed Dashboard → Registered Systems → Games, revoke or blacklist the game, and contact staff through Support. Every check-in from that game is logged.' },
      { q: 'How do payments work?', a: 'Orders are paid via Stripe, PayPal, or GCash. For system purchases the seller reviews your game details and activates the license — track everything under Orders.' },
      { q: 'Can I get a refund?', a: 'Contact the seller first through their Support or profile. If they do not respond, open a ticket and staff will review the order logs.' },
      { q: 'My post is still pending — why?', a: 'New posts are reviewed by staff before they appear in the shop. Founder and Co-Founder posts go live instantly. If it has been more than 24 hours, open a Support ticket.' },
    ];
    function getFaqs() {
      const row = byIdIn('site_settings', 'faqs');
      if (!row) return ok(FAQ_DEFAULTS.map((f, i) => ({ id: 'f' + i, ...f })));
      try {
        const list = JSON.parse(row.value);
        if (!Array.isArray(list)) throw new Error('bad');
        return ok(list);
      } catch (e) { return ok(FAQ_DEFAULTS.map((f, i) => ({ id: 'f' + i, ...f }))); }
    }
    async function saveFaqs(actor, list) {
      const r = requireAdmin(actor); if (r) return r;
      if (!Array.isArray(list)) return fail('invalid', 'FAQ list must be an array.');
      const clean = list.slice(0, 50).map((f, i) => ({
        id: 'f' + i,
        q: String(f && f.q || '').trim().slice(0, 200),
        a: String(f && f.a || '').trim().slice(0, 2000),
      })).filter(f => f.q && f.a);
      if (!clean.length) return fail('invalid', 'Add at least one question with an answer.');
      store.put('site_settings', { id: 'faqs', value: JSON.stringify(clean), updatedAt: now() });
      flush();
      return ok(clean);
    }
    /* ---- Legal documents (Terms of Use / Privacy Policy), editable by Co-Founder+ ----
       Stored as plain text; lines starting with "## " become section headings. */
    const LEGAL_DEFAULTS = {
      terms: [
        'These Terms of Use ("Terms") govern your access to and use of the Kings Production website and marketplace. By creating an account, browsing, or purchasing anything on this site, you agree to these Terms.',
        '## Eligibility and accounts',
        'You must be at least 13 years old to use this site. You are responsible for keeping your login credentials secure and for everything done through your account. One account per person: do not create accounts to evade a ban or timeout, and do not share or sell your account.',
        'We may suspend, time out, or permanently ban accounts that violate these Terms or are reported for misconduct.',
        '## The marketplace and creators',
        'Asset files are posted by Licensed sellers and are reviewed by the Kings Production team before they go live. We moderate submissions and reserve the right to reject or remove any asset at any time. Prohibited content includes anything illegal, malicious (including malware), stolen or infringing, or otherwise harmful.',
        'You may not post assets you do not own or have the right to sell, and you may not copy or redistribute content from this site without permission.',
        '## Purchases, license keys, and payments',
        'When you purchase an asset, you receive a unique license key (a "KP-" key) recorded to your account. The key grants you a non-exclusive, personal license to use that asset in your projects, subject to any terms stated on the asset page. Keys are issued upon successful payment and cannot be transferred or resold.',
        'Buying an asset issues a license key for that asset only — it does not change your account role or unlock posting. To sell your own assets, purchase a Contract plan on the Subscription page.',
        'Payments are processed through third-party providers: Stripe (cards), PayPal, and GCash (via PayMongo). The provider handles your payment details — we never see or store your card or payment information. Until a gateway is connected, checkout runs in test mode and completes without moving money.',
        '## Intellectual property',
        'Creators retain ownership of the assets they post; by posting, they grant Kings Production a license to host, display, and sell those assets on this site. The site itself — its design, branding, the crown logo, and the studio\'s own content — is the property of Kings Production. You may not copy, scrape, mirror, or reuse the site, its design, or its content.',
        'This website is an independent project. We are not affiliated with, endorsed by, or sponsored by Roblox Corporation. "Roblox" is a trademark of Roblox Corporation.',
        '## Respect for Roblox and user privacy',
        'We are aware of and follow the Roblox Terms of Use. This site does not scrape or harvest any data from Roblox or from Roblox users — see our Privacy Policy for the full explanation. You are responsible for making sure any asset you use in Roblox complies with the Roblox Terms of Use and your agreements with Roblox.',
        '## Disclaimer and liability',
        'The site and all assets are provided "as is", without warranties of any kind. To the maximum extent permitted by law, Kings Production is not liable for any indirect or consequential damages arising from your use of the site or from assets purchased here. Purchases are final except where required by law.',
        '## Changes and contact',
        'We may update these Terms from time to time; the latest version is always on this page. Continued use of the site means you accept the current Terms. Questions? Contact the Kings Production team through the site or the community links on this page.',
      ].join('\n\n'),
      privacy: [
        'Kings Production ("we", "our", "us") runs this marketplace and development-studio site. This policy explains what information we collect, why we collect it, and how we protect it. By using the site you agree to the practices described here.',
        '## Information we collect',
        'Account information you provide voluntarily — your handle, display name, email address, and any profile picture or bio you choose to add. We also keep records of the assets, comments, reviews, and reports you post, and of purchases and license keys issued to your account.',
        'Basic technical data needed to operate and secure the service — such as your IP address and browser type in server logs, used only for security, abuse prevention, and rate-limiting.',
        '## How we use it',
        'Everything we store exists to run the site: to create and secure your account, protect it with two-factor authentication if you enable it, process purchases and license keys, moderate submissions, and respond to reports. We do not sell, rent, or trade your personal information to anyone. There are no third-party advertisements and no third-party trackers or analytics on this site.',
        '## Where your data lives',
        'Your data is stored on our servers (and, where configured, in secure cloud storage providers used solely to host this site). Your password is never stored in plain text — it is salted and hashed with PBKDF2. Your session is an encrypted token kept only in your own browser, so you stay logged in on your device.',
        '## Roblox and our no-scraping promise',
        'We are fully aware of, and comply with, the Roblox Terms of Use and Roblox privacy expectations. This site does not scrape, harvest, crawl, or otherwise collect any information from Roblox, from Roblox accounts, or from Roblox users — not today, not ever.',
        'Why? Three reasons. First, scraping or accessing Roblox user data without permission would violate the Roblox Terms of Use. Second, we do not need it: this is an independent storefront where asset files are delivered directly on this site, so no Roblox platform data is required to run it. Third, privacy by design: we believe in collecting only what is necessary, and the only information we hold is what you give us voluntarily here.',
        'The one exception is data you choose to enter yourself: for example, if you assign a license key to a Roblox game, you type in that game ID — we never look it up, fetch from Roblox, or use it for anything other than recording your license assignment.',
        '## Children',
        'The site is intended for users aged 13 and older, consistent with Roblox\'s own age requirements. We do not knowingly collect personal information from children under 13. If you believe a child has provided us personal information, contact us and we will delete it.',
        '## Your choices and rights',
        'You can view and edit your profile and security settings at any time, disable two-factor authentication, and request deletion of your account by contacting us. We will honor deletion requests promptly, subject to records we are required to keep for security or legal reasons.',
        '## Changes to this policy',
        'If we change this policy, we will update the date above and, for significant changes, announce it on the site. Continued use of the site after changes means you accept the updated policy.',
        'Questions? Contact the Kings Production team through the site or the community links on this page.',
      ].join('\n\n'),
    };
    const LEGAL_KEYS = ['terms', 'privacy'];
    function getLegalDoc(key) {
      if (!LEGAL_KEYS.includes(key)) return fail('invalid', 'Unknown document.');
      const row = byIdIn('site_settings', 'legal_' + key);
      if (row) {
        try {
          const v = JSON.parse(row.value);
          if (v && typeof v.body === 'string' && v.body.trim()) return ok({ key, body: v.body, updatedAt: v.updatedAt || row.updatedAt || 0 });
        } catch (e) { /* fall through to default */ }
      }
      return ok({ key, body: LEGAL_DEFAULTS[key], updatedAt: 0 });
    }
    async function saveLegalDoc(actor, key, body) {
      const r = requireCofounder(actor, 'edit legal documents'); if (r) return r;
      if (!LEGAL_KEYS.includes(key)) return fail('invalid', 'Unknown document.');
      const text = String(body == null ? '' : body).replace(/\r\n/g, '\n').trim();
      if (text.length < 40) return fail('invalid', 'The document is too short.');
      const payload = { body: text.slice(0, 60000), updatedAt: now() };
      store.put('site_settings', { id: 'legal_' + key, value: JSON.stringify(payload), updatedAt: now() });
      flush();
      return ok({ key, ...payload });
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
      /* Backup log: closing is recorded as a system message so the full
         conversation survives even after a later cleanup. */
      const staff = byIdIn('users', actor.id);
      store.put('ticket_messages', { id: 'tm' + uid(), ticketId: ticket.id, userId: null, body: 'Ticket closed by ' + (staff ? (staff.displayName || staff.handle) : 'staff') + '.', kind: 'system', actorName: staff ? (staff.displayName || staff.handle) : 'Staff', createdAt: now() });
      flush();
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

    /* ============ ANNOUNCEMENTS (site-wide banner) ============ */
    const ANN_STYLES = ['gold', 'green', 'red'];
    function listAnnouncements() {
      return ok(all('announcements').filter(a => a.active).sort((a, b) => b.createdAt - a.createdAt));
    }
    async function createAnnouncement(actor, { title, body, link, style } = {}) {
      const r = requireAdmin(actor); if (r) return r;
      title = String(title || '').trim();
      body = String(body || '').trim();
      if (title.length < 3 || title.length > 120) return fail('invalid', 'Title must be 3–120 characters.');
      if (body.length < 3 || body.length > 500) return fail('invalid', 'Body must be 3–500 characters.');
      link = String(link || '').trim();
      if (link && !/^https?:\/\//i.test(link)) return fail('invalid', 'Link must be a full URL (https://…).');
      style = ANN_STYLES.includes(String(style || '')) ? style : 'gold';
      const t = now();
      const a = { id: 'an' + uid(), title, body, link: link || null, style, active: true, createdAt: t, updatedAt: t };
      store.put('announcements', a);
      flush();
      return ok(a);
    }
    async function updateAnnouncement(actor, id, patch = {}) {
      const r = requireAdmin(actor); if (r) return r;
      const a = byIdIn('announcements', id);
      if (!a) return fail('notfound', 'Announcement not found.');
      if (patch.title !== undefined) {
        const t = String(patch.title).trim();
        if (t.length < 3 || t.length > 120) return fail('invalid', 'Title must be 3–120 characters.');
        a.title = t;
      }
      if (patch.body !== undefined) {
        const b = String(patch.body).trim();
        if (b.length < 3 || b.length > 500) return fail('invalid', 'Body must be 3–500 characters.');
        a.body = b;
      }
      if (patch.link !== undefined) a.link = String(patch.link || '').trim() ? String(patch.link).trim() : null;
      if (patch.style !== undefined) a.style = ANN_STYLES.includes(String(patch.style)) ? patch.style : a.style;
      if (patch.active !== undefined) a.active = !!patch.active;
      a.updatedAt = now();
      store.put('announcements', a);
      flush();
      return ok(a);
    }
    async function deleteAnnouncement(actor, id) {
      const r = requireAdmin(actor); if (r) return r;
      if (!byIdIn('announcements', id)) return fail('notfound', 'Announcement not found.');
      store.del('announcements', id);
      flush();
      return ok(true);
    }

    /* ============ SYSTEM REGISTERING (creator → Roblox Studio licensing) ============ */
    /* Matches the copyable Lua script's API contract:
       POST /api/systems/{activate,heartbeat,device}
       Body: { systemName, systemPassword, deviceId | playerId, playerName }
       Reply: { ok, data: { active, reason } } */
    const SYS_STATES = ['active', 'disabled'];
    /* Subscription 1/2/3 → max registered systems + registrations per day (0 = unlimited).
       Deleting a system is always instant — only registering is limited.
       VIP (complimentary tier) plays at Subscription-1 limits: 3 systems, 1/day.
       The Founder can raise an individual VIP above that via Plans on the panel. */
    const PROT_LIMITS = [{ max: 3, perDay: 1 }, { max: 10, perDay: 0 }, { max: 50, perDay: 0 }];
    const VIP_LIMITS = { max: 3, perDay: 1 };
    function systemPlanLimits(u) {
      const pT = Math.min(3, Math.max(0, Number(u.protectionTier) || 0));
      const cT = Math.min(3, Math.max(0, Number(u.contractTier) || 0));
      if (pT >= 1 && cT >= 1) return { max: Math.max(PROT_LIMITS[pT - 1].max, PROT_LIMITS[cT - 1].max), perDay: Math.min(PROT_LIMITS[pT - 1].perDay, PROT_LIMITS[cT - 1].perDay) || 0, label: pT >= cT ? 'Subscription ' + pT : 'Contract ' + cT };
      if (pT >= 1) return { ...PROT_LIMITS[pT - 1], label: 'Subscription ' + pT };
      if (cT >= 1) return { ...PROT_LIMITS[cT - 1], label: 'Contract ' + cT };
      if (isVipUser(u)) return { ...VIP_LIMITS, label: 'VIP' };
      return null;
    }
    function findSystemByCreds(name, password) {
      return all('systems').find(s => String(s.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase() && s.password === String(password || ''));
    }
    function systemPublic(s) {
      return { id: s.id, name: s.name, status: s.status, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, staffNote: s.staffNote || null };
    }
    function systemForOwner(s) {
      const devices = all('system_devices').filter(d => d.systemId === s.id).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map(d => ({ id: d.id, deviceId: d.deviceId, deviceName: d.deviceName, status: d.status, lastSeenAt: d.lastSeenAt }));
      const games = all('system_games').filter(g => g.systemId === s.id).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map(g => ({ id: g.id, placeId: g.placeId, status: g.status, gameName: g.gameName || null, gameOwner: g.gameOwner || null, gameOwnerType: g.gameOwnerType || null, lastSeenAt: g.lastSeenAt }));
      return { ...systemPublic(s), password: s.password, kickOnDeny: s.kickOnDeny !== 0, banOnBlacklist: s.banOnBlacklist === 1, devices, games };
    }
    async function registerSystem(user, { name, password } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      if (effRank(u) < roleRank('vip') && !isTester(u)) return fail('vipOnly', 'System registering is a Licensed feature — grab a Subscription or Contract to unlock it.');
      /* Founder / Co-Founder run the platform, so they register freely —
         the plan gate applies to Admins and below. */
      if (isStaff(u) && effRank(u) < roleRank('cofounder') && !(Number(u.protectionTier) > 0) && !(Number(u.contractTier) > 0) && !isTester(u)) return fail('vipOnly', 'Admins register systems only with a plan — grant one on the Founder Panel, or buy on the Subscription page.');
      name = String(name || '').trim();
      password = String(password || '').trim();
      if (name.length < 3 || name.length > 60) return fail('invalid', 'System name must be 3–60 characters.');
      if (password.length < 6 || password.length > 80) return fail('invalid', 'System password must be 6–80 characters.');
      if (!/^[\w .\-()&'"!?+]+$/.test(name)) return fail('invalid', 'System name may only contain letters, numbers, spaces, and basic punctuation.');
      /* Duplicate names are allowed on purpose — the name + password PAIR is
         the identity (e.g. "Music System" + "PassWorD"). */
      const mine = () => all('systems').filter(s => s.userId === u.id);
      /* Founder / Co-Founder: no limits at all. Admins and sellers follow
         their plan; VIPs get the complimentary Subscription-1 caps. */
      if (effRank(u) < roleRank('cofounder') && !isTester(u)) {
        const plan = systemPlanLimits(u);
        if (!plan) return fail('vipOnly', 'Buy a Subscription plan (Subscription page) to register systems.');
        const list = mine();
        if (list.length >= plan.max) return fail('limit', 'Your ' + plan.label + ' plan allows up to ' + plan.max + ' registered systems. Deleting one is instant and frees a slot.');
        if (plan.perDay > 0) {
          const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
          if (list.filter(s => s.createdAt >= dayStart.getTime()).length >= plan.perDay)
            return fail('cooldown', 'Your ' + plan.label + ' plan allows ' + plan.perDay + ' system registration per day — upgrade your Subscription for more.');
        }
      }
      const t = now();
      const s = { id: 'sys' + uid(), userId: u.id, name, password, status: 'active', createdAt: t, updatedAt: t, lastSeenAt: null };
      store.put('systems', s);
      flush();
      return ok(systemForOwner(s));
    }
    async function listSystems(user) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      return ok(all('systems').filter(s => s.userId === u.id).sort((a, b) => b.createdAt - a.createdAt).map(systemForOwner));
    }
    async function deleteSystem(user, id) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const s = byIdIn('systems', id);
      if (!s || s.userId !== u.id) return fail('forbidden', 'System not found.');
      all('system_devices').filter(d => d.systemId === s.id).forEach(d => store.del('system_devices', d.id));
      all('system_games').filter(g => g.systemId === s.id).forEach(g => store.del('system_games', g.id));
      store.del('systems', s.id);
      flush();
      return ok(true);
    }
    /* Re-resolve every game row's real name + creator from Roblox's public API.
       Heals rows recorded before the Lua sent rich metadata ("Game", "Group 123"). */
    async function refreshSystemGames(actor, systemId) {
      const u = resolveUser(actor);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const s = byIdIn('systems', systemId);
      if (!s) return fail('notfound', 'System not found.');
      const owner = byIdIn('users', s.userId);
      const rank = u ? effRank(u) : 0;
      if (s.userId !== u.id && rank < roleRank('admin')) return fail('forbidden', 'This is not your system.');
      if (typeof fetch !== 'function') return fail('invalid', 'Game info refresh is only available on the server.');
      const games = all('system_games').filter(g => g.systemId === s.id);
      let healed = 0;
      await Promise.all(games.map(async g => {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 6000);
          const ur = await fetch('https://apis.roblox.com/universes/v1/places/' + g.placeId + '/universe', { signal: ctl.signal });
          const uj = await ur.json();
          if (!uj || !uj.universeId) return;
          const gr = await fetch('https://games.roblox.com/v1/games?universeIds=' + uj.universeId, { signal: ctl.signal });
          const gj = await gr.json();
          clearTimeout(timer);
          const info = gj && gj.data && gj.data[0];
          if (!info) return;
          let changed = false;
          if (info.name && info.name !== 'Game' && g.gameName !== info.name) { g.gameName = String(info.name).slice(0, 80); changed = true; }
          if (info.creator && info.creator.name && g.gameOwner !== info.creator.name) {
            g.gameOwner = String(info.creator.name).slice(0, 80);
            g.gameOwnerType = String(info.creator.type === 1 ? 'User' : info.creator.type === 2 ? 'Group' : (info.creator.type || '')).replace('Enum.CreatorType.', '');
            changed = true;
          }
          if (changed) { store.put('system_games', g); healed++; }
        } catch (e) { /* network/parse failure — keep the old labels */ }
      }));
      if (healed) flush();
      return ok({ healed, system: systemForOwner(s) });
    }
    /* The heart of the anti-leak flow: the game checks in with the name +
       password; a match means the system is licensed. First successful contact
       flips PENDING → ACTIVE; a paused (disabled) system is always denied. */
    function checkSystemCreds(body) {
      const s = findSystemByCreds(body && body.systemName, body && body.systemPassword);
      if (!s) {
        recordSecurityEvent('license_check_failed', { systemName: String((body && body.systemName) || '').slice(0, 40), placeId: String((body && body.placeId) || '').slice(0, 25) || null });
        return { found: false, reason: 'No system matches that name and password. Double-check them on the Dashboard.' };
      }
      if (s.status === 'disabled') return { found: true, denied: true, reason: 'This system has been paused by its creator. Contact the creator to re-enable it.' };
      return { found: true, system: s };
    }
    /* Shared device bookkeeping + a revoked-device auto-kick: a device the
       creator kicked gets a DENIED answer on its next check-in, so the Lua
       script disables the system (and kicks the player) immediately. */
    /* Security logging: wrong system name+password = someone probing the license gate. */
    function deviceState(s, deviceId) {
      if (!deviceId) return null;
      const d = all('system_devices').find(x => x.systemId === s.id && x.deviceId === String(deviceId));
      return d || null;
    }
    function recordDevice(s, deviceId, deviceName) {
      const key = String(deviceId).slice(0, 80);
      const existing = all('system_devices').find(d => d.systemId === s.id && d.deviceId === key);
      if (existing) { existing.lastSeenAt = now(); if (deviceName) existing.deviceName = String(deviceName).slice(0, 40) || null; store.put('system_devices', existing); return existing; }
      const d = { id: 'sd' + uid(), systemId: s.id, deviceId: key, deviceName: deviceName ? String(deviceName).slice(0, 40) : null, status: 'active', createdAt: now(), lastSeenAt: now() };
      store.put('system_devices', d);
      return d;
    }
    /* A "game" is a Roblox place (placeId) using the system. Games register
       themselves when a server checks in; the creator can revoke or
       blacklist a game, and silent ones (30 days) fall off the list. */
    const GAME_STALE_MS = 30 * 24 * 3600 * 1000;
    function gameRow(s, placeId) {
      if (!placeId) return null;
      const key = String(placeId).slice(0, 20);
      return all('system_games').find(g => g.systemId === s.id && g.placeId === key) || null;
    }
    function recordGame(s, placeId, meta) {
      const key = String(placeId || '').slice(0, 20);
      if (!/^\d{1,20}$/.test(key)) return null;
      const existing = gameRow(s, key);
      if (existing) {
        existing.lastSeenAt = now();
        if (meta) {
          /* The Lua sends the live game's real name + creator on every
             check-in — always refresh so old rows self-heal (e.g. rows that
             stored the raw "Enum.CreatorType.Group 123" label). */
          if (meta.gameName) existing.gameName = String(meta.gameName).slice(0, 80);
          if (meta.gameOwner != null && meta.gameOwner !== '') existing.gameOwner = String(meta.gameOwner).slice(0, 80);
          if (meta.gameOwnerType && !existing.gameOwnerType) existing.gameOwnerType = String(meta.gameOwnerType).slice(0, 20);
        }
        store.put('system_games', existing);
        return existing;
      }
      /* NEW games start as 'pending' — the creator must approve them on the
         Licensed Dashboard before the game is allowed to run the system. */
      const g = { id: 'sg' + uid(), systemId: s.id, placeId: key, status: 'pending', gameName: (meta && meta.gameName ? String(meta.gameName).slice(0, 80) : null), gameOwner: (meta && meta.gameOwner != null ? String(meta.gameOwner).slice(0, 80) : null), gameOwnerType: (meta && meta.gameOwnerType ? String(meta.gameOwnerType).slice(0, 20) : null), createdAt: now(), lastSeenAt: now() };
      store.put('system_games', g);
      return g;
    }
    function pruneStaleGames(s) {
      const cutoff = now() - GAME_STALE_MS;
      all('system_games').filter(g => g.systemId === s.id && g.lastSeenAt < cutoff).forEach(g => store.del('system_games', g.id));
    }
    /* Player User IDs the Lua script should kick immediately (kicked devices). */
    function revokedPlayerIds(s) {
      return all('system_devices').filter(d => d.systemId === s.id && d.status === 'revoked' && /^\d{1,20}$/.test(String(d.deviceId))).map(d => String(d.deviceId));
    }
    function bumpSystem(s) {
      s.lastSeenAt = now();
      s.updatedAt = now();
      store.put('systems', s);
      flush();
    }
    function gameGate(s, placeId) {
      const game = gameRow(s, placeId);
      if (!game) return { pending: true, reason: 'This game is not yet approved to use this system. The system creator must approve it on the Licensed Dashboard (Registered Systems → Games).' };
      if (game.status === 'pending') return { pending: true, reason: 'Waiting for approval — the system creator must allow this game on the Licensed Dashboard.' };
      if (game.status === 'revoked') return { denied: true, game, reason: 'This game\'s permission to use this system has been revoked by the creator.' };
      if (game.status === 'blacklisted') return { denied: true, game, reason: 'This game has been blacklisted by the creator.' };
      return { game };
    }
    async function systemActivate({ systemName, systemPassword, deviceId, deviceName, placeId, gameName, gameOwner, gameOwnerType } = {}) {
      const chk = checkSystemCreds({ systemName, systemPassword });
      if (!chk.found) return ok({ active: false, reason: chk.reason });
      if (chk.denied) return ok({ active: false, reason: chk.reason });
      const s = chk.system;
      const dev = deviceState(s, deviceId);
      if (dev && dev.status === 'revoked') return ok({ active: false, reason: 'This device has been kicked by the creator and can no longer use the system.', revokedPlayers: revokedPlayerIds(s) });
      const gate = gameGate(s, placeId);
      if (gate.denied) return ok({ active: false, reason: gate.reason, revokeAll: s.kickOnDeny !== 0, banAll: gate.game && gate.game.status === 'blacklisted' && s.banOnBlacklist === 1, revokedPlayers: revokedPlayerIds(s) });
      if (placeId) { recordGame(s, placeId, { gameName, gameOwner, gameOwnerType }); pruneStaleGames(s); }
      if (gate.pending) return ok({ active: false, pendingApproval: true, reason: gate.reason, revokeAll: s.kickOnDeny !== 0, banAll: false, revokedPlayers: revokedPlayerIds(s) });
      bumpSystem(s);
      if (deviceId) recordDevice(s, deviceId, deviceName);
      return ok({ active: true, reason: 'Licensed and active.', revokeAll: false, banAll: false, unban: true, revokedPlayers: revokedPlayerIds(s) });
    }
    async function systemHeartbeat({ systemName, systemPassword, deviceId, deviceName, placeId, gameName, gameOwner, gameOwnerType } = {}) {
      const chk = checkSystemCreds({ systemName, systemPassword });
      if (!chk.found) return ok({ active: false, reason: chk.reason });
      if (chk.denied) return ok({ active: false, reason: chk.reason });
      const s = chk.system;
      const dev = deviceState(s, deviceId);
      if (dev && dev.status === 'revoked') return ok({ active: false, reason: 'This device has been kicked by the creator and can no longer use the system.', revokedPlayers: revokedPlayerIds(s) });
      const gate = gameGate(s, placeId);
      if (gate.denied) return ok({ active: false, reason: gate.reason, revokeAll: s.kickOnDeny !== 0, banAll: gate.game && gate.game.status === 'blacklisted' && s.banOnBlacklist === 1, revokedPlayers: revokedPlayerIds(s) });
      if (placeId) { recordGame(s, placeId, { gameName, gameOwner, gameOwnerType }); pruneStaleGames(s); }
      if (gate.pending) return ok({ active: false, pendingApproval: true, reason: gate.reason, revokeAll: s.kickOnDeny !== 0, banAll: false, revokedPlayers: revokedPlayerIds(s) });
      bumpSystem(s);
      if (deviceId) recordDevice(s, deviceId, deviceName);
      return ok({ active: true, reason: 'Licensed and active.', revokeAll: false, banAll: false, unban: true, revokedPlayers: revokedPlayerIds(s) });
    }
    /* Player device registration from the Lua script — records who is using the
       system so the creator can see and revoke individual players. */
    async function registerSystemDevice({ systemName, systemPassword, playerId, playerName, placeId, gameName, gameOwner, gameOwnerType } = {}) {
      const chk = checkSystemCreds({ systemName, systemPassword });
      if (!chk.found || chk.denied) return ok({ active: false, reason: chk.reason || 'Not licensed.' });
      const s = chk.system;
      if (playerId) {
        /* A kicked player is told straight away so the script can auto-kick. */
        const kickedDev = all('system_devices').find(d => d.systemId === s.id && d.deviceId === String(playerId));
        if (kickedDev && kickedDev.status === 'revoked') return ok({ active: false, reason: 'This device has been kicked by the creator.', kicked: true });
        const existing = all('system_devices').find(d => d.systemId === s.id && d.deviceId === String(playerId));
        if (existing) { existing.deviceName = String(playerName || existing.deviceName || '').slice(0, 40) || null; existing.lastSeenAt = now(); store.put('system_devices', existing); }
        else store.put('system_devices', { id: 'sd' + uid(), systemId: s.id, deviceId: String(playerId).slice(0, 80), deviceName: String(playerName || '').slice(0, 40) || null, status: 'active', createdAt: now(), lastSeenAt: now() });
        flush();
      }
      if (placeId) recordGame(s, placeId, { gameName, gameOwner, gameOwnerType });
      return ok({ active: true, reason: 'Registered.' });
    }
    async function setSystemStatus(user, id, status) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const s = byIdIn('systems', id);
      if (!s || s.userId !== u.id) return fail('forbidden', 'System not found.');
      status = String(status || '');
      if (!['active', 'disabled'].includes(status)) return fail('invalid', 'Invalid status.');
      s.status = status;
      s.updatedAt = now();
      store.put('systems', s);
      flush();
      return ok(systemForOwner(s));
    }
    async function revokeSystemDevice(user, deviceId) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const d = byIdIn('system_devices', deviceId);
      if (!d) return fail('notfound', 'Device not found.');
      const s = byIdIn('systems', d.systemId);
      if (!s || s.userId !== u.id) return fail('forbidden', 'You can only revoke devices on your own systems.');
      d.status = 'revoked';
      store.put('system_devices', d);
      flush();
      return ok(true);
    }
    /* Kick = revoke (the device is denied on its next check-in and the
       script auto-kicks the player). Authorize = undo a kick. */
    async function authorizeSystemDevice(user, deviceId) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const d = byIdIn('system_devices', deviceId);
      if (!d) return fail('notfound', 'Device not found.');
      const s = byIdIn('systems', d.systemId);
      if (!s || s.userId !== u.id) return fail('forbidden', 'You can only manage devices on your own systems.');
      d.status = 'active';
      d.lastSeenAt = now();
      store.put('system_devices', d);
      flush();
      return ok(true);
    }
    /* Per-system enforcement toggles, set from the Licensed Dashboard.
       kickOnDeny        — when denied/pending/revoked, EVERY player in that
                           game is force-disconnected immediately (default ON:
                           a leaked copy must not keep working).
       banOnBlacklist    — when a game is BLACKLISTED (leak response), players
                           joining it get a permanent Roblox ban via the
                           Players:BanAsync API. Lifted automatically when the
                           game is allowed again (creators can also disable
                           the toggle to lift all bans on the next check-in). */
    async function setSystemEnforcement(user, id, { kickOnDeny, banOnBlacklist } = {}) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const s = byIdIn('systems', id);
      if (!s || s.userId !== u.id) return fail('forbidden', 'System not found.');
      if (kickOnDeny !== undefined) s.kickOnDeny = !!kickOnDeny ? 1 : 0;
      if (banOnBlacklist !== undefined) s.banOnBlacklist = !!banOnBlacklist ? 1 : 0;
      s.updatedAt = now();
      store.put('systems', s);
      flush();
      return ok(systemForOwner(s));
    }
    /* Creator-side game controls: allow / revoke / blacklist a place, or
       remove it from the list entirely. */
    async function setSystemGameStatus(user, gameId, status) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const g = byIdIn('system_games', gameId);
      if (!g) return fail('notfound', 'Game not found.');
      const s = byIdIn('systems', g.systemId);
      if (!s || s.userId !== u.id) return fail('forbidden', 'You can only manage games on your own systems.');
      status = String(status || '');
      if (!['active', 'pending', 'revoked', 'blacklisted'].includes(status)) return fail('invalid', 'Invalid status.');
      g.status = status;
      g.lastSeenAt = now();
      store.put('system_games', g);
      flush();
      return ok(true);
    }
    async function removeSystemGame(user, gameId) {
      const u = resolveUser(user);
      if (!u) return fail('auth', 'You must be logged in to do that.');
      const g = byIdIn('system_games', gameId);
      if (!g) return fail('notfound', 'Game not found.');
      const s = byIdIn('systems', g.systemId);
      if (!s || s.userId !== u.id) return fail('forbidden', 'You can only manage games on your own systems.');
      store.del('system_games', g.id);
      flush();
      return ok(true);
    }

    seedContent();
    ensureOwnerAccount();
    /* NOTE: no automatic role migration here. Earlier builds silently
       converted every 'vip' role to 'licensed' on boot — wiping granted VIPs
       after every restart. Roles are set explicitly by staff now. */
    /* Email verification is now optional — mark every existing account
       verified once so nobody is locked out of anything. */
    try { all('users').filter(u => !u.emailVerified).forEach(u => { u.emailVerified = 1; store.put('users', u); }); flush(); } catch (e) { /* best effort */ }

    return {
      register, requestRegisterCode, login, googleLogin, verify2fa, requestReset, resetPassword, logout, me,
      verifyEmail, resendVerification,
      updateProfile, setup2fa, enable2fa, disable2fa,
      createAsset, postStatus, listApproved, topSelling, getAsset, updateAsset, deleteAsset, myAssets, download,
      purchase, myPurchases, assignLicense, createOrder, createVipOrder, createSubscriptionOrder, createVipTrialOrder, setVipRole, completeOrder, settleOrder, cancelOrder, deleteOrder, sellerDeleteOrder, myOrders, adminOrders, adminCompleteOrder, submitPaymentProof, sellerReviewProof, adminReviewManualOrder, getPaymentConfig, adminSetPaymentConfig,
      addComment, listComments, toggleLike,
      listReviews, addReview, deleteReview,
      createReport, adminReports, adminResolveReport,
      licenseActivate, licenseHeartbeat, creatorDashboard, creatorLicenses, setLicenseStatus, revokeDevice, blockAssetUser, unblockAssetUser, assetBlocksList,
      publicProfile, content, createPortfolio, updatePortfolio, deletePortfolio,
      createCreator, updateCreator, deleteCreator,
      createTicket, addTicketMessage, getTicket, listMyTickets,
      adminListTickets, adminCloseTicket, adminDeleteTicket, getFaqs, saveFaqs, getLegalDoc, saveLegalDoc, processAdminPauseExpiry,
      listAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement,
      processProofDeadlines,
      registerSystem, listSystems, deleteSystem, refreshSystemGames, systemActivate, systemHeartbeat, registerSystemDevice, setSystemStatus, revokeSystemDevice, authorizeSystemDevice, setSystemGameStatus, removeSystemGame, adminSystemDetail, adminSetSystemState, adminSubscriberDetail, adminDeleteSystem, setSystemEnforcement,
      adminOverview, adminPending, adminRejected, adminApprove, adminReject, adminAssets, adminDeleteAsset, getImgurSettings, adminSetImgurSettings, siteStatus, recordSecurityEvent,
      adminUsers, adminBan, adminUnban, adminTimeout, adminClearTimeout, adminSetRole, adminSetTags, adminSetUserPlan, adminSessions, adminEmails, adminSendEmail, adminListBlasts, adminDeleteBlast, adminEmailHistory, adminListInbound, adminSetUnsubscribed, inboundMailEvent, processScheduledBlasts, adminOrders, adminCompleteOrder,
      sellerOrders, setOrderApproval, sellerResponseStats, adminTakeFile, adminSetAssetStatus, adminSetRestriction, adminRequestSubRevoke, adminResolveSubRevoke, adminListSubRevokes, adminUnsubscribePlan, adminSystems,
      setFx,
    };
  }

  return { createEngine, totpCode, COUNTRY_CURRENCY, FX_FALLBACK, CURRENCY_SYMBOL, currencyOf: c => COUNTRY_CURRENCY[String(c || '').toUpperCase()] || 'USD', ROLES, ROLE_LABEL };
});
