import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, DATA_DIR } from './config.js';

/**
 * One tiny interface over two drivers:
 *  - DATABASE_URL set  -> node-postgres pool (Supabase)
 *  - otherwise         -> PGlite, real Postgres compiled to WASM (tests, and local runs without Supabase)
 *
 * Everything else only uses `query`, `one`, `many` and `tx`.
 */

let driver = null;
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function connectDb({ memory = false } = {}) {
  if (config.databaseUrl && !memory) {
    const { default: pg } = await import('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl);
    const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: local ? undefined : { rejectUnauthorized: false }, max: 10 });
    const host = new URL(config.databaseUrl).hostname;
    driver = {
      kind: `postgres (${host})`,
      query: (sql, params) => pool.query(sql, params),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({ query: (s, p) => client.query(s, p), exec: (s) => client.query(s) });
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = memory ? undefined : path.join(DATA_DIR, 'pg');
    const db = dir ? new PGlite(dir) : new PGlite();
    await db.waitReady;
    driver = {
      kind: memory ? 'pglite (memory)' : `pglite (${dir})`,
      query: (sql, params) => db.query(sql, params),
      tx: (fn) => db.transaction((t) => fn({ query: (s, p) => t.query(s, p), exec: (s) => t.exec(s) })),
      close: () => db.close(),
    };
  }
  const applied = await migrate();
  console.log(`[db] ${driver.kind} ready${applied.length ? ` - applied ${applied.join(', ')}` : ''}`);
}

/**
 * Applies migrations/NNN_*.sql that have not run yet, each in its own
 * transaction, recording them in schema_migrations. Returns the names applied.
 */
async function migrate() {
  await driver.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  // Hopin's own bookkeeping table is closed to Supabase's Data API too.
  await driver.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
  const done = new Set((await driver.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await driver.tx(async ({ exec, query: q }) => {
      await exec(sql);
      await q('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

export async function disconnectDb() {
  await driver?.close();
  driver = null;
}

export const query = (sql, params = []) => driver.query(sql, params);
export const many = async (sql, params) => (await query(sql, params)).rows;
export const one = async (sql, params) => (await query(sql, params)).rows[0] ?? null;
/** Runs fn({ query, exec }) in a transaction; rolls back if it throws. */
export const tx = (fn) => driver.tx(fn);

/** Postgres unique-violation, e.g. a second active ride for the same rider. */
export const isUniqueViolation = (err) => err?.code === '23505';
