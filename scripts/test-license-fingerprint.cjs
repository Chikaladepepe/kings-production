/* Fingerprint consistency test for the license system.
   Simulates (1) the browser generator (luaCodeFor in index.html) and
   (2) the Lua runtime fingerprint() — they must agree, including under
   CRLF line endings (what Studio stores on Windows). Run: node scripts/test-license-fingerprint.cjs */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/const LICENSE_TEMPLATE = \/\* ==== KP-LICENSE-BEGIN ==== \*\/\n`([\s\S]*?)`\n\/\* ==== KP-LICENSE-END ==== \*\//);
if (!m) { console.error('LICENSE_TEMPLATE not found in index.html — run npm run build first.'); process.exit(1); }
/* The file holds the template literal's SOURCE text; evaluate it exactly like
   the browser's JS parser does (resolves \\r\\n etc.). */
const tpl = Function('return `' + m[1] + '`')();

function luaEsc(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'); }
function sha256b64(s) { return crypto.createHash('sha256').update(s).digest('base64'); }

/* Browser generator (mirror of luaCodeFor) */
async function generate(name, pass) {
  let t = tpl
    .replace(/__SYSTEM_NAME__/g, luaEsc(name))
    .replace(/__SYSTEM_PASSWORD__/g, luaEsc(pass))
    .replace(/__PROTECTED_OBJECT__/g, luaEsc(name));
  const cleaned = t.replace(/local TAMPER_KEY = "[^"]*"/, 'local TAMPER_KEY = ""');
  const key = sha256b64(cleaned).slice(0, 12);
  return t.replace(/__FINGERPRINT__/, key);
}

/* Lua runtime fingerprint() — exact mirror of the script's logic */
function luaFingerprint(source) {
  let src = source.replace(/\r\n/g, '\n');
  src = src.replace(/local TAMPER_KEY = "[^"]*"/, 'local TAMPER_KEY = ""');
  return sha256b64(src).slice(0, 12);
}

(async () => {
  const results = [];
  const script = await generate('Music System', 'secret99');

  results.push(['no leftover placeholders', !/__[A-Z_]+__/.test(script)]);
  results.push(['name filled', script.includes('SystemName = "Music System"')]);
  results.push(['pass filled', script.includes('SystemPassword = "secret99"')]);
  const baked = (script.match(/local TAMPER_KEY = "([^"]*)"/) || [])[1];
  results.push(['key present', !!baked && baked.length === 12]);
  results.push(['LF: baked == runtime', baked === luaFingerprint(script)]);
  const crlf = script.replace(/\n/g, '\r\n');
  results.push(['CRLF: baked == runtime', baked === luaFingerprint(crlf)]);
  const tampered = script.replace('error("[License] This script has been modified', '-- X');
  results.push(['tamper detected (edited script fails)', baked !== luaFingerprint(tampered)]);
  results.push(['live-game guard present', /if TAMPER_KEY ~= "" and script\.Source ~= "" and fingerprint\(\) ~= TAMPER_KEY/.test(script)]);
  results.push(['base64 key (hex bug gone)', /^[A-Za-z0-9+/]{12}$/.test(baked) && !/^[0-9a-f]{12}$/.test(baked)]);
  results.push(['safe disable helper', /function setProtectedDisabled[\s\S]*IsA\("Script"\)/.test(script)]);
  results.push(['deviceName payload', script.includes('deviceName = deviceLabel()')]);
  results.push(['request timeout', script.includes('RequestTimeout = 10')]);
  results.push(['spec copy disables check', /if TAMPER_KEY ~= "" and script\.Source ~= ""/.test(script) && tpl.includes('local TAMPER_KEY = "__FINGERPRINT__"')]);

  const fails = results.filter(([, ok]) => !ok);
  console.log(results.map(([n, ok]) => (ok ? '✓' : '✗') + ' ' + n).join('\n'));
  console.log('\nbaked key: ' + baked);
  console.log(fails.length ? '\n' + fails.length + ' FAILURES' : '\nAll fingerprint checks pass');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
