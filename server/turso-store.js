'use strict';
/* ============================================================================
   Turso store adapter — implements the SAME `store` interface as
   server/sqlite-store.js:
     get(table, id) / all(table) / put(table, row) / del(table, id) / flush() / close()
   so the shared engine (shared/engine.js) works unchanged.

   How it works
   ------------
   The engine calls the store SYNCHRONOUSLY (no awaits). A network database
   can't answer synchronously, so this adapter keeps a full in-memory cache of
   every table (seeded from Turso at startup) and answers every read from it.
   Writes update the cache immediately AND queue a mirrored write to Turso.

   Durability: the server awaits store.idle() before sending every API
   response (see server.js), which drains the write queue — so by the time a
   user sees "success", the row is already in Turso.

   Assumptions / limits
   --------------------
   - Single app instance (Render free tier is one instance). A second instance
     would need a shared cache; don't scale horizontally with this adapter.
   - If Turso is unreachable, writes are retried by @libsql/client and logged;
     the cache still reflects them. Persistent outages could leave the two out
     of sync (the server keeps serving from memory).
   - The whole database is loaded into memory at boot. Fine at marketplace
     scale (the engine already does application-level filtering anyway).
   ============================================================================ */
const path = require('node:path');
const fs = require('node:fs');
const { createClient } = require('@libsql/client');
const { SCHEMA, BOOLS, DDL, MIGRATIONS } = require('./sqlite-store.js');

function createTursoStore({ url, authToken }) {
  if (!url) throw new Error('TURSO_URL is required for the Turso store.');

  /* Tables loaded into memory:  table -> Map(id -> row) */
  const cache = {};
  SCHEMA && Object.keys(SCHEMA).forEach(t => { cache[t] = new Map(); });

  let queue = Promise.resolve(); // serialized write queue (preserves ordering)
  let closed = false;

  function rowToObj(table, row) {
    if (!row) return null;
    const o = Object.assign({}, row);
    (BOOLS[table] || []).forEach(c => { o[c] = !!o[c]; });
    return o;
  }
  function objToRow(table, o) {
    const row = {};
    for (const c of SCHEMA[table]) {
      if (o[c] === undefined || o[c] === null) row[c] = null;
      else row[c] = (BOOLS[table] || []).includes(c) ? (o[c] ? 1 : 0) : o[c];
    }
    return row;
  }

  function enqueue(task) {
    queue = queue.then(() => task()).catch(e => console.error('[turso] write failed:', e && e.message || e));
    return queue;
  }

  async function loadAll(client) {
    for (const t of Object.keys(SCHEMA)) {
      const rs = await client.execute({ sql: `SELECT * FROM "${t}"`, args: [] });
      cache[t] = new Map(rs.rows.map(r => [String(r.id), rowToObj(t, r)]));
    }
  }

  async function init() {
    console.log(`[turso] connecting to ${String(url).replace(/:[^:@/]*(@|$)/, '***$1')} …`);
    /* Local file: databases need their parent directory to exist. */
    if (typeof url === 'string' && url.startsWith('file:')) {
      const p = url.slice(5);
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) { /* ignore */ }
    }
    const client = createClient({ url, authToken: authToken || undefined });
    await client.executeMultiple(DDL); // same schema as the SQLite adapter
    for (const sql of MIGRATIONS) { try { await client.execute(sql); } catch (e) { /* duplicate column — already migrated */ } }
    await loadAll(client);
    console.log('[turso] connected; tables loaded: ' + Object.keys(SCHEMA).map(t => `${t}=${cache[t].size}`).join(', '));
    return client;
  }

  const clientP = init(); // kicked off immediately; awaited below

  return {
    async ready() { return clientP; },

    get(table, id) {
      if (!cache[table]) return null;
      const row = cache[table].get(String(id));
      return row ? Object.assign({}, row) : null;
    },
    all(table) {
      if (!cache[table]) return [];
      return [...cache[table].values()].map(r => Object.assign({}, r));
    },
    put(table, row) {
      if (!cache[table] || !SCHEMA[table]) return;
      const r = objToRow(table, row);
      cache[table].set(String(r.id), Object.assign({}, row));
      const cols = SCHEMA[table];
      const sql = `INSERT OR REPLACE INTO "${table}" ("${cols.join('","')}") VALUES (${cols.map(() => '?').join(',')})`;
      const args = cols.map(c => r[c]);
      enqueue(async () => {
        const c = await clientP;
        await c.execute({ sql, args });
      });
    },
    del(table, id) {
      if (!cache[table]) return;
      cache[table].delete(String(id));
      enqueue(async () => {
        const c = await clientP;
        await c.execute({ sql: `DELETE FROM "${table}" WHERE id = ?`, args: [String(id)] });
      });
    },
    flush() { /* writes are already queued; idle() drains them */ },
    async idle() {
      try { await queue; } catch (e) { /* queue never rejects (enqueue catches) */ }
    },
    async close() {
      await this.idle();
      try {
        const c = await clientP;
        if (c && c.close) c.close();
      } catch (e) { console.error('[turso] close error:', e && e.message || e); }
    },
  };
}

module.exports = { createTursoStore };
