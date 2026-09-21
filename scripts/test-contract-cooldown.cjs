/* Contract-tier posting allowance.
   The studio's rule: Contract 1 = 1 post per 24h, Contract 2 = 3, Contract 3 = 10.
   This used to be a flat one-post-per-day for everybody, so a seller paying for
   Contract 3 was throttled exactly like the cheapest tier.
   Run: node scripts/test-contract-cooldown.cjs */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3197);
const B = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
function section(t) { console.log('\n— ' + t + ' —'); }
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-cd-'));
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
    const mail = email || (tag + (Date.now() % 1000000) + '@cd.test');
    const c = await req('POST', '/api/auth/register-code', null, { email: mail });
    const code = c.body && c.body.data && c.body.data.devCode;
    if (!code) throw new Error('no code for ' + mail);
    const r = await req('POST', '/api/auth/register', null, { handle: tag + (Date.now() % 100000), displayName: tag.toUpperCase(), email: mail, password: 'pass12345', country: 'PH', acceptTerms: true, code });
    if (!r.body.ok) throw new Error('register ' + tag + ': ' + JSON.stringify(r.body));
    return { token: r.body.data.token, user: r.body.data.user, email: mail };
  };
  const login = async (email) => (await req('POST', '/api/auth/login', null, { login: email, password: 'pass12345', acceptTerms: true })).body.data.token;

  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/api/health'); if (r.ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }

    const founder = await mkUser('king', 'julianguinto0@gmail.com');
    const seller = await mkUser('sell');
    await req('POST', '/api/admin/users/' + seller.user.id + '/role', founder.token, { role: 'licensed' });
    seller.token = await login(seller.email);

    const post = (n) => req('POST', '/api/assets', seller.token, {
      title: 'Tier System ' + n, category: 'system', description: 'A registered system posted to prove the tier posting allowance.',
      price: 0, fileName: 'sys_' + n + '.txt', fileData: Buffer.from('payload-' + n).toString('base64'),
      backupUrl: 'https://example.com/mirror-' + n, imageUrl: 'https://files.catbox.moe/a.png',
    });
    const plan = (tier) => req('POST', '/api/admin/users/' + seller.user.id + '/plan', founder.token, { contractTier: tier, note: 'test grant' });

    section('Contract 1 — one post per 24h');
    let r = await plan(1);
    check('founder can grant Contract tier 1', r.body.ok, r.body);
    const a1 = await post(1);
    check('Contract 1 seller can make their first post', a1.body.ok, a1.body);
    const a2 = await post(2);
    check('Contract 1 seller is blocked on the second post', !a2.body.ok && a2.body.code === 'cooldown', a2.body);
    check('the block explains the tier limit', /Contract tier/.test(String(a2.body.error || '')), a2.body.error);

    section('Contract 2 — three posts per 24h');
    r = await plan(2);
    check('founder can upgrade to Contract tier 2', r.body.ok, r.body);
    const b2 = await post(2), b3 = await post(3);
    check('Contract 2 seller can post twice more', b2.body.ok && b3.body.ok, { b2: b2.body, b3: b3.body });
    const b4 = await post(4);
    check('Contract 2 seller is blocked on the fourth post', !b4.body.ok && b4.body.code === 'cooldown', b4.body);

    section('Contract 3 — ten posts per 24h');
    r = await plan(3);
    check('founder can upgrade to Contract tier 3', r.body.ok, r.body);
    let okCount = 0, blocked = null;
    for (let n = 4; n <= 11; n++) { const x = await post(n); if (x.body.ok) okCount++; else { blocked = x.body; break; } }
    check('Contract 3 seller reaches ten posts in the window', okCount === 7, { okCount, blocked });
    check('the eleventh post is refused on cooldown', blocked && blocked.code === 'cooldown', blocked);

    section('Downgrade cannot hand out extra posts');
    await plan(1);
    const d = await post(99);
    check('a downgraded seller stays limited to the lower tier', !d.body.ok && d.body.code === 'cooldown', d.body);

    console.log('\nCONTRACT COOLDOWN: ' + (fail ? 'FAILURES' : 'ALL PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
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
