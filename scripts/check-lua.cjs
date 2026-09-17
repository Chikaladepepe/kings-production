#!/usr/bin/env node
/* CI-style guard: the generated Roblox Studio code must be valid Lua.
   1. The bare license module (system/license_system.lua) — Luau-flavored.
   2. The combined script a seller pastes above their system code:
      module (return stripped, TAMPER_KEY blanked) + License.Start + gates +
      a sample of user system code between the protected markers. */
'use strict';
const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');

const root = path.join(__dirname, '..');
const lua = fs.readFileSync(path.join(root, 'system', 'license_system.lua'), 'utf8');

/* Mirror of the client's combinedScript() — keep in sync with index.html. */
function combinedScript(licenseModule, userCode) {
  const head = licenseModule
    .replace(/local TAMPER_KEY = "[^"]*"/, 'local TAMPER_KEY = ""')
    .replace(/\nreturn License\s*$/, '\n');
  const code = String(userCode || '').trim();
  return `${head}\n-- ▶ LICENSE CODE — starts first and gates everything below it.\nLicense.Start(script)\n\n-- Denied or waiting for game approval? Stop here — the module above logs the reason.\nif not License.IsLicensed() then return end\n\n-- ================== YOUR STUDIO CODE BELOW / SYSTEM CODE BELOW ==================\n\n${'-- ========== KINGS PROTECTED CODE — paste YOUR system code between these markers =========='}\n${code}\n${'-- ========== END OF KINGS PROTECTED CODE =========='}\n-- ================== END OF SYSTEM CODE ==================\n`;
}

/* luaparse is plain-Lua; the script avoids Luau-only syntax so 5.1 parsing works. */
const opts = { comments: false, scope: false };

let failed = 0;

/* 1) The module as shipped */
try {
  luaparse.parse(lua, opts);
  console.log('✓ license module parses');
} catch (e) {
  console.error('✗ license module: ' + e.message);
  failed++;
}

/* 2) The module as embedded in the combined paste (TAMPER_KEY blanked + return stripped) */
const moduleCopy = lua
  .replace(/local TAMPER_KEY = "[^"]*"/, 'local TAMPER_KEY = ""')
  .replace(/\nreturn License\s*$/, '\n');
try {
  luaparse.parse(moduleCopy, opts);
  console.log('✓ embedded module copy parses');
} catch (e) {
  console.error('✗ embedded module copy: ' + e.message);
  failed++;
}

/* 3) The full combined paste with a representative system script below it */
const sampleUser = `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local FetchMusicRF = Instance.new("RemoteFunction")
FetchMusicRF.Name = "FetchGlobalMusic"
FetchMusicRF.Parent = ReplicatedStorage
FetchMusicRF.OnServerInvoke = function(player, action)
\tif action == "FetchMore" then
\t\treturn {}
\tend
\treturn {}
end`;
const combined = combinedScript(moduleCopy, sampleUser);
try {
  luaparse.parse(combined, opts);
  console.log('✓ combined Studio paste parses');
} catch (e) {
  console.error('✗ combined Studio paste: ' + e.message);
  failed++;
  const m = String(e.message || '').match(/line (\d+)/i);
  if (m) {
    const ln = Number(m[1]);
    const lines = combined.split('\n');
    for (let i = Math.max(0, ln - 3); i < Math.min(lines.length, ln + 2); i++) {
      console.error((i + 1 === ln ? '>> ' : '   ') + (i + 1) + ': ' + lines[i]);
    }
  }
}

/* 4) The combined paste built from the SITE template placeholders (what a
   fresh registration hands out before the name/password are baked in) */
const site = combinedScript(
  moduleCopy
    .replace(/__SYSTEM_NAME__/g, 'Music System')
    .replace(/__SYSTEM_PASSWORD__/g, 'PassWorD')
    .replace(/__PROTECTED_OBJECT__/g, 'Music System'),
  sampleUser
);
try {
  luaparse.parse(site, opts);
  console.log('✓ site-placeholder combined paste parses');
} catch (e) {
  console.error('✗ site-placeholder combined paste: ' + e.message);
  failed++;
}

process.exit(failed ? 1 : 0);
