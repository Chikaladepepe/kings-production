/* E2E over HTTP: posting an asset with a hosted fileUrl must succeed (regression
   for the "A system file is required" bug — the server dropped req.body.fileUrl). */
'use strict';
const assert = require('assert');
const B = process.env.BASE || 'http://localhost:3188';
const j = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

(async () => {
  const uniq = Date.now() % 1000000; // unique per run so reruns never collide
  const EMAIL = 'own' + uniq + '@e2e.com';
  // first user on a fresh DB becomes admin (can post + approve)
  let r = await fetch(B + '/api/auth/register-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) });
  let d = await j(r); const code = d.data && d.data.devCode;
  assert(code, 'register-code failed: ' + JSON.stringify(d));
  r = await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'e2eowner' + uniq, displayName: 'Owner', email: EMAIL, password: 'pass12345', country: 'PH', acceptTerms: true, code }) });
  d = await j(r); assert(d.ok, 'register failed: ' + JSON.stringify(d));
  const tok = d.data.token;

  // post WITH fileUrl (the previously broken path)
  const fd = new FormData();
  fd.append('title', 'E2E Hosted Post');
  fd.append('category', 'system');
  fd.append('description', 'Testing the hosted file path end to end.');
  fd.append('price', '25');
  fd.append('imageUrl', 'https://i.imgur.com/cover.png');
  fd.append('backupUrl', 'https://www.mediafire.com/e2e');
  fd.append('paymentMethods', JSON.stringify(['gcash']));
  fd.append('fileUrl', 'https://files.catbox.moe/e2etest.rbxm');
  fd.append('fileName', 'MusicSystem.rbxm');
  r = await fetch(B + '/api/assets', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
  d = await j(r);
  assert(d.ok, 'POST /api/assets with fileUrl failed: ' + JSON.stringify(d));
  const assetId = d.data.id;

  // admin approves their own post
  r = await fetch(B + '/api/admin/approvals/' + assetId + '/approve', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
  d = await j(r); assert(d.ok, 'approve failed: ' + JSON.stringify(d));

  // verify fileUrl persisted
  r = await fetch(B + '/api/assets/' + assetId, { headers: { Authorization: 'Bearer ' + tok } });
  d = await j(r);
  assert(d.ok && d.data.fileUrl === 'https://files.catbox.moe/e2etest.rbxm', 'fileUrl not stored: ' + JSON.stringify(d.data && d.data.fileUrl));
  assert(d.ok && d.data.fileName === 'MusicSystem.rbxm', 'fileName not stored');

  console.log('E2E hosted-file post: ALL PASS');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
