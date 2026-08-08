'use strict';
/* ============================================================================
   Disk file adapter — implements the `files` interface the shared engine uses:
     put(id, {name, data, mime, size}) / get(id) / del(id)
   Files land in ./uploads/<assetId>.bin. Metadata (original name, mime, size)
   lives on the asset row in SQLite.
   ============================================================================ */
const fs = require('node:fs');
const path = require('node:path');

function createDiskFiles(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = id => path.join(dir, String(id) + '.bin');

  return {
    put(id, file) {
      const buf = file && file.data !== undefined
        ? (Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data))
        : Buffer.alloc(0);
      fs.writeFileSync(filePath(id), buf);
      return buf.length;
    },
    get(id) {
      try {
        const data = fs.readFileSync(filePath(id));
        return { data };
      } catch (e) {
        return null;
      }
    },
    del(id) {
      try { fs.unlinkSync(filePath(id)); } catch (e) { /* already gone */ }
    },
    filePath,
  };
}

module.exports = { createDiskFiles };
