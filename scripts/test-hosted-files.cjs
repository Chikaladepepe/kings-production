/* Engine test: hosted system files (fileUrl) — URL-only storage + gating. */
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
  };
}
const st = makeStore();
const memFiles = {};
const files = {
  async put(id, buf, mime) { memFiles[id] = { data: buf, mime }; return true; },
  async get(id) { return memFiles[id] || null; },
  async del(id) { delete memFiles[id]; return true; },
};
const engine = factory.createEngine({ store: st, files, mail: { send: () => {} }, config: { devMail: true } });

(async () => {
  let pass = 0, fail = 0;
  const t = (n, c) => { c ? pass++ : (fail++, console.log('FAIL:', n)); };
  const reg = async (h) => {
    const c = await engine.requestRegisterCode({ email: h + '@x.com' });
    return engine.register({ handle: h, displayName: h, email: h + '@x.com', password: 'pass123', country: 'PH', acceptTerms: true, code: c.data.devCode });
  };
  const owner = await reg('hostowner' + Date.now() % 100000);
  const u = st.all('users').find(x => x.handle === owner.data.user.handle);
  u.role = 'owner'; st.put('users', u); // founder-level: posts skip the approval queue

  // 1. create asset with hosted fileUrl only (no raw file)
  const a1 = await engine.createAsset(u, { title: 'Hosted System', category: 'system', description: 'A full description of at least ten characters.', price: '50', fileName: 'MusicSystem.rbxm', fileUrl: 'https://files.catbox.moe/abc123.rbxm', imageUrl: 'https://i.imgur.com/x.png', backupUrl: 'https://www.mediafire.com/abc123', paymentMethods: ['gcash'] });
  t('hosted-file post ok', a1.ok);
  const got = await engine.getAsset(a1.data.id, null);
  t('fileUrl stored', got.ok && got.data.fileUrl === 'https://files.catbox.moe/abc123.rbxm');
  t('fileName kept', got.ok && got.data.fileName === 'MusicSystem.rbxm');
  t('no bytes stored (files empty)', Object.keys(memFiles).length === 0);

  // 2. download returns the URL for gating
  const dl = await engine.download(u, a1.data.id);
  t('download exposes fileUrl', dl.ok && dl.data.fileUrl === 'https://files.catbox.moe/abc123.rbxm');

  // 3. stranger blocked
  const stranger = await reg('hoststranger' + Date.now() % 100000);
  const su = st.all('users').find(x => x.handle === stranger.data.user.handle);
  const dls = await engine.download(su, a1.data.id);
  t('stranger blocked', dls.ok === false);

  // 4. raw file still works (fallback)
  const a2 = await engine.createAsset(u, { title: 'Raw System', category: 'system', description: 'A full description of at least ten characters.', price: '30', fileName: 'raw.lua', fileData: 'data:text/plain;base64,YWJj', imageUrl: 'https://i.imgur.com/y.png', backupUrl: 'https://www.mediafire.com/raw123', paymentMethods: ['gcash'] });
  t('raw file still ok', a2.ok);
  const got2 = await engine.getAsset(a2.data.id, null);
  t('raw has no fileUrl', got2.ok && !got2.data.fileUrl);

  // 5. edit: replace hosted URL
  const upd = await engine.updateAsset(u, a1.data.id, { fileUrl: 'https://files.catbox.moe/newurl.rbxm' });
  t('edit fileUrl', upd.ok);
  const got3 = await engine.getAsset(a1.data.id, null);
  t('fileUrl updated', got3.ok && got3.data.fileUrl === 'https://files.catbox.moe/newurl.rbxm');

  console.log('PASS:' + pass + ' FAIL:' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
