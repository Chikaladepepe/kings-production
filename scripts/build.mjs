// Rebuilds index.html's engine block from shared/engine.js so the browser
// bundle and the Node backend always run the exact same business logic.
//   node scripts/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const enginePath = path.join(root, 'shared', 'engine.js');
const htmlPath = path.join(root, 'index.html');

const engine = readFileSync(enginePath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');

const START = '/* ==== KP-ENGINE-BEGIN ==== */';
const END = '/* ==== KP-ENGINE-END ==== */';
const s = html.indexOf(START);
const e = html.indexOf(END);
if (s < 0 || e < 0 || e <= s) {
  console.error('Markers not found in index.html — cannot rebuild the engine block.');
  process.exit(1);
}

const current = html.slice(s + START.length, e);
if (current === '\n' + engine + '\n') {
  console.log('✓ index.html engine block is already in sync with shared/engine.js — nothing to do.');
  process.exit(0);
}
const rebuilt = html.slice(0, s) + START + '\n' + engine + '\n' + END + html.slice(e + END.length);
writeFileSync(htmlPath, rebuilt);
console.log('✓ index.html engine block updated from shared/engine.js');
