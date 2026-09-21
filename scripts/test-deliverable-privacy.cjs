/* Privacy regression: the shop API must never expose the deliverable file URL
   or the seller's payment details. Both used to ride along in the public list,
   so anyone could scrape paid systems for free and harvest GCash details.
   Rules: lists = nothing private · buyer on the asset page = payment details
   only (checkout) · owner/staff = their own file link. */
'use strict';
const path = require('path');
const { createEngine } = require(path.join(__dirname, '..', 'shared', 'engine.js'));

const db = new Map();
const store = {
  all: t => (db.get(t) ? [...db.get(t).values()] : []),
  get: (t, id) => (db.get(t) ? db.get(t).get(id) : undefined),
  put: (t, row) => { if (!db.has(t)) db.set(t, new Map()); db.get(t).set(row.id, row); },
  del: (t, id) => { if (db.has(t)) db.get(t).delete(id); },
  flush: () => {},
};
const files = { put: () => {}, get: () => null, del: () => {} };
const REG = {};
const mail = { deliver: rec => { const m = rec && rec.body ? String(rec.body).match(/code is: (\d{6})/) : null; if (m) REG[String(rec.to).toLowerCase()] = m[1]; } };
const engine = createEngine({ store, files, mail });

let pass = 0, failN = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { failN++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); } };

(async () => {
  const reg = async (h, e, d) => {
    await engine.requestRegisterCode({ email: e });
    const r = await engine.register({ handle: h, email: e, password: 'hunter22', displayName: d, country: 'PH', acceptTerms: true, code: REG[e.toLowerCase()] });
    return r.data.user;
  };
  const owner = await reg('king', 'julianguinto0@gmail.com', 'King');
  const buyer = await reg('buyer', 'buyer@privacy.test', 'BUYERX');

  const created = await engine.createAsset(owner, {
    title: 'Privacy Probe', category: 'tool', description: 'Deliverable privacy probe asset for the suite.',
    price: 25, imageUrl: 'https://x.test/a.png', backupUrl: 'https://www.mediafire.com/secret-mirror',
    fileName: 'p.rbxm', fileUrl: 'https://files.catbox.moe/SECRET-FILE.rbxm',
    paymentMethods: ['gcash'], sellerPaymentDetails: { gcash: { qr: 'https://x.test/qr.png', account: '09171234567' } },
  });
  const id = created.data.id;

  const list = await engine.listApproved(buyer.id);
  const row = list.data.find(a => a.id === id);
  const raw = JSON.stringify(row);
  check('public list hides the deliverable file URL', row.fileUrl === undefined);
  check('public list hides the backup mirror link', row.backupUrl === undefined);
  check('public list hides seller payment details', row.sellerPaymentDetails === undefined);
  check('public list carries no secret strings at all', !/SECRET-FILE|09171234567|mediafire\/secret-mirror/.test(raw), raw.slice(0, 120));
  check('public list still shows what buyers need (title, price, file name)', !!row.title && row.price === 25 && row.fileName === 'p.rbxm');

  const buyerView = await engine.getAsset(id, buyer.id);
  check('buyer on the asset page: file URL withheld', buyerView.data.fileUrl === null);
  check('buyer on the asset page: mirror link withheld until entitled', buyerView.data.backupUrl === null);
  check('buyer on the asset page: payment details available for checkout', !!buyerView.data.sellerPaymentDetails);
  check('buyer cannot download before paying', buyerView.data.canDownload === false);

  const ownerView = await engine.getAsset(id, owner.id);
  check('owner still sees their own file link', ownerView.data.fileUrl === 'https://files.catbox.moe/SECRET-FILE.rbxm');

  const anonView = await engine.getAsset(id, null);
  check('logged-out visitor gets no file link', anonView.data.fileUrl === null || anonView.data.fileUrl === undefined);

  console.log('\n' + (failN === 0 ? 'DELIVERABLE PRIVACY: ALL PASS' : 'DELIVERABLE PRIVACY: FAILURES') + ' — ' + pass + ' passed, ' + failN + ' failed');
  process.exit(failN === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
