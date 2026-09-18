/* Engine test: siteStatus — health, storage counts, security event log. */
'use strict';
const path = require('path');
process.chdir(path.join(__dirname, '..', 'shared'));
const factory = require(path.resolve('engine.js'));

function makeStore() {
  const d = {};
  return {
    init() {},
    all(t) { d[t] = d[t] || []; return d[t]; },
    get(t, id) { return (d[t] || []).find(x => x.id === id) || null; },
    put(t, v) { d[t] = d[t] || []; const i = d[t].findIndex(x => x.id === v.id); if (i >= 0) d[t][i] = v; else d[t].push(v); },
    del(t, id) { d[t] = (d[t] || []).filter(x => x.id !== id); },
    flush() {},
    stats() { return { dbBytes: 291000, uploadsBytes: 0, tables: 24, rows: 55, integrity: 'ok' }; },
  };
}
const st = makeStore();
const engine = factory.createEngine({ store: st, files: {}, mail: { send: () => {} }, config: { devMail: true } });

(async () => {
  let pass = 0, fail = 0;
  const t = (n, c) => { c ? pass++ : (fail++, console.log('FAIL:', n)); };
  const reg = async (h) => {
    const c = await engine.requestRegisterCode({ email: h + '@x.com' });
    return engine.register({ handle: h, displayName: h, email: h + '@x.com', password: 'pass123', country: 'PH', acceptTerms: true, code: c.data.devCode });
  };
  await reg('chikaladepepe', 'julianguinto0@gmail.com');
  const engine2 = factory.createEngine({ store: st, files: {}, mail: { send: () => {} }, config: { devMail: true } });
  const owner = st.all('users').find(x => x.handle === 'chikaladepepe');

  // member cannot read status
  const m = await reg('plain' + Date.now() % 100000);
  const mu = st.all('users').find(x => x.handle === m.data.user.handle);
  const denied = await engine2.siteStatus(mu);
  t('member blocked from status', denied.ok === false);

  // simulate attacks hitting the license gate
  for (let i = 0; i < 5; i++) await engine2.systemActivate({ systemName: 'Hax' + i, systemPassword: 'wrong', placeId: '123', deviceId: 'd' + i });
  engine2.recordSecurityEvent('rate_limited', { ip: '1.2.3.4', path: '/api/systems/activate' });
  engine2.recordSecurityEvent('auth_fail', { ip: '1.2.3.4', path: '/api/assets' });
  engine2.recordSecurityEvent('auth_fail', { ip: '5.6.7.8', path: '/api/upload-file' });
  engine2.recordSecurityEvent('fake_purchase_flag', { orderId: 'o1', detail: 'duplicate reference' });

  const st1 = await engine2.siteStatus(owner);
  t('status ok', st1.ok);
  const d = st1.data;
  t('server block', d.server && d.server.memory && d.server.node === process.version);
  t('db stats present', d.db && d.db.bytes === 291000 && d.db.integrity === 'ok');
  t('counts present', d.db.counts.users >= 2);
  t('license probes counted', d.security.failedLicenseChecks24h === 5);
  t('rate-limit counted', d.security.rateLimited24h === 1);
  t('auth fails counted', d.security.authFails24h === 2);
  t('fake purchase flagged', d.security.fakePurchaseFlags === 1);
  t('events listed newest first', d.security.events.length >= 9 && d.security.events[0].type);
  t('safeguards listed', Array.isArray(d.security.safeguards) && d.security.safeguards.length >= 8);
  t('image host reported', d.imageHost && d.imageHost.provider === 'catbox');

  // a successful activation is NOT an attack
  const sys = await engine2.registerSystem(owner, { name: 'Real System', password: 'GoodPass1' });
  t('register system ok', sys.ok);
  await engine2.systemActivate({ systemName: 'Real System', systemPassword: 'GoodPass1', placeId: '555', deviceId: 'ok1' });
  const st2 = await engine2.siteStatus(owner);
  t('legit activations not flagged', st2.data.security.failedLicenseChecks24h === 5);

  console.log('PASS:' + pass + ' FAIL:' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
