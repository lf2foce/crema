// Creama's own state lives in Postgres (DATABASE_URL). This file owns the pool and the migrations;
// the registry is the only module that queries it.
import pg from "pg";

import { MIGRATIONS } from "./migrations";

export { MIGRATIONS };

export type Db = { pool: pg.Pool; ready: Promise<void>; migrated: string };
const dbs: Map<string, Db> = ((globalThis as any).__creamaDbs ??= new Map());

/**
 * One pool per (url, schema), migrated once. `schema` isolates tests: every connection gets
 * that search_path, so the same SQL runs against a throwaway namespace.
 */
/**
 * Applying migrations on first use is for development and tests. In production they run as a deploy
 * step (`pnpm db:migrate`), so several instances never race and a failing migration stops the
 * deploy, not a user's request; the app then refuses to serve against an outdated schema.
 */
export const autoMigrate = () => process.env.NODE_ENV !== "production" || process.env.CREAMA_AUTO_MIGRATE === "1";

export function database(url = process.env.DATABASE_URL, schema?: string): Db {
  if (!url) throw new Error("DATABASE_URL is not set. Creama keeps its state in Postgres: point DATABASE_URL at a database it can write to.");
  const id = `${url}#${schema ?? ""}`;
  const wanted = MIGRATIONS.map((m) => m.id).join(",");
  let d = dbs.get(id);
  if (!d) {
    const pool = new pg.Pool({ connectionString: url, max: 8, idleTimeoutMillis: 30_000, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
    pool.on("error", () => {}); // a dropped idle client must not crash the server
    d = { pool, ready: migrate(pool, schema, autoMigrate()).then(() => {}), migrated: wanted };
    d.ready.catch(() => dbs.delete(id)); // let the next call retry a failed migration
    dbs.set(id, d);
  } else if (d.migrated !== wanted) {
    // the pool outlives hot reloads (it's on globalThis): apply migrations added since it was created
    const db = d;
    db.migrated = wanted;
    db.ready = db.ready.catch(() => {}).then(() => migrate(db.pool, schema, autoMigrate())).then(() => {});
    db.ready.catch(() => { db.migrated = ""; }); // retry on the next call
  }
  return d;
}

/** Apply pending migrations, or (apply = false) only check that none are pending. */
export async function migrate(pool: pg.Pool, schema?: string, apply = true): Promise<string[]> {
  const c = await pool.connect();
  try {
    if (schema) await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await c.query("SELECT pg_advisory_lock(hashtext('creama.migrations'))"); // several processes may boot at once
    await c.query("CREATE TABLE IF NOT EXISTS creama_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query<{ id: string }>("SELECT id FROM creama_migrations")).rows.map((r) => r.id));
    const pending = MIGRATIONS.filter((m) => !done.has(m.id));
    if (!apply) {
      if (pending.length) throw new Error(`The database schema is behind this version of Creama (pending: ${pending.map((m) => m.id).join(", ")}). Run \`pnpm db:migrate\` before starting.`);
      return [];
    }
    for (const m of pending) {
      await c.query("BEGIN");
      try {
        await c.query(m.sql);
        await c.query("INSERT INTO creama_migrations (id) VALUES ($1)", [m.id]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`Migration ${m.id} failed: ${(e as Error).message}`);
      }
    }
    return pending.map((m) => m.id);
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext('creama.migrations'))").catch(() => {});
    c.release();
  }
}

export async function closeDatabases() {
  await Promise.all([...dbs.values()].map((d) => d.pool.end()));
  dbs.clear();
}
