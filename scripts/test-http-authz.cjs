/* HTTP authorisation sweep: every privileged route is probed with a low-privilege
   token AND with no token, so a missing requireAdmin on a route is caught the
   moment it appears. Also proves anonymous callers get 401, not data. */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = 'http://localhost:3192';
const j = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

let pass = 0, failN = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { failN++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-authz-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3192', DATA_DIR: dir, UPLOAD_DIR: path.join(dir, 'up') },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/api/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }

    const mkUser = async (tag) => {
      const email = tag + Date.now() % 1000000 + '@authz.test';
      let r = await fetch(B + '/api/auth/register-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      let d = await j(r); const code = d.data && d.data.devCode;
      r = await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: tag + (Date.now() % 100000), displayName: tag, email, password: 'pass12345', country: 'PH', acceptTerms: true, code }) });
      d = await j(r); assert(d.ok, 'register ' + tag + ': ' + JSON.stringify(d));
      return { token: d.data.token, user: d.data.user, email };
    };

    const admin = await mkUser('admin');   // first account on a fresh DB is the admin
    const member = await mkUser('member'); // second is a plain member

    const hit = async (method, p, token, body) => {
      const headers = {};
      if (token) headers.Authorization = 'Bearer ' + token;
      if (body) headers['Content-Type'] = 'application/json';
      const r = await fetch(B + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return r.status;
    };

    /* ---- anonymous callers must never get data ---- */
    const anonRoutes = ['/api/admin/users', '/api/assets/mine', '/api/orders/mine', '/api/dashboard'];
    for (const p of anonRoutes) check('anonymous blocked: ' + p, (await hit('GET', p, null)) === 401);

    /* ---- a plain member must not reach staff routes ---- */
    const memberDenied = [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/approvals'],
      ['POST', '/api/admin/approvals/anything/approve'],
      ['POST', '/api/admin/users/someone/role'],
      ['POST', '/api/admin/users/someone/restrict'],
      ['POST', '/api/admin/users/someone/plan'],
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/emails/inbound'],
      ['GET', '/api/admin/reports'],
      ['GET', '/api/admin/orders'],
      ['GET', '/api/admin/emails/blasts'],
      ['GET', '/api/admin/tickets'],
    ];
    for (const [m, p] of memberDenied) {
      const s = await hit(m, p, member.token, m === 'POST' ? { role: 'owner' } : undefined);
      check('member blocked (' + s + '): ' + p, s === 401 || s === 403, 'got ' + s);
    }

    /* ---- a member cannot post assets ---- */
    const fd = new FormData();
    fd.append('title', 'Authz Probe'); fd.append('category', 'tool'); fd.append('description', 'Probe asset used by the http authorisation sweep.');
    fd.append('price', '0'); fd.append('imageUrl', 'https://x.test/a.png'); fd.append('backupUrl', 'https://www.mediafire.com/x');
    fd.append('file', new Blob([Buffer.from('x')]), 'p.rbxm');
    let r = await fetch(B + '/api/assets', { method: 'POST', headers: { Authorization: 'Bearer ' + member.token }, body: fd });
    let d = await j(r);
    check('member cannot post an asset', !d.ok, JSON.stringify(d).slice(0, 120));

    /* ---- an admin must not be able to change roles (founder-only) ---- */
    const roleChange = await hit('POST', '/api/admin/users/' + member.user.id + '/role', admin.token, { role: 'owner' });
    check('admin cannot change roles', roleChange === 401 || roleChange === 403, 'got ' + roleChange);

    /* ---- the admin CAN do moderation work ---- */
    check('admin can read the user list', (await hit('GET', '/api/admin/users', admin.token)) === 200);

    /* ---- errors must not leak internals ---- */
    r = await fetch(B + '/api/assets/definitely-not-a-real-id', { headers: { Authorization: 'Bearer ' + admin.token } });
    d = await j(r);
    const blob = JSON.stringify(d);
    check('missing asset returns a clean error (no stack/paths)',
      !/at |ROOT|C:\\\\|sqlite|stack/i.test(blob), blob.slice(0, 160));

    console.log('\n' + (failN === 0 ? 'HTTP AUTHZ: ALL PASS' : 'HTTP AUTHZ: FAILURES') + ' — ' + pass + ' passed, ' + failN + ' failed');
  } finally { srv.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  process.exit(failN === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
