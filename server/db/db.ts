import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// timestamps come back as Date objects; BIGINT counts as numbers
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

function fromPool(pool: pg.Pool): Db {
  return {
    async query(sql, params) {
      return (await pool.query(sql, params as any[])).rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async (s, p) => (await client.query(s, p as any[])).rows });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function fromPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite(dataDir);
  // PGlite runs one query at a time; serialize transactions so they never interleave
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  return {
    query: (sql, params) => run(async () => (await lite.query<any>(sql, params as any[])).rows),
    tx: (fn) =>
      run(() =>
        lite.transaction(async (t) => fn({ query: async (s, p) => (await t.query<any>(s, p as any[])).rows })),
      ),
    close: () => lite.close(),
  };
}

export async function createDb(opts: { url?: string; dataDir?: string; memory?: boolean } = {}): Promise<Db> {
  if (opts.url) {
    const ssl = /localhost|127\.0\.0\.1|\.railway\.internal|@dpg-[^.:/]+[:/]/.test(opts.url) ? undefined : { rejectUnauthorized: false };
    return fromPool(new pg.Pool({ connectionString: opts.url, ssl, max: 10 }));
  }
  if (opts.memory) return fromPglite();
  const dir = opts.dataDir ?? path.resolve('.data/db');
  fs.mkdirSync(dir, { recursive: true });
  return fromPglite(dir);
}

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await db.tx(async (q) => {
      for (const stmt of splitSql(sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
