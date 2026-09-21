/* THE buyer journey, exactly as it happens in the browser:
   1. seller registers a system + posts it with a REAL multipart file upload
   2. buyer registers, opens checkout with GCash (manual QR — no gateway keys)
   3. buyer fills game details, pays off-site, submits payment proof
   4. seller verifies the proof → license issued for the buyer's game
   5. buyer downloads the file — the bytes must come back, no backup link needed
   Also: free claim download, and the file that lives only on OUR server.
   Run: node scripts/test-buyer-journey.cjs */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3194);
const B = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
function section(t) { console.log('\n— ' + t + ' —'); }
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
const FILE_BYTES = crypto.randomBytes(48 * 1024).toString('latin1'); // 48 KB random payload

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-jny-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, UPLOAD_DIR: path.join(dir, 'up') },
    stdio: 'ignore',
  });
  const req = async (method, p, token, body) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(B + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) { j = { _raw: await r.text().catch(() => '') }; }
    return { status: r.status, body: j };
  };
  const mkUser = async (tag, email) => {
    const mail = email || (tag + (Date.now() % 1000000) + '@jny.test');
    const c = await req('POST', '/api/auth/register-code', null, { email: mail });
    const code = c.body && c.body.data && c.body.data.devCode;
    if (!code) throw new Error('no code for ' + mail);
    const r = await req('POST', '/api/auth/register', null, { handle: tag + (Date.now() % 100000), displayName: tag.toUpperCase(), email: mail, password: 'pass12345', country: 'PH', acceptTerms: true, code });
    if (!r.body.ok) throw new Error('register ' + tag + ': ' + JSON.stringify(r.body));
    return { token: r.body.data.token, user: r.body.data.user, email: mail };
  };
  const login = async (email) => (await req('POST', '/api/auth/login', null, { login: email, password: 'pass12345', acceptTerms: true })).body.data.token;
  const postMultipart = async (token, title, price, extra = {}) => {
    const fd = new FormData();
    fd.append('title', title);
    fd.append('category', extra.category || 'system');
    fd.append('description', 'The complete ' + title + ' system for Roblox, uploaded with a real file.');
    fd.append('price', String(price));
    fd.append('imageUrl', 'https://files.catbox.moe/cover.png');
    fd.append('backupUrl', 'https://www.mediafire.com/' + title.replace(/\W+/g, '') + '/file');
    fd.append('fileName', title.replace(/\W+/g, '') + '.rbxm');
    fd.append('file', new Blob([Buffer.from(FILE_BYTES, 'latin1')]), title.replace(/\W+/g, '') + '.rbxm');
    if (price > 0) {
      fd.append('paymentMethods', JSON.stringify(extra.methods || ['gcash']));
      fd.append('sellerPaymentDetails', JSON.stringify({ gcash: { qr: 'https://files.catbox.moe/qr-big.png', account: '0917 555 0101', name: 'Kings Seller' } }));
    }
    if (extra.freeLicensed) fd.append('freeLicensed', '1');
    if (extra.deliverDuringPending) fd.append('deliverDuringPending', '1');
    const r = await fetch(B + '/api/assets', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    return await r.json();
  };

  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/api/health'); if (r.ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }

    const founder = await mkUser('king', 'julianguinto0@gmail.com');
    const seller = await mkUser('sell');
    const buyer = await mkUser('buy');
    await req('POST', '/api/admin/users/' + seller.user.id + '/role', founder.token, { role: 'licensed' });
    await req('POST', '/api/admin/users/' + seller.user.id + '/plan', founder.token, { contractTier: 3 });
    seller.token = await login(seller.email);

    /* ============ 1) SELLER REGISTERS A SYSTEM (licensed dashboard) ============ */
    section('Seller registers the system first (like the dashboard flow)');
    const reg = await req('POST', '/api/systems/register', seller.token, { name: 'Music System', password: 'Music System PassWorD', kickOnDeny: true });
    check('seller registers "Music System" with a password', reg.body.ok, reg.body);
    const sysId = reg.body.data && reg.body.data.id;

    /* ============ 2) POST WITH A REAL MULTIPART UPLOAD ============ */
    section('Post with a real file upload (manual GCash QR, no API keys)');
    const asset = await postMultipart(seller.token, 'Journey Music System', 15);
    check('the post is created (pending approval)', asset.ok, asset);
    const assetId = asset.data && asset.data.id;
    check('the file is stored on OUR server (fileUrl empty)', asset.ok && !asset.data.fileUrl, asset.data && asset.data.fileUrl);
    await req('POST', '/api/admin/approvals/' + assetId + '/approve', founder.token);

    /* ============ 3) BUYER CHECKOUT — MANUAL GCASH ============ */
    section('Buyer checks out with GCash (manual QR)');
    const co = await req('POST', '/api/checkout', buyer.token, { assetId, method: 'gcash', gameDetails: { gameName: 'Buyer Legend Game', placeId: '8812345678', gameOwner: 'Buyer Studios' } });
    check('checkout becomes a MANUAL order (no gateway keys)', co.body.ok && co.body.data.manual === true, co.body);
    const orderId = co.body.data && co.body.data.orderId;

    section('Before paying: the file must be locked');
    let dl = await fetch(B + '/api/assets/' + assetId + '/file', { headers: { Authorization: 'Bearer ' + buyer.token } });
    check('download is refused before payment verification', !dl.ok, 'status ' + dl.status);

    /* ============ 4) BUYER PAYS & SENDS PROOF ============ */
    section('Buyer pays the QR and submits the proof');
    const pf = await req('POST', '/api/orders/' + orderId + '/proof', buyer.token, { reference: 'GC-99182-XYZ', proofUrl: 'https://files.catbox.moe/my-receipt.png' });
    check('payment proof is accepted', pf.body.ok, pf.body);

    /* ============ 5) SELLER VERIFIES → LICENSE ============ */
    section('Seller verifies the proof and activates the license');
    const rev = await req('POST', '/api/dashboard/orders/' + orderId + '/review-proof', seller.token, { decision: 'approve', note: 'received, thanks' });
    check('seller verifies the payment', rev.body.ok, rev.body);
    check('the license was issued to the buyer', rev.body.ok && !!rev.body.data.licenseKey, rev.body.data && Object.keys(rev.body.data || {}));
    const mine = await req('GET', '/api/orders/mine', buyer.token);
    const row = (mine.body.data || []).find(o => o.id === orderId);
    check('buyer sees the completed order with license key', row && row.status === 'completed' && !!row.licenseKey, row && row.status);

    /* ============ 6) THE DOWNLOAD ============ */
    section('THE DOWNLOAD — bytes must come back, no backup link');
    dl = await fetch(B + '/api/assets/' + assetId + '/file', { headers: { Authorization: 'Bearer ' + buyer.token } });
    const dlOk = dl.ok, dlStatus = dl.status, dlHead = dl.headers.get('content-disposition');
    const dlBuf = dlOk ? Buffer.from(await dl.arrayBuffer()) : null;
    if (!dlOk) { try { console.log('      body:', (await dl.text()).slice(0, 140)); } catch (e) {} }
    check('download succeeds after verification', dlOk, 'status ' + dlStatus);
    if (dlOk) {
      check('the downloaded bytes are EXACTLY the uploaded file (' + dlBuf.length + ' bytes)', dlBuf.toString('latin1') === FILE_BYTES, dlBuf.length);
      check('the download keeps the original filename', (dlHead || '').includes('rbxm'), dlHead);
    }
    dl = await fetch(B + '/api/assets/' + assetId + '/file', { headers: { Authorization: 'Bearer ' + (await mkUser('rand')).token } });
    check('a stranger still cannot download', !dl.ok, 'status ' + dl.status);

    /* ============ 7) FREE claim download ============ */
    section('Free claim — instant, no approval');
    const freeOpen = await postMultipart(founder.token, 'Journey Open Source', 0);
    await fetch(B + '/api/health'); // noop
    const claim = await req('POST', '/api/checkout', buyer.token, { assetId: freeOpen.data.id, method: 'free' });
    check('free claim completes instantly', claim.body.ok && claim.body.data.free !== false, claim.body);
    dl = await fetch(B + '/api/assets/' + freeOpen.data.id + '/file', { headers: { Authorization: 'Bearer ' + buyer.token } });
    check('free claim downloads immediately', dl.ok, 'status ' + dl.status);
    if (dl.ok) check('free bytes match too', Buffer.from(await dl.arrayBuffer()).toString('latin1') === FILE_BYTES);

    /* ============ 8) FREE + LICENSED claim ============ */
    section('Free + licensed claim — seller approves the game details');
    /* The seller already used 2 of their 3 daily posts — the third free post
       comes from the founder (staff are exempt from the tier cooldown). */
    const freeLic = await postMultipart(founder.token, 'Journey Licensed Free', 0, { freeLicensed: true });
    check('the free+licensed post exists for the claim test', !!(freeLic && freeLic.data), freeLic);
    const claim2 = await req('POST', '/api/checkout', buyer.token, { assetId: freeLic.data && freeLic.data.id, method: 'free', gameDetails: { gameName: 'Buyer Legend Game', placeId: '8812345678', gameOwner: 'Buyer Studios' } });
    check('licensed free claim needs game details and is accepted', claim2.body.ok && claim2.body.data.freeLicensed === true, claim2.body);
    dl = await fetch(B + '/api/assets/' + freeLic.data.id + '/file', { headers: { Authorization: 'Bearer ' + buyer.token } });
    check('locked until the seller approves', !dl.ok, 'status ' + dl.status);
    const sOrd = await req('GET', '/api/dashboard/orders', founder.token);
    const pending = (sOrd.body.data || []).find(o => o.assetId === (freeLic.data && freeLic.data.id));
    check('the claim waits in the SELLER dashboard', !!pending, JSON.stringify(sOrd.body).slice(0, 140));
    if (!pending) { console.log('BUYER JOURNEY: FAILURES — ' + pass + ' passed, ' + (fail + 1) + ' failed'); srv.kill(); process.exit(1); }
    const app = await req('POST', '/api/dashboard/orders/' + pending.id + '/approval', founder.token, { decision: 'approved', note: 'game matches' });
    check('seller approves the game details', app.body.ok, app.body);
    dl = await fetch(B + '/api/assets/' + freeLic.data.id + '/file', { headers: { Authorization: 'Bearer ' + buyer.token } });
    check('after approval the buyer CAN download', dl.ok, 'status ' + dl.status);
    if (dl.ok) check('licensed-free bytes match too', Buffer.from(await dl.arrayBuffer()).toString('latin1') === FILE_BYTES);

    console.log('\nBUYER JOURNEY: ' + (fail ? 'FAILURES' : 'ALL PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
  } catch (e) {
    console.error('SUITE ERROR', e);
    fail++;
  } finally {
    srv.kill();
    await new Promise(r => setTimeout(r, 400));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
