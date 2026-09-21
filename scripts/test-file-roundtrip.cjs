/* E2E: the system file now lives on OUR server (no third-party host).
   Post a raw file over HTTP, approve it, then download it back and compare
   the bytes — proving buyers get exactly what the seller uploaded. */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = 'http://localhost:3191';
const j = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-file-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3191', DATA_DIR: dir, UPLOAD_DIR: path.join(dir, 'up') },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/api/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
    const uniq = Date.now() % 1000000;
    const EMAIL = 'file' + uniq + '@e2e.com';
    let r = await fetch(B + '/api/auth/register-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) });
    let d = await j(r); const code = d.data && d.data.devCode;
    r = await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'filer' + uniq, displayName: 'Filer', email: EMAIL, password: 'pass12345', country: 'PH', acceptTerms: true, code }) });
    d = await j(r); assert(d.ok, 'register: ' + JSON.stringify(d));
    const tok = d.data.token;

    /* A file that is too big for the old 20 MB cap would have been rejected —
       use 25 MB to prove the raised limit works end to end. */
    const payload = Buffer.alloc(25 * 1024 * 1024, 0x41);
    const fd = new FormData();
    fd.append('title', 'Raw File Probe');
    fd.append('category', 'tool');
    fd.append('description', 'Raw system file round-trip probe for the role matrix.');
    fd.append('price', '0');
    fd.append('imageUrl', 'https://files.catbox.moe/cover.png');
    fd.append('backupUrl', 'https://www.mediafire.com/probe');
    fd.append('file', new Blob([payload], { type: 'application/octet-stream' }), 'BigSystem.rbxm');
    r = await fetch(B + '/api/assets', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
    d = await j(r); assert(d.ok, 'post with raw file: ' + JSON.stringify(d).slice(0, 200));
    const id = d.data.id;

    r = await fetch(B + '/api/admin/approvals/' + id + '/approve', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
    d = await j(r); assert(d.ok, 'approve: ' + JSON.stringify(d));

    /* The buyer path: the file route must stream the stored bytes back. */
    r = await fetch(B + '/api/assets/' + id + '/file', { headers: { Authorization: 'Bearer ' + tok } });
    assert(r.ok, 'download status ' + r.status);
    const got = Buffer.from(await r.arrayBuffer());
    assert(got.length === payload.length, `size mismatch: got ${got.length}, want ${payload.length}`);
    assert(got.equals(payload), 'bytes differ');
    const cd = r.headers.get('content-disposition') || '';
    assert(/BigSystem\.rbxm/.test(cd), 'download name lost: ' + cd);

    console.log('FILE ROUND-TRIP E2E: ALL PASS — 25 MB stored on our server, served back byte-for-byte as ' + cd);
  } finally { srv.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
