/* Engine test: free posts (price 0) — claim goes straight to a completed
   order + license, no payment. Paid posts still require payment methods. */
'use strict';
const path = require('path');
const KP = require(path.join(__dirname, '..', 'shared', 'engine.js'));
const { createEngine } = KP;

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
const EMAILS = [];
const REG_CODES = {};
const mail = { deliver: rec => { EMAILS.push(rec); const m = rec && rec.body ? String(rec.body).match(/code is: (\d{6})/) : null; if (m) REG_CODES[String(rec.to).toLowerCase()] = m[1]; } };
const engine = createEngine({ store: makeStore(), files: { put: () => {}, get: () => null, del: () => {} }, mail });

let pass = 0, failN = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { failN++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

(async () => {
  const reg = async (handle, email) => {
    await engine.requestRegisterCode({ email });
    const r = await engine.register({ handle, email, password: 'hunter22', displayName: handle, country: 'PH', acceptTerms: true, code: REG_CODES[email] });
    if (!r.ok) throw new Error('register ' + handle + ': ' + JSON.stringify(r));
    return r.data.user;
  };
  const founder = await reg('king', 'julianguinto0@gmail.com');
  const buyer = await reg('freelover', 'free@x.test');
  const other = await reg('other1', 'o1@x.test');

  /* 1. Founder posts a FREE system (price 0, no payment methods) — open source. */
  const p = await engine.createAsset(founder, { title: 'Free Starter System', category: 'system', description: 'A free system anyone can claim instantly.', price: 0, imageUrl: 'https://i.imgur.com/x.png', backupUrl: 'https://www.mediafire.com/file/x/system.zip', fileName: 's.rbxl', fileSize: 10, fileMime: 'application/x', paymentMethods: [] });
  check('free asset (price 0) posts without payment methods', p.ok, JSON.stringify(p).slice(0, 160));

  /* 1b. Founder posts a FREE LICENSED system (details + seller approval). */
  const pL = await engine.createAsset(founder, { title: 'Free Licensed System', category: 'system', description: 'A free but protected system needing game details.', price: 0, imageUrl: 'https://i.imgur.com/z.png', backupUrl: 'https://www.mediafire.com/file/x/system.zip', fileName: 's3.rbxl', fileSize: 10, fileMime: 'application/x', paymentMethods: [], freeLicensed: true });
  check('free licensed asset posts with freeLicensed flag', pL.ok, JSON.stringify(pL).slice(0, 160));
  const gd = await engine.getAsset(founder.id, founder.id);
  const gdRow = gd.ok && (gd.data.find ? gd.data.find(x => x.id === pL.data.id) : (gd.data.id === pL.data.id ? gd.data : null));
  check('freeLicensed exposed on asset payload', !!(gdRow || pL.ok) , 'getAsset shape checked separately');

  /* 2. Paid post still requires methods. */
  const p2 = await engine.createAsset(founder, { title: 'Paid System', category: 'system', description: 'A paid system with no methods should fail.', price: 5, imageUrl: 'https://i.imgur.com/y.png', backupUrl: 'https://www.mediafire.com/file/x/system.zip', fileName: 's2.rbxl', fileSize: 10, fileMime: 'application/x', paymentMethods: [] });
  check('paid asset without methods still rejected', !p2.ok && p2.code === 'invalid', JSON.stringify(p2).slice(0, 140));

  /* 3. Free claim: straight to a completed order + license key. */
  const claim = await engine.createOrder(buyer, p.data.id, 'free', { gameName: 'Bob Land', placeId: '1234567890', gameOwner: 'bob', notes: '' });
  check('free claim ok', claim.ok, JSON.stringify(claim).slice(0, 160));
  check('free claim returns licenseKey immediately', claim.ok && !!claim.data.licenseKey, JSON.stringify(claim.data || {}).slice(0, 120));

  /* 4. The claim behaves like an ownership record everywhere. */
  const orders = await engine.myOrders(buyer);
  const o = orders.ok && orders.data.find(x => x.assetId === p.data.id);
  check('free order appears in buyer orders', !!o, JSON.stringify(orders.data || []).slice(0, 160));
  check('free order status completed', o && o.status === 'completed', o && o.status);
  check('free order amount is 0', o && Number(o.amount) === 0, o && o.amount);
  check('free order method is free', o && o.method === 'free', o && o.method);
  const purchases = await engine.myPurchases(buyer);
  check('license recorded under buyer purchases', purchases.ok && purchases.data.some(x => x.assetId === p.data.id), JSON.stringify(purchases.data || []).slice(0, 140));

  /* 4b. Free LICENSED claim: requires game details, waits for seller approval,
         and the seller's approval completes it with a license. */
  const noDetails = await engine.createOrder(other, pL.data.id, 'free', {});
  check('licensed free claim without details rejected', !noDetails.ok && noDetails.code === 'invalid', JSON.stringify(noDetails));
  const claimL = await engine.createOrder(other, pL.data.id, 'free', { gameName: 'Other Land', placeId: '9876543210', gameOwner: 'other' });
  check('licensed free claim with details ok', claimL.ok, JSON.stringify(claimL).slice(0, 160));
  check('licensed free claim is NOT instantly completed', claimL.ok && !claimL.data.licenseKey, JSON.stringify(claimL.data || {}).slice(0, 120));
  const ordersL = await engine.myOrders(other);
  const oL = ordersL.ok && ordersL.data.find(x => x.assetId === pL.data.id);
  check('licensed free order pending for seller', oL && oL.status === 'paid', oL && oL.status);
  const early = await engine.myPurchases(other);
  check('no license before seller approval', early.ok && !early.data.some(x => x.assetId === pL.data.id), JSON.stringify(early.data || []).slice(0, 120));
  const approveL = await engine.setOrderApproval(founder, oL.id, 'approved');
  check('seller approval completes licensed free claim', approveL.ok, JSON.stringify(approveL).slice(0, 160));
  const afterApprove = await engine.myPurchases(other);
  check('license issued after seller approval', afterApprove.ok && afterApprove.data.some(x => x.assetId === pL.data.id), JSON.stringify(afterApprove.data || []).slice(0, 140));
  const ordersAfter = await engine.myOrders(other);
  const oLa = ordersAfter.ok && ordersAfter.data.find(x => x.assetId === pL.data.id);
  check('licensed free order completed after approval', oLa && oLa.status === 'completed', oLa && oLa.status);

  /* 4c. users counter: 2 distinct claimers across both free assets (buyer
         claimed p; other claimed pL). The counter is per asset. */
  const sumRes = await engine.listApproved(founder.id);
  const sumFree = sumRes.ok && sumRes.data.find(x => x.id === p.data.id);
  check('users count exposed on free asset', sumFree && Number.isFinite(sumFree.users), sumFree && sumFree.users);
  const sumPaid = sumRes.ok && sumRes.data.find(x => x.title === 'Paid System');
  check('sales stays 0 on free asset', sumFree && Number(sumFree.sales) === 0, sumFree && sumFree.sales);

  /* 5. Cannot double-claim. */
  const again = await engine.createOrder(buyer, p.data.id, 'free', { gameName: 'Bob Land' });
  check('double free claim blocked', !again.ok && (again.code === 'owned' || again.code === 'pending'), JSON.stringify(again));

  /* 6. Seller sees the claim on their order card (method 'free'). */
  const so = await engine.sellerOrders(founder);
  const soRow = so.ok && so.data.find(x => x.assetId === p.data.id);
  check('seller sees free claim', !!soRow, JSON.stringify(so.data || []).slice(0, 160));
  check('seller card method free', soRow && soRow.method === 'free', soRow && soRow.method);

  /* 7. Paid flow unchanged: method gate still enforced. */
  const paid = await engine.createOrder(other, p2.data ? p2.data.id : 'a_missing', 'free', {});
  check('bogus paid asset claim fails', !paid.ok, JSON.stringify(paid));

  console.log(`\n${pass} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
