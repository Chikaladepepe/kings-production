/* End-to-end buyer delivery test over real HTTP:
   A) seller uploads a real file → buyer claims it → buyer DOWNLOADS it and the
      bytes must match exactly (this is the flow that kept failing);
   B) the seller's host is dead (404) → the download must recover automatically
      from the seller's mirror link instead of telling the buyer to go find it. */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = 'http://localhost:3193';
const j = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

let pass = 0, failN = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { failN++; console.log('  ✗ ' + n + (x ? ' :: ' + x : '')); } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-buyer-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3193', DATA_DIR: dir, UPLOAD_DIR: path.join(dir, 'up') },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/api/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }

    const mkUser = async (tag) => {
      const email = tag + (Date.now() % 1000000) + '@buyer.test';
      let r = await fetch(B + '/api/auth/register-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      let d = await j(r); const code = d.data && d.data.devCode;
      r = await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: tag + (Date.now() % 100000), displayName: tag, email, password: 'pass12345', country: 'PH', acceptTerms: true, code }) });
      d = await j(r); assert(d.ok, 'register: ' + JSON.stringify(d));
      return d.data.token;
    };
    const sellerTok = await mkUser('sellr');   // first user → admin, can approve
    const buyerTok = await mkUser('buyer');

    /* ---------- CASE A: seller uploads a real file, buyer downloads it ---------- */
    const blob = Buffer.from('-- kings production e2e system --\n' + 'A'.repeat(4096) + '\n');
    const fd = new FormData();
    fd.append('title', 'E2E Buyer Download');
    fd.append('category', 'tool');
    fd.append('description', 'Buyer download end-to-end probe asset for the suite.');
    fd.append('price', '0');                       // free + open source → instant entitlement
    fd.append('imageUrl', 'https://files.catbox.moe/cover.png');
    fd.append('backupUrl', 'https://www.mediafire.com/probe-mirror');
    fd.append('file', new Blob([blob], { type: 'application/octet-stream' }), 'BuyerSystem.rbxm');
    let r = await fetch(B + '/api/assets', { method: 'POST', headers: { Authorization: 'Bearer ' + sellerTok }, body: fd });
    let d = await j(r);
    check('seller can post a real system file', d.ok, JSON.stringify(d).slice(0, 160));
    const assetA = d.data.id;
    r = await fetch(B + '/api/admin/approvals/' + assetA + '/approve', { method: 'POST', headers: { Authorization: 'Bearer ' + sellerTok } });
    d = await j(r); check('post approved', d.ok, JSON.stringify(d).slice(0, 160));

    // buyer claims the free system (this is the "Get for free" button)
    r = await fetch(B + '/api/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + buyerTok },
      body: JSON.stringify({ assetId: assetA, method: 'free' }),
    });
    d = await j(r);
    check('buyer can claim the free system', d.ok, JSON.stringify(d).slice(0, 200));

    // and now the part that kept failing: actually download it
    r = await fetch(B + '/api/assets/' + assetA + '/file', { headers: { Authorization: 'Bearer ' + buyerTok } });
    check('buyer download returns 200', r.ok, 'status ' + r.status);
    if (r.ok) {
      const got = Buffer.from(await r.arrayBuffer());
      check('downloaded bytes match exactly', got.equals(blob), 'got ' + got.length + ' want ' + blob.length);
      check('download keeps the original file name', /BuyerSystem\.rbxm/.test(r.headers.get('content-disposition') || ''));
    }

    // a stranger must still be refused
    const strangerTok = await mkUser('strangr');
    r = await fetch(B + '/api/assets/' + assetA + '/file', { headers: { Authorization: 'Bearer ' + strangerTok } });
    check('non-buyer is refused the file', !r.ok, 'status ' + r.status);

    /* ---------- CASE B: seller's host is dead → mirror must be used ---------- */
    const mirrorBody = Buffer.from('-- mirror copy of the system file --\n');
    // Host a live mirror by uploading through the same server's own storage is not
    // possible here, so use a public file that certainly exists.
    const MIRROR = 'https://files.catbox.moe/zutnrc.lua';

    const fd2 = new FormData();
    fd2.append('title', 'E2E Broken Host');
    fd2.append('category', 'tool');
    fd2.append('description', 'Probe where the primary host is dead and the mirror must serve.');
    fd2.append('price', '0');
    fd2.append('imageUrl', 'https://files.catbox.moe/cover.png');
    fd2.append('backupUrl', MIRROR);
    fd2.append('fileUrl', 'https://files.catbox.moe/definitely-missing-file-xyz.rbxm'); // 404 on purpose
    fd2.append('fileName', 'BrokenHost.rbxm');
    r = await fetch(B + '/api/assets', { method: 'POST', headers: { Authorization: 'Bearer ' + sellerTok }, body: fd2 });
    d = await j(r);
    check('hosted-only post accepted', d.ok, JSON.stringify(d).slice(0, 160));
    if (d.ok) {
      const assetB = d.data.id;
      await fetch(B + '/api/admin/approvals/' + assetB + '/approve', { method: 'POST', headers: { Authorization: 'Bearer ' + sellerTok } });
      r = await fetch(B + '/api/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + buyerTok },
        body: JSON.stringify({ assetId: assetB, method: 'free' }),
      });
      d = await j(r);
      check('buyer can claim the hosted system', d.ok, JSON.stringify(d).slice(0, 160));

      r = await fetch(B + '/api/assets/' + assetB + '/file', { headers: { Authorization: 'Bearer ' + buyerTok } });
      check('download recovers via the mirror when the host is dead', r.ok, 'status ' + r.status);
      if (r.ok) {
        const got = Buffer.from(await r.arrayBuffer());
        check('mirror content served intact', got.length > 0 && !/^\s*</.test(got.toString('utf8')), 'len ' + got.length);
      }
    }

    console.log('\n' + (failN === 0 ? 'BUYER DOWNLOAD E2E: ALL PASS' : 'BUYER DOWNLOAD E2E: FAILURES') + ' — ' + pass + ' passed, ' + failN + ' failed');
  } finally { srv.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  process.exit(failN === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
