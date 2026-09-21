/* Static UI integrity guard.
   The page kept breaking with runtime errors like "staffBtn is not defined",
   "isAdmin is not defined", "isMemberLevel is not defined" — an inline onclick
   (or a view/API reference) pointing at a helper that does not exist, which
   kills the whole view the moment the user clicks. This catches all of those at
   build time, with no server and no browser.
   Run: node scripts/test-ui-handlers.cjs */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let pass = 0, fail = 0;
const report = (name, bad) => {
  if (!bad.length) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + ' → ' + bad.slice(0, 12).join(', ') + (bad.length > 12 ? ' …(+' + (bad.length - 12) + ')' : '')); }
};

/* ---- 1) every inline onclick/oninput/onchange handler resolves ---- */
const handlers = new Set();
const attrRe = /\bon(?:click|input|change|submit|keydown|keyup|blur|focus)\s*=\s*"([^"]*)"/g;
let m;
while ((m = attrRe.exec(html))) {
  const body = m[1].trim();
  const call = body.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (call) handlers.add(call[1]);
}
/* Template-literal handlers inside the page script use single quotes the same
   way, so the same regex catches them (the attribute is still double-quoted). */
const defined = new Set();
const defRe = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
while ((m = defRe.exec(html))) defined.add(m[1]);
const constRe = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
while ((m = constRe.exec(html))) defined.add(m[1]);
const winRe = /window\.([A-Za-z_$][\w$]*)\s*=/g;
while ((m = winRe.exec(html))) defined.add(m[1]);
const assignRe = /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*=\s*function/g;
while ((m = assignRe.exec(html))) defined.add(m[1]);

const BUILTIN = new Set(['alert', 'confirm', 'prompt', 'print', 'open', 'close', 'focus', 'blur', 'scrollTo', 'stopPropagation', 'preventDefault', 'parseInt', 'parseFloat', 'encodeURIComponent', 'setTimeout', 'copy', 'href', 'event', 'this', 'return', 'if', 'for', 'while', 'switch', 'location', 'history', 'navigator', 'window', 'document']);
const missingHandlers = [...handlers].filter(h => !defined.has(h) && !BUILTIN.has(h));
report('every inline event handler has a real function (' + handlers.size + ' checked)', missingHandlers);

/* ---- 2) every route the router whitelists has a VIEWS implementation ----
   The router dispatches dynamically (VIEWS[path]), so the whitelist array is
   the authoritative list of pages the app exposes. A path with no view is a
   dead button ("Something went wrong" with no error at all). */
const viewsAssigned = new Set();
const viewRe = /VIEWS\.([A-Za-z_$][\w$]*)\s*=|VIEWS\[['"]([^'"]+)['"]\]\s*=/g;
while ((m = viewRe.exec(html))) viewsAssigned.add(m[1] || m[2]);
const wlMatch = html.match(/if \(!\[([^\]]+)\]\.includes\(path\)\)\s*\{\s*location\.hash/);
const whitelist = wlMatch
  ? wlMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  : [];
const missingViews = whitelist.filter(v => !viewsAssigned.has(v));
report('every whitelisted route has a view (' + whitelist.length + ' routes)', missingViews);

/* ---- 3) every API.<name> the page calls exists on the API object ---- */
const apiAssigned = new Set();
const apiAssignRe = /API\.([A-Za-z_$][\w$]*)\s*=/g;
while ((m = apiAssignRe.exec(html))) apiAssigned.add(m[1]);
const apiUsed = new Set();
const apiUseRe = /\bAPI\.([A-Za-z_$][\w$]*)\s*\(/g;
while ((m = apiUseRe.exec(html))) apiUsed.add(m[1]);
const missingApi = [...apiUsed].filter(a => !apiAssigned.has(a));
report('every API.* call has an implementation (' + apiUsed.size + ' checked)', missingApi);

/* ---- 4) no leftover "is not defined" landmines: identifiers used in view
     bodies that are declared nowhere in the file at all. We check the small
     set of scope helpers that previously broke views. ---- */
const GUARDED = ['isMemberLevel', 'isAdmin', 'isStaff', 'isOwnerAccount', 'canRate', 'staffBtn', 'isRestricted', 'isVipUser', 'dashVisible', 'effRank', 'roleRank', 'isTester'];
const undeclared = GUARDED.filter(id => {
  const used = new RegExp('\\b' + id + '\\s*[({]').test(html);
  return used && !defined.has(id);
});
report('scope helpers used by views are declared (' + GUARDED.length + ' checked)', undeclared);

console.log('\nUI INTEGRITY: ' + (fail ? 'FAILURES' : 'ALL PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
