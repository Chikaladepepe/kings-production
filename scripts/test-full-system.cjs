/* FULL SYSTEM SWEEP — every role, every feature, end to end over real HTTP.
   Sections: portfolio · creators · shop posting + categorisation · free claim ·
   free licensed claim · paid manual (GCash) · automatic method with no gateway ·
   downloads · support tickets · founder panel · public site data. */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = 'http://localhost:3199';
const j = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

let pass = 0, failN = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { failN++; console.log('  ✗ ' + n + (x ? ' :: ' + String(x).slice(0, 170) : '')); } };
const section = t => console.log('\n— ' + t + ' —');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-full-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3199', DATA_DIR: dir, UPLOAD_DIR: path.join(dir, 'up') },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/api/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }

    const req = async (method, p, token, body, form) => {
      const headers = {};
      if (token) headers.Authorization = 'Bearer ' + token;
      if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
      const r = await fetch(B + p, { method, headers, body: form ? form : (body === undefined ? undefined : JSON.stringify(body)) });
      return { status: r.status, body: await j(r) };
    };

    const mkUser = async (tag, email) => {
      const mail = email || (tag + (Date.now() % 1000000) + '@full.test');
      const c = await req('POST', '/api/auth/register-code', null, { email: mail });
      const code = c.body && c.body.data && c.body.data.devCode;
      assert(code, 'no code for ' + mail + ': ' + JSON.stringify(c.body));
      const r = await req('POST', '/api/auth/register', null, { handle: tag + (Date.now() % 100000), displayName: tag.toUpperCase(), email: mail, password: 'pass12345', country: 'PH', acceptTerms: true, code });
      assert(r.body.ok, 'register ' + tag + ': ' + JSON.stringify(r.body));
      return { token: r.body.data.token, user: r.body.data.user, email: mail };
    };

    const founder = await mkUser('king', 'julianguinto0@gmail.com');
    const admin = await mkUser('adm');
    const member = await mkUser('mem');
    const vip = await mkUser('vipu');
    const lic = await mkUser('licu');
    await req('POST', '/api/admin/users/' + admin.user.id + '/role', founder.token, { role: 'admin' });
    await req('POST', '/api/admin/users/' + vip.user.id + '/role', founder.token, { role: 'vip' });
    await req('POST', '/api/admin/users/' + lic.user.id + '/role', founder.token, { role: 'licensed' });
    const relogin = async (email) => { const r = await req('POST', '/api/auth/login', null, { login: email, password: 'pass12345', acceptTerms: true }); return r.body.data && r.body.data.token; };
    admin.token = await relogin(admin.email);
    vip.token = await relogin(vip.email);
    lic.token = await relogin(lic.email);

    /* ============================ PORTFOLIO ============================ */
    section('Portfolio');
    const pf = await req('POST', '/api/site/portfolio', founder.token, {
      title: 'Kings Portfolio Piece', category: 'Documentary', desc: 'A full portfolio documentary about a system we built and shipped.',
      stat: 'Shipped · 12k users', status: 'Live', imageUrl: 'https://files.catbox.moe/a.png',
      images: ['https://files.catbox.moe/b.png', 'https://files.catbox.moe/c.png'],
      links: [{ label: 'Watch', url: 'https://youtube.com/watch?v=x' }], featured: true,
    });
    check('founder can post a portfolio piece with full details', pf.body.ok, pf.body);
    const pfId = pf.body.data && pf.body.data.id;
    let content = await req('GET', '/api/site/content', null);
    let pfRow = (content.body.data && content.body.data.portfolio || []).find(x => x.id === pfId);
    check('portfolio accepts additional images', !!pfRow && (pfRow.images || []).length === 2, JSON.stringify(pfRow));

    const pfByMember = await req('POST', '/api/site/portfolio', member.token, { title: 'Nope', category: 'X', desc: 'A member must never be able to publish portfolio content.' });
    check('member CANNOT post portfolio content', !pfByMember.body.ok, pfByMember.body);
    const pfByAdmin = await req('POST', '/api/site/portfolio', admin.token, { title: 'Admin try', category: 'X', desc: 'Admins moderate — they do not publish showcase content.' });
    check('admin CANNOT post portfolio content', !pfByAdmin.body.ok, pfByAdmin.body);

    check('portfolio list is public for browsing', !!pfRow, JSON.stringify(content.body).slice(0, 150));
    check('portfolio detail carries description + extra images', !!pfRow && !!pfRow.desc && (pfRow.images || []).length === 2);
    const pfMemberView = await req('GET', '/api/site/content', member.token);
    check('member can browse portfolio', pfMemberView.body.ok && (pfMemberView.body.data.portfolio || []).length > 0);

    /* ============================ CREATORS ============================ */
    section('Creators');
    const cr = await req('POST', '/api/site/creators', founder.token, {
      name: 'Studio Creator', role: 'Founder', bio: 'Builds the systems behind Kings Production.',
      handle: 'kingsstudio', imageUrl: 'https://files.catbox.moe/pfp.png',
      docs: [{ label: 'Portfolio', url: 'https://youtube.com/@x' }], links: [{ label: 'YouTube', url: 'https://youtube.com/@x' }],
    });
    check('founder can add a creator with full details', cr.body.ok, cr.body);
    const crId = cr.body.data && cr.body.data.id;
    const crByMember = await req('POST', '/api/site/creators', member.token, { name: 'No', role: 'X', bio: 'Members must not create creators at all.' });
    check('member CANNOT add a creator', !crByMember.body.ok, crByMember.body);
    const crByAdmin = await req('POST', '/api/site/creators', admin.token, { name: 'No', role: 'X', bio: 'Admins moderate, they do not create.' });
    check('admin CANNOT add a creator', !crByAdmin.body.ok, crByAdmin.body);
    let content2 = await req('GET', '/api/site/content', null);
    const crRow = (content2.body.data && content2.body.data.creators || []).find(x => x.id === crId);
    check('creators list is public', !!crRow, JSON.stringify(content2.body).slice(0, 150));
    check('creator profile carries the bio + pfp', !!crRow && !!crRow.bio && !!crRow.imageUrl, JSON.stringify(crRow));

    /* ====================== SHOP POSTING + CATEGORIES ====================== */
    section('Shop posting & categorisation');
    const post = async (token, title, category, price, extra = {}) => {
      const fd = new FormData();
      fd.append('title', title); fd.append('category', category);
      fd.append('description', 'A complete description of the ' + title + ' system for testing purposes.');
      fd.append('price', String(price));
      fd.append('imageUrl', 'https://files.catbox.moe/cover.png');
      fd.append('backupUrl', 'https://www.mediafire.com/' + title.replace(/\W+/g, ''));
      fd.append('fileName', title.replace(/\W+/g, '') + '.rbxm');
      fd.append('file', new Blob([Buffer.from('payload-' + title)]), title.replace(/\W+/g, '') + '.rbxm');
      if (price > 0) { fd.append('paymentMethods', JSON.stringify(extra.paymentMethods || ['gcash'])); fd.append('sellerPaymentDetails', JSON.stringify({ gcash: { qr: 'https://files.catbox.moe/qr.png' } })); }
      if (extra.freeLicensed) fd.append('freeLicensed', '1');
      const r = await fetch(B + '/api/assets', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
      return await j(r);
    };

    const ourTool = await post(founder.token, 'Our Tool Free', 'tool', 0);
    check('founder posts OUR SYSTEM (tool, free) → live immediately', ourTool.ok && ourTool.data.status === 'approved', ourTool);
    const ourPaid = await post(founder.token, 'Our System Paid', 'system', 25);
    check('founder posts a PAID our-system', ourPaid.ok, ourPaid);
    /* Licensed sellers have a daily posting cooldown — grant this test seller a
       top contract tier so the sweep can post three systems in one run. */
    await req('POST', '/api/admin/users/' + lic.user.id + '/plan', founder.token, { contractTier: 3, protectionTier: 1 });
    lic.token = await relogin(lic.email);
    const sellerAnim = await post(lic.token, 'Seller Animation', 'animation', 15);
    check('licensed seller can post (goes to approval queue)', sellerAnim.ok && sellerAnim.data.status === 'pending', sellerAnim);
    const sellerFreeLic = await post(lic.token, 'Seller Licensed Free', 'model', 0, { freeLicensed: true });
    check('licensed seller can post a free LICENSED system', sellerFreeLic.ok, sellerFreeLic);
    const sellerFreeOpen = await post(lic.token, 'Seller Open Source', 'plugin', 0);
    check('licensed seller can post a free OPEN SOURCE system', sellerFreeOpen.ok, sellerFreeOpen);

    for (const id of [sellerAnim.data.id, sellerFreeLic.data.id, sellerFreeOpen.data.id]) {
      await req('POST', '/api/admin/approvals/' + id + '/approve', admin.token);
    }

    const shop = await req('GET', '/api/assets', member.token);
    const rows = shop.body.data || [];
    check('shop lists all approved posts', rows.length >= 5, 'got ' + rows.length);
    const byTitle = t => rows.find(a => a.title === t);
    check('categorisation: tool post is category "tool"', byTitle('Our Tool Free') && byTitle('Our Tool Free').category === 'tool');
    check('categorisation: system post is category "system"', byTitle('Our System Paid') && byTitle('Our System Paid').category === 'system');
    check('categorisation: animation post is category "animation"', byTitle('Seller Animation') && byTitle('Seller Animation').category === 'animation');
    check('categorisation: model post is category "model"', byTitle('Seller Licensed Free') && byTitle('Seller Licensed Free').category === 'model');
    check('categorisation: plugin post is category "plugin"', byTitle('Seller Open Source') && byTitle('Seller Open Source').category === 'plugin');
    const freeCount = rows.filter(a => Number(a.price) === 0).length;
    check('free filter has free posts to show', freeCount >= 3, 'free: ' + freeCount);
    const ourRows = rows.filter(a => a.owner && a.owner.role && ['admin', 'cofounder', 'owner'].includes(a.owner.role));
    const sellerRows = rows.filter(a => !a.owner || !['admin', 'cofounder', 'owner'].includes(a.owner.role));
    check('OUR SYSTEMS section gets staff posts', ourRows.length >= 2, ourRows.length);
    check('LICENSED SELLER section gets community posts', sellerRows.length >= 3, sellerRows.length);
    check('public shop never exposes the deliverable link', rows.every(a => a.fileUrl === undefined));

    /* ============================ FREE CLAIM ============================ */
    section('Free claim (open source) + download');
    const claimOpen = await req('POST', '/api/checkout', member.token, { assetId: sellerFreeOpen.data.id, method: 'free' });
    check('member can claim an open-source free system', claimOpen.body.ok, claimOpen.body);
    let dl = await fetch(B + '/api/assets/' + sellerFreeOpen.data.id + '/file', { headers: { Authorization: 'Bearer ' + member.token } });
    check('claimant can download the free file immediately', dl.ok, 'status ' + dl.status);
    if (dl.ok) check('free download bytes match', (await dl.text()) === 'payload-Seller Open Source');

    section('Free LICENSED claim (needs seller approval)');
    const claimLic = await req('POST', '/api/checkout', member.token, { assetId: sellerFreeLic.data.id, method: 'free', gameDetails: { gameName: 'My Game', placeId: '555', gameOwner: 'Me' } });
    check('claim on a licensed free system is accepted', claimLic.body.ok, claimLic.body);
    dl = await fetch(B + '/api/assets/' + sellerFreeLic.data.id + '/file', { headers: { Authorization: 'Bearer ' + member.token } });
    check('file is NOT downloadable before the seller approves', !dl.ok, 'status ' + dl.status);
    const licOrders = await req('GET', '/api/dashboard/orders', lic.token);
    const pendingClaim = (licOrders.body.data || []).find(o => o.assetId === sellerFreeLic.data.id);
    check('claim lands in the seller dashboard', !!pendingClaim, JSON.stringify(licOrders.body).slice(0, 150));
    if (pendingClaim) {
      await req('POST', '/api/dashboard/orders/' + pendingClaim.id + '/approval', lic.token, { decision: 'approved', note: 'game matches' });
      dl = await fetch(B + '/api/assets/' + sellerFreeLic.data.id + '/file', { headers: { Authorization: 'Bearer ' + member.token } });
      check('after seller approval the buyer can download', dl.ok, 'status ' + dl.status);
    }

    /* ====================== PAID: MANUAL (GCash QR) ====================== */
    section('Paid purchase · manual GCash (QR + proof + seller check)');
    await req('POST', '/api/admin/payment-config', founder.token, { gcashQrUrl: 'https://files.catbox.moe/qr.png', gcashDetails: 'Kings · 0917 000 0000', gcashInstructions: 'Scan and send the exact amount.' });
    const payMethods = await req('GET', '/api/payment/methods', null);
    check('payment methods endpoint reports gateway availability', payMethods.body.ok && typeof payMethods.body.data.dev === 'boolean', payMethods.body);

    const buyer = await mkUser('buyr');
    const co = await req('POST', '/api/checkout', buyer.token, { assetId: ourPaid.data.id, method: 'gcash', gameDetails: { gameName: 'Buyer Game', placeId: '777', gameOwner: 'Buyer' } });
    check('GCash checkout without a gateway becomes a MANUAL order (no free delivery)', co.body.ok && co.body.data.manual === true, co.body);
    const orderId = co.body.data && co.body.data.orderId;
    dl = await fetch(B + '/api/assets/' + ourPaid.data.id + '/file', { headers: { Authorization: 'Bearer ' + buyer.token } });
    check('file is locked until the payment is verified', !dl.ok, 'status ' + dl.status);
    const pfSubmit = await req('POST', '/api/orders/' + orderId + '/proof', buyer.token, { reference: 'GCASH-REF-777', proofUrl: 'https://files.catbox.moe/proof.png' });
    check('buyer can send the payment proof', pfSubmit.body.ok, pfSubmit.body);
    const mine = await req('GET', '/api/orders/mine', buyer.token);
    const ord = (mine.body.data || []).find(o => o.id === orderId);
    check('order shows the buyer-entered game details', ord && ord.gameDetails && /Buyer Game/.test(JSON.stringify(ord.gameDetails)), JSON.stringify(ord && ord.gameDetails));
    const verify = await req('POST', '/api/dashboard/orders/' + orderId + '/review-proof', founder.token, { decision: 'approve', note: 'received' });
    check('seller/founder can verify the payment', verify.body.ok, verify.body);
    dl = await fetch(B + '/api/assets/' + ourPaid.data.id + '/file', { headers: { Authorization: 'Bearer ' + buyer.token } });
    check('after verification the buyer can download the paid system', dl.ok, 'status ' + dl.status);
    if (dl.ok) check('paid download bytes match', (await dl.text()) === 'payload-Our System Paid');
    const stranger = await mkUser('rand');
    dl = await fetch(B + '/api/assets/' + ourPaid.data.id + '/file', { headers: { Authorization: 'Bearer ' + stranger.token } });
    check('a non-buyer still cannot download', !dl.ok, 'status ' + dl.status);

    /* ============== AUTOMATIC METHOD WITH NO GATEWAY ============== */
    section('Automatic gateway with no API keys configured');
    const autoTry = await req('POST', '/api/checkout', buyer.token, { assetId: sellerAnim.data.id, method: 'stripe', gameDetails: { gameName: 'G', placeId: '1', gameOwner: 'O' } });
    check('stripe checkout without a Stripe key does NOT hand over the file', autoTry.status !== 200 || (autoTry.body.data && !autoTry.body.data.licenseKey), JSON.stringify(autoTry.body).slice(0, 170));
    const autoOrder = await req('GET', '/api/orders/mine', buyer.token);
    const autoRow = (autoOrder.body.data || []).find(o => o.assetId === sellerAnim.data.id);
    check('unconfigured automatic method becomes a manual order instead', !!autoRow && autoRow.status !== 'completed', JSON.stringify(autoRow && autoRow.status));

    /* ============================ SUPPORT ============================ */
    section('Support tickets');
    const t1 = await req('POST', '/api/tickets/new', member.token, { subject: 'Cannot download my file', category: 'Billing', details: 'I paid but the download fails every time I try it.' });
    check('member can open a support ticket', t1.body.ok, t1.body);
    const tId = t1.body.data && t1.body.data.id;
    const msg = await req('POST', '/api/tickets/' + tId + '/messages', member.token, { body: 'Adding detail: the file is a .rbxm.' });
    check('member can add a message', msg.body.ok, msg.body);
    const adminTickets = await req('GET', '/api/admin/tickets', admin.token);
    check('admin sees the ticket in the support queue', adminTickets.body.ok, adminTickets.body);
    const adminReply = await req('POST', '/api/tickets/' + tId + '/messages', admin.token, { body: 'Thanks — re-uploading the file now.' });
    check('admin can reply on the ticket', adminReply.body.ok, adminReply.body);
    const close = await req('POST', '/api/admin/tickets/' + tId + '/close', admin.token, {});
    check('admin can close the ticket', close.body.ok, JSON.stringify(close.body));
    const afterClose = await req('GET', '/api/tickets/' + tId, member.token);
    const kept = JSON.stringify(afterClose.body);
    check('closed conversation is retained as a backup log', afterClose.body.ok && /re-uploading the file/.test(kept), kept.slice(0, 160));

    /* ========================= FOUNDER PANEL ========================= */
    section('Founder panel');
    const panel = ['/api/admin/overview', '/api/admin/users', '/api/admin/assets', '/api/admin/orders', '/api/admin/reports', '/api/admin/tickets', '/api/admin/emails', '/api/admin/emails/inbound', '/api/admin/emails/blasts', '/api/admin/systems', '/api/admin/sub-revokes', '/api/admin/sessions', '/api/admin/site-status'];
    for (const p of panel) {
      const r = await req('GET', p, founder.token);
      check('founder can open ' + p, r.body.ok === true, JSON.stringify(r.body).slice(0, 120));
    }
    const memberPanel = await req('GET', '/api/admin/overview', member.token);
    check('member is denied the founder panel', !memberPanel.body.ok && memberPanel.status === 403, memberPanel.status + ' ' + JSON.stringify(memberPanel.body).slice(0, 80));
    const adminRole = await req('POST', '/api/admin/users/' + member.user.id + '/role', admin.token, { role: 'owner' });
    check('admin cannot escalate roles', !adminRole.body.ok, adminRole.body);

    /* ====================== PUBLIC SITE + EMAIL ====================== */
    section('Public site data & email');
    for (const p of ['/api/site/content', '/api/faqs', '/api/announcements', '/api/legal/terms', '/api/legal/privacy', '/api/build', '/api/rates']) {
      const r = await req('GET', p, null);
      check('public endpoint responds: ' + p, r.status === 200 && r.body && r.body.ok === true, r.status + ' ' + JSON.stringify(r.body).slice(0, 100));
    }
    const verifyReq = await req('POST', '/api/auth/resend-verify', member.token, {});
    check('email verification is an optional resend (account already usable)', verifyReq.body.ok === true || verifyReq.body.code, verifyReq.body);
    const mailbox = await req('GET', '/api/admin/emails', founder.token);
    check('emails are captured in the founder mailbox', mailbox.body.ok, mailbox.body);

    console.log('\n' + (failN === 0 ? 'FULL SYSTEM: ALL PASS' : 'FULL SYSTEM: FAILURES') + ' — ' + pass + ' passed, ' + failN + ' failed');
  } finally { srv.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  process.exit(failN === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
