/* E2E: a free TOOL post must appear under All, Free, and Tool chips — via the real HTTP API. */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const B = 'http://localhost:3189';
const j = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

(async () => {
  // fresh DB + throwaway server
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kp-shop-'));
  const srv = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: '3189', DATA_DIR: dir, UPLOADS_DIR: path.join(dir, 'up') }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { const r = await fetch(B + '/api/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
    const uniq = Date.now() % 1000000;
    const EMAIL = 'shop' + uniq + '@e2e.com';
    let r = await fetch(B + '/api/auth/register-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) });
    let d = await j(r); const code = d.data && d.data.devCode;
    r = await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'shopper' + uniq, displayName: 'Shopper', email: EMAIL, password: 'pass12345', country: 'PH', acceptTerms: true, code }) });
    d = await j(r); assert(d.ok, 'register failed: ' + JSON.stringify(d));
    const tok = d.data.token;
    const fd = new FormData();
    fd.append('title', 'Filter Probe Tool');
    fd.append('category', 'tool');
    fd.append('description', 'Free tool post used to verify shop chip filtering end to end.');
    fd.append('price', '0');
    fd.append('imageUrl', 'https://files.catbox.moe/82bfmq.png');
    fd.append('backupUrl', 'https://www.mediafire.com/probe');
    fd.append('fileUrl', 'https://files.catbox.moe/nbbp31.rbxm');
    fd.append('fileName', 'Probe.rbxm');
    r = await fetch(B + '/api/assets', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
    d = await j(r); assert(d.ok, 'post failed: ' + JSON.stringify(d));
    r = await fetch(B + '/api/admin/approvals/' + d.data.id + '/approve', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
    d = await j(r); assert(d.ok, 'approve failed: ' + JSON.stringify(d));

    // now replicate the EXACT deployed shop split + filter on the real payload
    r = await fetch(B + '/api/assets');
    d = await j(r);
    const all = d.data || [];
    const isStaff = u => ['member','test','vip','licensed','admin','cofounder','owner'].indexOf(u && u.role) >= 4;
    const ourAssets = all.filter(a => a.owner && isStaff({ role: a.owner.role }));
    assert(ourAssets.length === 1, 'post should land in OUR section');
    const filt = cat => ourAssets.filter(a => {
      if (cat === 'free' && Number(a.price) > 0) return false;
      if (cat && cat !== 'free' && a.category !== cat) return false;
      return true;
    });
    assert(filt('').length === 1, 'All chip');
    assert(filt('free').length === 1, 'Free chip');
    assert(filt('tool').length === 1, 'Tool chip');
    assert(filt('model').length === 0, 'Model chip must exclude it');
    assert(filt('system').length === 0, 'System chip must exclude it');
    console.log('SHOP FILTER E2E: ALL PASS (All/Free/Tool show the post; others exclude it)');
  } finally { srv.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
