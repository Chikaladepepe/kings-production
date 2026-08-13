// Rebuilds index.html's engine block from shared/engine.js and the license
// template from system/license_system.lua, so the browser bundle, the Node
// backend, and the Roblox script always come from the same single sources.
//   node scripts/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const enginePath = path.join(root, 'shared', 'engine.js');
const luaPath = path.join(root, 'system', 'license_system.lua');
const htmlPath = path.join(root, 'index.html');

const engine = readFileSync(enginePath, 'utf8');
const lua = readFileSync(luaPath, 'utf8');
let html = readFileSync(htmlPath, 'utf8');

/* ---- 1) engine block ---- */
const ENG_START = '/* ==== KP-ENGINE-BEGIN ==== */';
const ENG_END = '/* ==== KP-ENGINE-END ==== */';
const es = html.indexOf(ENG_START);
const ee = html.indexOf(ENG_END);
if (es < 0 || ee < 0 || ee <= es) {
  console.error('Markers not found in index.html — cannot rebuild the engine block.');
  process.exit(1);
}
let changed = false;
const engineCurrent = html.slice(es + ENG_START.length, ee);
if (engineCurrent !== '\n' + engine + '\n') {
  html = html.slice(0, es) + ENG_START + '\n' + engine + '\n' + ENG_END + html.slice(ee + ENG_END.length);
  changed = true;
  console.log('✓ index.html engine block updated from shared/engine.js');
}

/* ---- 2) license template ---- */
// Embed the canonical Lua file as a JS template literal constant so the
// in-site "Studio code" generator always ships exactly the same script that
// lives in system/license_system.lua.
const LIC_START = '/* ==== KP-LICENSE-BEGIN ==== */';
const LIC_END = '/* ==== KP-LICENSE-END ==== */';
const ls = html.indexOf(LIC_START);
const le = html.indexOf(LIC_END);
if (ls < 0 || le < 0 || le <= ls) {
  console.error('License markers not found in index.html — cannot rebuild the license template.');
  process.exit(1);
}
const escaped = lua.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
const block = LIC_START + '\n`' + escaped + '`\n' + LIC_END;
if (html.slice(ls, le + LIC_END.length) !== block) {
  html = html.slice(0, ls) + block + html.slice(le + LIC_END.length);
  changed = true;
  console.log('✓ index.html license template updated from system/license_system.lua');
}

writeFileSync(htmlPath, html);
if (!changed) console.log('✓ index.html is already in sync — nothing to do.');
