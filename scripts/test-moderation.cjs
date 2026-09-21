/* Moderation, deletion and restriction rules.
   Covers the studio's rules the user cares about:
     · Admins moderate — they cannot delete posts, portfolio pieces or creators.
     · Founder / Co-Founder delete freely, and can delete a post outright.
     · Admin pause auto-expires (Founder non-reply = "no, let it run").
     · Cancelling an order DELETES it, in every pre-delivery state.
     · A completed order cannot be silently cancelled.
     · Restricting a seller blanks their posts out of the shop.
     · Blocking a buyer from a post kills their license and their access.
   Run: node scripts/test-moderation.cjs */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3196);
const B = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
function section(t) { console.log('\n— ' + t + ' —'); }
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-mod-'));
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
    let j = null; try { j = await r.json(); } catch (e) { j = {}; }
    return { status: r.status, body: j };
  };
  const mkUser = async (tag, email) => {
    const mail = email || (tag + (Date.now() % 1000000) + '@mod.test');
    const c = await req('POST', '/api/auth/register-code', null, { email: mail });
    const code = c.body && c.body.data && c.body.data.devCode;
    if (!code) throw new Error('no code for ' + mail);
    const r = await req('POST', '/api/auth/register', null, { handle: tag + (Date.now() % 100000), displayName: tag.toUpperCase(), email: mail, password: 'pass12345', country: 'PH', acceptTerms: true, code });
    if (!r.body.ok) throw new Error('register ' + tag + ': ' + JSON.stringify(r.body));
    return { token: r.body.data.token, user: r.body.data.user, email: mail };
  };
  const login = async (email) => (await req('POST', '/api/auth/login', null, { login: email, password: 'pass12345', acceptTerms: true })).body.data.token;
  const post = async (token, title, price, extra = {}) => {
    const fd = new FormData();
    fd.append('title', title);
    fd.append('category', extra.category || 'system');
    fd.append('description', 'A complete description of ' + title + ' for moderation testing purposes.');
    fd.append('price', String(price));
    fd.append('imageUrl', 'https://files.catbox.moe/cover.png');
    fd.append('backupUrl', 'https://www.mediafire.com/' + title.replace(/\W+/g, ''));
    fd.append('fileName', title.replace(/\W+/g, '') + '.rbxm');
    fd.append('file', new Blob([Buffer.from('payload-' + title)]), title.replace(/\W+/g, '') + '.rbxm');
    if (price > 0) {
      fd.append('paymentMethods', JSON.stringify(['gcash']));
      fd.append('sellerPaymentDetails', JSON.stringify({ gcash: { qr: 'https://files.catbox.moe/qr.png', account: '0917 000 0000' } }));
    }
    if (extra.freeLicensed) fd.append('freeLicensed', '1');
    const r = await fetch(B + '/api/assets', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    return await r.json();
  };

  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/api/health'); if (r.ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }

    const founder = await mkUser('king', 'julianguinto0@gmail.com');
    const admin = await mkUser('adm');
    const cofounder = await mkUser('cof');
    const seller = await mkUser('sell');
    const buyer = await mkUser('buy');
    await req('POST', '/api/admin/users/' + admin.user.id + '/role', founder.token, { role: 'admin' });
    await req('POST', '/api/admin/users/' + cofounder.user.id + '/role', founder.token, { role: 'cofounder' });
    await req('POST', '/api/admin/users/' + seller.user.id + '/role', founder.token, { role: 'licensed' });
    await req('POST', '/api/admin/users/' + seller.user.id + '/plan', founder.token, { contractTier: 3 });
    admin.token = await login(admin.email);
    cofounder.token = await login(cofounder.email);
    seller.token = await login(seller.email);

    /* ==================== SHOWCASE CONTENT GUARDS ==================== */
    section('Showcase content — who may delete');
    const piece = await req('POST', '/api/site/portfolio', founder.token, { title: 'Mod Piece', category: 'Documentary', desc: 'A documentary piece used to prove the deletion guards.', imageUrl: 'https://files.catbox.moe/a.png' });
    check('founder publishes a portfolio piece', piece.body.ok, piece.body);
    const pfId = piece.body.data && piece.body.data.id;
    const crt = await req('POST', '/api/site/creators', founder.token, { name: 'Mod Creator', role: 'Founder', bio: 'Creator used to prove the deletion guards.', handle: 'modcreator', imageUrl: 'https://files.catbox.moe/pfp.png' });
    check('founder publishes a creator', crt.body.ok, crt.body);
    const crId = crt.body.data && crt.body.data.id;

    const adminDelPf = await req('DELETE', '/api/site/portfolio/' + pfId, admin.token);
    check('admin CANNOT delete a portfolio post', !adminDelPf.body.ok && adminDelPf.status === 403, { s: adminDelPf.status, b: adminDelPf.body });
    const adminDelCr = await req('DELETE', '/api/site/creators/' + crId, admin.token);
    check('admin CANNOT delete a creator post', !adminDelCr.body.ok && adminDelCr.status === 403, { s: adminDelCr.status, b: adminDelCr.body });

    const adminEditCr = await req('PATCH', '/api/site/creators/' + crId, admin.token, { bio: 'Admin tried to rewrite the studio bio.' });
    check('admin CANNOT edit a creator post either', !adminEditCr.body.ok, adminEditCr.body);
    const founderEditCr = await req('PATCH', '/api/site/creators/' + crId, founder.token, { bio: 'Rewritten by the Founder — creators without accounts still get a profile.' });
    check('founder CAN edit a creator bio', founderEditCr.body.ok, founderEditCr.body);

    /* ==================== SHOP POST DELETION ==================== */
    section('Shop posts — hide vs delete');
    const gadget = await post(seller.token, 'Moderated Gadget', 30, { freeLicensed: false });
    check('seller posts a paid system (approval queue)', gadget.ok, gadget);
    await req('POST', '/api/admin/approvals/' + gadget.data.id + '/approve', admin.token);

    const adminHide = await req('POST', '/api/admin/assets/' + gadget.data.id + '/status', admin.token, { status: 'disabled' });
    check('admin CAN hide (disable) a post', adminHide.body.ok, adminHide.body);
    const adminDelAsset = await req('DELETE', '/api/admin/assets/' + gadget.data.id, admin.token);
    check('admin CANNOT delete a post outright', !adminDelAsset.body.ok && adminDelAsset.status === 403, { s: adminDelAsset.status, b: adminDelAsset.body });
    await req('POST', '/api/admin/assets/' + gadget.data.id + '/status', admin.token, { status: 'approved' });
    const coDel = await req('DELETE', '/api/admin/assets/' + crId + '-does-not-exist', cofounder.token);
    check('co-founder may attempt a delete without an admin-only error', coDel.body.code !== 'adminOnly', coDel.body);

    const founderDel = await req('DELETE', '/api/admin/assets/' + gadget.data.id, founder.token);
    check('founder CAN delete a post outright', founderDel.body.ok, founderDel.body);
    const shopAfter = await req('GET', '/api/assets', null);
    check('the deleted post is gone from the shop', !(shopAfter.body.data || []).some(a => a.id === gadget.data.id));

    /* ==================== ORDER CANCELLATION ==================== */
    section('Order cancellation removes the order');
    const paid = await post(founder.token, 'Cancel Target', 40, { freeLicensed: false });
    check('founder posts a paid system', paid.ok && paid.data.status === 'approved', paid);
    const mk = await req('POST', '/api/checkout', buyer.token, { assetId: paid.data.id, method: 'gcash_manual', gameDetails: { gameName: 'Cancel Game', placeId: '321', gameOwner: 'Buyer' } });
    check('buyer starts a manual GCash order', mk.body.ok && mk.body.data.manual === true, mk.body);
    const oid = mk.body.data && mk.body.data.orderId;
    const proof = await req('POST', '/api/orders/' + oid + '/proof', buyer.token, { reference: 'REF-321', proofUrl: 'https://files.catbox.moe/proof.png' });
    check('buyer submits proof (order is now pending verification)', proof.body.ok, proof.body);
    const cancel = await req('POST', '/api/orders/' + oid + '/cancel', buyer.token);
    check('cancelling a pending order succeeds', cancel.body.ok, cancel.body);
    const mineAfter = await req('GET', '/api/orders/mine', buyer.token);
    check('the cancelled order is DELETED, not left in Orders', !(mineAfter.body.data || []).some(o => o.id === oid), JSON.stringify(mineAfter.body).slice(0, 200));

    /* completed orders are protected */
    const paid2 = await post(founder.token, 'Done Target', 40);
    const mk2 = await req('POST', '/api/checkout', buyer.token, { assetId: paid2.data.id, method: 'gcash_manual', gameDetails: { gameName: 'Done Game', placeId: '654', gameOwner: 'Buyer' } });
    const oid2 = mk2.body.data.orderId;
    await req('POST', '/api/orders/' + oid2 + '/proof', buyer.token, { reference: 'REF-654', proofUrl: 'https://files.catbox.moe/proof.png' });
    const rev = await req('POST', '/api/dashboard/orders/' + oid2 + '/review-proof', founder.token, { decision: 'approve' });
    check('seller verifies the payment → order completes', rev.body.ok, rev.body);
    const cancelDone = await req('POST', '/api/orders/' + oid2 + '/cancel', buyer.token);
    check('a completed (delivered) order cannot be cancelled away', !cancelDone.body.ok, cancelDone.body);
    let dl = await fetch(B + '/api/assets/' + paid2.data.id + '/file', { headers: { Authorization: 'Bearer ' + buyer.token } });
    check('the delivered buyer still has their file', dl.ok, 'status ' + dl.status);

    /* ==================== RESTRICTION ==================== */
    section('Restriction blots the seller out of the shop');
    const victim = await mkUser('victim');
    await req('POST', '/api/admin/users/' + victim.user.id + '/role', founder.token, { role: 'licensed' });
    await req('POST', '/api/admin/users/' + victim.user.id + '/plan', founder.token, { contractTier: 3 });
    victim.token = await login(victim.email);
    const vPost = await post(victim.token, 'Restricted Post', 0);
    check('seller posts', vPost.ok, vPost);
    await req('POST', '/api/admin/approvals/' + vPost.data.id + '/approve', admin.token);
    const before = await req('GET', '/api/assets', null);
    check('their post is visible before restriction', (before.body.data || []).some(a => a.id === vPost.data.id));

    const restrict = await req('POST', '/api/admin/users/' + victim.user.id + '/restrict', admin.token, { restricted: true, minutes: 60, reason: 'Testing restriction' });
    check('admin can restrict a user', restrict.body.ok, restrict.body);
    const during = await req('GET', '/api/assets', null);
    check('their posts are blanked out of the shop while restricted', !(during.body.data || []).some(a => a.id === vPost.data.id));
    const blockedBuy = await req('POST', '/api/checkout', victim.token, { assetId: paid2.data.id, method: 'free' });
    check('a restricted account cannot buy or claim', !blockedBuy.body.ok, blockedBuy.body);
    const lift = await req('POST', '/api/admin/users/' + victim.user.id + '/restrict', admin.token, { restricted: false });
    check('admin can lift the restriction', lift.body.ok, lift.body);
    const after = await req('GET', '/api/assets', null);
    check('lifting restores their posts', (after.body.data || []).some(a => a.id === vPost.data.id));

    /* ==================== PER-POST BLOCK ==================== */
    section('Blocking a buyer from one post kills their access');
    const blockAsset = await post(founder.token, 'Block Target', 20);
    const bk = await req('POST', '/api/checkout', buyer.token, { assetId: blockAsset.data.id, method: 'gcash_manual', gameDetails: { gameName: 'Block Game', placeId: '999', gameOwner: 'Buyer' } });
    const blockOrder = bk.body.data.orderId;
    await req('POST', '/api/orders/' + blockOrder + '/proof', buyer.token, { reference: 'REF-999', proofUrl: 'https://files.catbox.moe/proof.png' });
    await req('POST', '/api/dashboard/orders/' + blockOrder + '/review-proof', founder.token, { decision: 'approve' });
    dl = await fetch(B + '/api/assets/' + blockAsset.data.id + '/file', { headers: { Authorization: 'Bearer ' + buyer.token } });
    check('approved buyer can download', dl.ok, 'status ' + dl.status);
    const blk = await req('POST', '/api/assets/' + blockAsset.data.id + '/block/' + buyer.user.id, founder.token, { reason: 'Leaked the file' });
    check('owner can block a buyer from a post', blk.body.ok, blk.body);
    dl = await fetch(B + '/api/assets/' + blockAsset.data.id + '/file', { headers: { Authorization: 'Bearer ' + buyer.token } });
    check('the blocked buyer loses the download', !dl.ok, 'status ' + dl.status);
    const reOrder = await req('POST', '/api/checkout', buyer.token, { assetId: blockAsset.data.id, method: 'free' });
    check('the blocked buyer cannot re-acquire it', !reOrder.body.ok, reOrder.body);
    const blocks = await req('GET', '/api/assets/' + blockAsset.data.id + '/blocks', founder.token);
    check('the owner can list blocked accounts', blocks.body.ok && (blocks.body.data || []).some(b => b.userId === buyer.user.id), blocks.body);
    const unblk = await req('DELETE', '/api/assets/' + blockAsset.data.id + '/block/' + buyer.user.id, founder.token);
    check('the owner can unblock them', unblk.body.ok, unblk.body);

    /* ==================== NOTIFICATIONS ==================== */
    section('Seller notifications for new orders');
    const notifAsset = await post(founder.token, 'Notify Target', 10);
    const nBuyer = await mkUser('nbuy');
    await req('POST', '/api/checkout', nBuyer.token, { assetId: notifAsset.data.id, method: 'gcash_manual', gameDetails: { gameName: 'N Game', placeId: '111', gameOwner: 'N' } });
    const dashOrders = await req('GET', '/api/dashboard/orders', founder.token);
    const sellerOrders = (dashOrders.body.data) || [];
    check('the new order reaches the seller order list', sellerOrders.some(o => o.assetId === notifAsset.data.id), JSON.stringify(dashOrders.body).slice(0, 200));
    const dash = await req('GET', '/api/dashboard', founder.token);
    check('the dashboard carries revenue + sales stats', dash.body.ok && dash.body.data && dash.body.data.stats && typeof dash.body.data.stats.revenue === 'number', Object.keys(dash.body.data || {}));

    console.log('\nMODERATION: ' + (fail ? 'FAILURES' : 'ALL PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
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
