/* End-to-end PAID purchase over real HTTP: the whole commercial loop.
   founder posts a paid system → buyer checks out with GCash → buyer submits the
   payment reference → seller verifies the payment and delivers → buyer
   DOWNLOADS the file and the bytes must match what the seller uploaded. */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = 'http://localhost:3197';
const j = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

let pass = 0, failN = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { failN++; console.log('  ✗ ' + n + (x ? ' :: ' + x : '')); } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-paid-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3197', DATA_DIR: dir, UPLOAD_DIR: path.join(dir, 'up') },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/api/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }

    const mkUser = async (tag, email) => {
      const mail = email || (tag + (Date.now() % 1000000) + '@paid.test');
      let r = await fetch(B + '/api/auth/register-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: mail }) });
      let d = await j(r); const code = d.data && d.data.devCode;
      assert(code, 'no register code for ' + mail + ': ' + JSON.stringify(d));
      r = await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: tag + (Date.now() % 100000), displayName: tag + 'X', email: mail, password: 'pass12345', country: 'PH', acceptTerms: true, code }) });
      d = await j(r); assert(d.ok, 'register: ' + JSON.stringify(d));
      return d.data.token;
    };

    /* The founder account is recognised by email → full powers. */
    const sellerTok = await mkUser('foundr', 'julianguinto0@gmail.com');
    const buyerTok = await mkUser('buyerx');

    /* 1. payment settings (GCash manual) */
    let r = await fetch(B + '/api/admin/payment-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sellerTok },
      body: JSON.stringify({ gcashQrUrl: 'https://files.catbox.moe/qr.png', gcashDetails: 'Kings Production · 0917 000 0000', gcashInstructions: 'Scan the QR and send the exact amount.' }),
    });
    let d = await j(r);
    check('founder can configure GCash payments', d.ok, JSON.stringify(d).slice(0, 160));

    /* 2. the seller posts a PAID system with a real file */
    const fileBody = Buffer.from('-- paid system payload --\n' + 'P'.repeat(2048) + '\n');
    const fd = new FormData();
    fd.append('title', 'Paid System Probe');
    fd.append('category', 'system');
    fd.append('description', 'Paid system used to verify the whole purchase and delivery loop.');
    fd.append('price', '25');
    fd.append('imageUrl', 'https://files.catbox.moe/cover.png');
    fd.append('backupUrl', 'https://www.mediafire.com/paid-mirror');
    fd.append('paymentMethods', JSON.stringify(['gcash']));
    fd.append('sellerPaymentDetails', JSON.stringify({ gcash: { qr: 'https://files.catbox.moe/qr.png', account: '0917 000 0000' } }));
    fd.append('file', new Blob([fileBody], { type: 'application/octet-stream' }), 'PaidSystem.rbxm');
    r = await fetch(B + '/api/assets', { method: 'POST', headers: { Authorization: 'Bearer ' + sellerTok }, body: fd });
    d = await j(r);
    check('seller posts a paid system', d.ok, JSON.stringify(d).slice(0, 200));
    const assetId = d.data && d.data.id;
    check('founder post goes live immediately', d.ok && d.data.status === 'approved', JSON.stringify(d.data));

    /* 3. buyer checks out */
    r = await fetch(B + '/api/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + buyerTok },
      body: JSON.stringify({ assetId, method: 'gcash', gameName: 'Buyer Game', gamePlaceId: '12345', gameOwner: 'Buyer', note: 'please activate' }),
    });
    d = await j(r);
    check('buyer can start a GCash checkout', d.ok, JSON.stringify(d).slice(0, 200));
    const orderId = d.data && (d.data.orderId || d.data.id);
    check('checkout returns an order id', !!orderId, JSON.stringify(d.data));

    r = await fetch(B + '/api/orders/mine', { headers: { Authorization: 'Bearer ' + buyerTok } });
    d = await j(r);
    check('order appears in the buyer\'s orders', d.ok && (d.data || []).some(o => o.id === orderId), JSON.stringify(d).slice(0, 160));

    /* 4. buyer submits the payment proof */
    r = await fetch(B + '/api/orders/' + orderId + '/proof', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + buyerTok },
      body: JSON.stringify({ reference: 'GCASH-REF-123456', proofUrl: 'https://files.catbox.moe/proof.png' }),
    });
    d = await j(r);
    check('buyer can submit payment proof', d.ok, JSON.stringify(d).slice(0, 200));

    /* 5. seller verifies the payment and delivers */
    r = await fetch(B + '/api/dashboard/orders/' + orderId + '/review-proof', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sellerTok },
      body: JSON.stringify({ decision: 'approve', note: 'payment received' }),
    });
    d = await j(r);
    check('seller can verify the payment', d.ok, JSON.stringify(d).slice(0, 200));

    /* some flows need the seller approval step as well — send it if so */
    const st = await (await fetch(B + '/api/orders/mine', { headers: { Authorization: 'Bearer ' + buyerTok } })).json();
    const order = (st.data || []).find(o => o.id === orderId) || {};
    if (order.status !== 'completed') {
      r = await fetch(B + '/api/dashboard/orders/' + orderId + '/approval', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sellerTok },
        body: JSON.stringify({ decision: 'approve', note: 'details verified' }),
      });
      d = await j(r);
      console.log('    (extra approval step: ' + JSON.stringify(d).slice(0, 120) + ')');
    }

    /* 6. THE PAYOFF: the buyer downloads the file */
    r = await fetch(B + '/api/assets/' + assetId + '/file', { headers: { Authorization: 'Bearer ' + buyerTok } });
    check('buyer can download after purchase', r.ok, 'status ' + r.status);
    if (r.ok) {
      const got = Buffer.from(await r.arrayBuffer());
      check('paid download matches the uploaded bytes', got.equals(fileBody), 'got ' + got.length + ' want ' + fileBody.length);
    }

    /* 7. someone who never bought still cannot download */
    const strangerTok = await mkUser('noluck');
    r = await fetch(B + '/api/assets/' + assetId + '/file', { headers: { Authorization: 'Bearer ' + strangerTok } });
    check('non-buyer still blocked', !r.ok, 'status ' + r.status);

    console.log('\n' + (failN === 0 ? 'PAID FLOW E2E: ALL PASS' : 'PAID FLOW E2E: FAILURES') + ' — ' + pass + ' passed, ' + failN + ' failed');
  } finally { srv.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  process.exit(failN === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
