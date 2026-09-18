/* Engine test: VIP role migration, Founder VIP grant, VIP Try order flow, system limits. */
'use strict';
const path = require('path');
const KP = require(path.join(__dirname, '..', 'shared', 'engine.js'));
const { createEngine } = KP;

/* ---- in-memory store/files/mail adapters (same shape as sqlite-store) ---- */
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
const files = { put: () => {}, get: () => null, del: () => {} };
const REG_CODES = {};   /* email -> latest 6-digit registration code (captured from mail) */
const mail = { deliver: rec => { const m = rec && rec.body ? String(rec.body).match(/code is: (\d{6})/) : null; if (m) REG_CODES[String(rec.to).toLowerCase()] = m[1]; } };

const engine = createEngine({ store: makeStore(), files, mail });

let pass = 0, failN = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { failN++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

(async () => {
  const reg = async (handle, email, displayName) => {
    await engine.requestRegisterCode({ email });
    const r = await engine.register({ handle, email, password: 'hunter22', displayName, country: 'PH', acceptTerms: true, code: REG_CODES[email.toLowerCase()] });
    if (!r.ok) throw new Error('register ' + handle + ' failed: ' + JSON.stringify(r));
    return r.data.user;
  };

  /* ---- seed: founder + a member who becomes VIP, plus an old-style vip user to migrate ---- */
  const founder = await reg('king', 'julianguinto0@gmail.com', 'King');
  check('founder registered', !!founder);

  const oldSeller = await reg('oldseller', 'old@x.test', 'Old Seller');
  check('old-seller registered', !!oldSeller);

  const vipUser = await reg('vipguy', 'vip@x.test', 'Vip Guy');
  check('vip candidate registered', !!vipUser);

  const shopper = await reg('shopper', 'shop@x.test', 'Shopper');

  /* ---- migration: role ladder now contains 'licensed' ---- */
  check('ROLES includes licensed between vip and admin',
    Array.isArray(KP.ROLES) && KP.ROLES.indexOf('licensed') === KP.ROLES.indexOf('vip') + 1);

  /* ---- VIP grant: founder grants vip to vipUser ---- */
  const g1 = await engine.setVipRole(founder, vipUser.id, true);
  check('founder grants VIP', g1.ok === true);
  const me1 = await engine.me(vipUser.id ? { id: vipUser.id } : null);
  /* me() may need session; instead read via profile */
  const prof = await engine.publicProfile('vipguy');
  check('role now vip', prof.ok && prof.data.user && prof.data.user.role === 'vip');

  /* VIP cannot be granted twice */
  const g2 = await engine.setVipRole(founder, vipUser.id, true);
  check('double-grant rejected', g2.ok === false);
  /* Regular admin-level accounts cannot be VIP'd */
  /* member without VIP cannot Try */
  const orderGate = await engine.createVipTrialOrder(shopper, 'whatever', 'dev', {});
  check('non-VIP Try rejected', orderGate.ok === false);

  /* ---- founder posts a system (owner posts are auto-approved) ---- */
  const p1 = await engine.createAsset(founder, {
    title: 'Kings Music System', category: 'system', description: 'The studio flagship music system for Roblox games.', price: 500,
    imageUrl: 'https://i.imgur.com/test-cover.png', backupUrl: 'https://www.mediafire.com/file/test/system.zip',
    fileName: 'sys.rbxl', fileSize: 1234, fileMime: 'application/octet-stream', paymentMethods: ['gcash'],
  });
  check('founder post ok', p1.ok === true, JSON.stringify(p1).slice(0, 160));
  const assetId = p1.ok ? p1.data.id : null;

  /* Need oldSeller licensed BEFORE posting: */
  const srole = await engine.adminSetRole(founder, oldSeller.id, 'licensed');
  check('founder sets licensed role', srole.ok === true);
  const p2 = await engine.createAsset(oldSeller, {
    title: 'Other Seller System', category: 'system', description: 'A community seller system posting for the shop.', price: 100,
    imageUrl: 'https://i.imgur.com/other-cover.png', backupUrl: 'https://www.mediafire.com/file/other/system.zip',
    fileName: 'other.rbxl', fileSize: 10, fileMime: 'application/octet-stream', paymentMethods: ['gcash'],
  });
  check('licensed seller can post', p2.ok === true, JSON.stringify(p2).slice(0, 160));

  /* ---- VIP Try flow on the studio system ---- */
  const t1 = await engine.createVipTrialOrder(vipUser, assetId, 'dev', { gameName: 'Vip Game', placeId: '123', gameOwner: 'Vip', notes: 'pls' });
  check('VIP Try order created', t1.ok === true, JSON.stringify(t1).slice(0, 160));
  /* Try order is a real order for the seller: seller sees it in sellerOrders */
  const so = await engine.sellerOrders(founder);
  const trial = so.ok && so.data ? so.data.find(o => o.assetId === assetId && o.buyer && o.buyer.handle === 'vipguy') : null;
  check('trial order visible to seller', !!trial);
  check('trial approval starts pending', trial && trial.approval === 'pending');

  /* Try only works on staff-owned systems — the other seller's asset must reject.
     Its status is pending (needs approval) so createVipTrialOrder would fail on
     status first; that still proves non-staff assets are not Try-able via status
     gate. To hit the staff-owner gate directly, approve it as founder. */
  const ap = await engine.adminApprove(founder, p2.ok ? p2.data.id : 'x');
  check('founder approves other post', ap.ok === true);
  const t2 = await engine.createVipTrialOrder(vipUser, p2.ok ? p2.data.id : 'x', 'dev', {});
  check('Try rejected on non-staff asset', t2.ok === false);

  /* ---- VIP system registration limits: 3 max, 1/day ---- */
  const s1 = await engine.registerSystem(vipUser, { name: 'Vip Sys A', password: 'secret1' });
  check('VIP registers system 1', s1.ok === true, JSON.stringify(s1).slice(0, 120));
  const s2 = await engine.registerSystem(vipUser, { name: 'Vip Sys B', password: 'secret2' });
  check('VIP 2nd registration same day blocked', s2.ok === false && s2.code === 'cooldown');

  /* ---- seller approval → completion → license ---- */
  if (trial) {
    const ap2 = await engine.setOrderApproval(founder, trial.id, 'approved', 'looks good');
    check('seller approves trial', ap2.ok === true);
    const fin = await engine.settleOrder(trial.id, 'vip-try');
    check('trial order settles (license issued)', fin.ok === true && !!fin.data.licenseKey, JSON.stringify(fin).slice(0, 160));
  }

  /* ---- VIP cannot be granted to staff ---- */
  const adminUser = await reg('staffer', 'staff@x.test', 'Staffer');
  await engine.adminSetRole(founder, adminUser.id, 'admin');
  const g3 = await engine.setVipRole(founder, adminUser.id, true);
  check('VIP refused for staff account', g3.ok === false);

  console.log('\n' + pass + ' passed, ' + failN + ' failed');
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
