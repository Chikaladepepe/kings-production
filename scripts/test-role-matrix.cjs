/* Role permission matrix: every role is exercised against the real engine and
   its gates are asserted, so no role can silently gain or lose powers.
   Roles: member (Verified) · test · vip · licensed · admin · cofounder · owner */
'use strict';
const path = require('path');
const { createEngine } = require(path.join(__dirname, '..', 'shared', 'engine.js'));

function makeStore() {
  const db = new Map();
  return {
    all: t => (db.get(t) ? [...db.get(t).values()] : []),
    get: (t, id) => (db.get(t) ? db.get(t).get(id) : undefined),
    put: (t, row) => { if (!db.has(t)) db.set(t, new Map()); db.get(t).set(row.id, row); },
    del: (t, id) => { if (db.has(t)) db.get(t).delete(id); },
    flush: () => {},
  };
}
const files = new Map();
const filesAdapter = { put: (id, f) => { files.set(id, f); }, get: id => files.get(id) || null, del: id => files.delete(id) };
const REG = {};
const mail = { deliver: rec => { const m = rec && rec.body ? String(rec.body).match(/code is: (\d{6})/) : null; if (m) REG[String(rec.to).toLowerCase()] = m[1]; } };
const engine = createEngine({ store: makeStore(), files: filesAdapter, mail });

let pass = 0, failN = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { failN++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); } };

(async () => {
  const reg = async (handle, email, displayName) => {
    await engine.requestRegisterCode({ email });
    const r = await engine.register({ handle, email, password: 'hunter22', displayName, country: 'PH', acceptTerms: true, code: REG[email.toLowerCase()] });
    if (!r.ok) throw new Error('register ' + handle + ': ' + JSON.stringify(r));
    return r.data.user;
  };
  const relogin = async email => {
    const r = await engine.login({ login: email, password: 'hunter22', acceptTerms: true });
    if (!r.ok) throw new Error('login ' + email + ': ' + JSON.stringify(r));
    return r.data.user;
  };

  /* Founder account is recognised by email — it skips every gate by identity. */
  const founder = await reg('king', 'julianguinto0@gmail.com', 'King');
  const owner = await relogin('julianguinto0@gmail.com');

  /* One account per role, promoted through the founder panel (the only path). */
  const roleNames = ['member', 'test', 'vip', 'licensed', 'admin', 'cofounder'];
  const users = {};
  for (const role of roleNames) {
    const email = role + '@matrix.test';
    await reg('u' + role, email, role.toUpperCase());
    users[role] = await relogin(email);
  }
  for (const role of ['admin', 'cofounder', 'vip', 'licensed', 'test']) {
    const r = await engine.adminSetRole(owner, users[role].id, role);
    check('founder can grant role ' + role, r.ok, JSON.stringify(r));
    users[role] = await relogin(role + '@matrix.test');
  }

  const postAs = async (u, tag) => await engine.createAsset(u, {
    title: 'Matrix ' + tag, category: 'tool', description: 'Role matrix probe asset for ' + tag + ' role.',
    price: 0, imageUrl: 'https://files.catbox.moe/x.png', backupUrl: 'https://www.mediafire.com/x',
    fileName: 'probe.rbxm', fileData: { name: 'probe.rbxm', data: Buffer.from('probe'), mime: 'application/octet-stream', size: 5 },
  });

  /* ---- who may post ---- */
  const posted = {};
  for (const role of roleNames) posted[role] = await postAs(users[role], role);
  posted.owner = await postAs(owner, 'owner');

  check('member (Verified) CANNOT post', !posted.member.ok, posted.member.error);
  check('vip CANNOT post without a contract', !posted.vip.ok, posted.vip.error);
  check('licensed CAN post', posted.licensed.ok, posted.licensed.error);
  check('admin CAN post', posted.admin.ok, posted.admin.error);
  check('co-founder CAN post', posted.cofounder.ok, posted.cofounder.error);
  check('test role CAN post (built for platform testing)', posted.test.ok, posted.test.error);
  check('founder post skips approval (goes straight to the shop)',
    posted.owner.ok && posted.owner.data && posted.owner.data.status === 'approved', JSON.stringify(posted.owner));
  check('licensed post waits for approval', posted.licensed.ok && posted.licensed.data.status === 'pending', JSON.stringify(posted.licensed.data));

  /* ---- deletion rights ---- */
  const licensedAsset = posted.licensed.data.id;
  const adminDel = await engine.deleteAsset(users.admin, licensedAsset);
  check('admin CANNOT delete a seller post', !adminDel.ok, JSON.stringify(adminDel));
  const cofounderDel = await engine.deleteAsset(users.cofounder, licensedAsset);
  check('co-founder CAN delete a seller post', cofounderDel.ok, JSON.stringify(cofounderDel));

  const ownerAsset = posted.owner.data.id;
  check('founder can delete their own post', (await engine.deleteAsset(owner, ownerAsset)).ok);

  /* ---- role changes: Co-Founder+ only (a dedicated probe account, so the
     member account keeps its role for the checks further down) ---- */
  await reg('uprobe', 'probe@matrix.test', 'PROBE');
  const probe = await relogin('probe@matrix.test');
  check('admin CANNOT change roles', !(await engine.adminSetRole(users.admin, probe.id, 'licensed')).ok);
  check('co-founder CAN change roles', (await engine.adminSetRole(users.cofounder, probe.id, 'test')).ok);

  /* ---- system registration ---- */
  const sysAs = async role => await engine.registerSystem(users[role], { name: 'Sys' + role, password: 'pw123456' });
  check('member (Verified) CANNOT register a system', !(await sysAs('member')).ok, (await sysAs('member')).error);
  check('licensed WITHOUT a plan CANNOT register (needs Subscription/Contract)', !(await sysAs('licensed')).ok, (await sysAs('licensed')).error);
  check('admin WITHOUT a plan CANNOT register', !(await sysAs('admin')).ok, (await sysAs('admin')).error);
  check('vip CAN register a system (entry tier included)', (await sysAs('vip')).ok, (await sysAs('vip')).error);
  check('founder CAN register a system', (await engine.registerSystem(owner, { name: 'FounderSys', password: 'pw123456' })).ok);
  /* The founder grants a plan → the licensed seller's protection unlocks. */
  const granted = await engine.adminSetUserPlan(owner, users.licensed.id, { protectionTier: 1 });
  check('founder CAN grant a plan from the Founder Panel', granted.ok, JSON.stringify(granted));
  users.licensed = await relogin('licensed@matrix.test');
  check('licensed WITH a plan CAN register a system', (await engine.registerSystem(users.licensed, { name: 'LicensedSys', password: 'pw123456' })).ok);

  /* ---- admin panel visibility ---- */
  const listAs = async role => await engine.adminUsers(users[role]);
  check('member CANNOT open the user list', !(await listAs('member')).ok);
  check('vip CANNOT open the user list', !(await listAs('vip')).ok);
  check('licensed CANNOT open the user list', !(await listAs('licensed')).ok);
  check('admin CAN open the user list', (await listAs('admin')).ok);
  check('co-founder CAN open the user list', (await listAs('cofounder')).ok);

  /* ---- creators / portfolio ---- */
  const creatorAs = async role => await engine.createCreator(users[role], { name: 'C' + role, role: 'Creator', bio: 'Probe creator bio for the role matrix.', handle: 'c' + role });
  check('member CANNOT add a creator', !(await creatorAs('member')).ok);
  check('licensed CANNOT add a creator', !(await creatorAs('licensed')).ok);
  check('admin CANNOT add a creator (moderation only)', !(await creatorAs('admin')).ok);
  check('co-founder CAN add a creator', (await creatorAs('cofounder')).ok);

  /* ---- moderation ---- */
  check('admin CAN restrict a user (not delete them)', (await engine.adminSetRestriction(users.admin, users.member.id, { restricted: true, minutes: 60, reason: 'matrix probe' })).ok);

  console.log('\n' + (failN === 0 ? 'ROLE MATRIX: ALL PASS' : 'ROLE MATRIX: FAILURES') + ' — ' + pass + ' passed, ' + failN + ' failed');
  process.exit(failN === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
