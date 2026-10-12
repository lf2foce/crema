// Creama's own state lives in Postgres (DATABASE_URL). This file owns the pool and the migrations;
// the registry is the only module that queries it.
import pg from "pg";

// Migrations are append-only: never edit one that has shipped, add the next number instead.
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_base",
    sql: `
CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);

CREATE TABLE runs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  model text NOT NULL, hint text, focus text,
  steps jsonb NOT NULL DEFAULT '[]', summary text, entities jsonb NOT NULL DEFAULT '[]',
  sent_to_model jsonb, error text, snapshot jsonb, pid integer
);

CREATE TABLE concepts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id integer NOT NULL REFERENCES runs(id),
  key text NOT NULL, name text NOT NULL, question text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'certified', 'dismissed', 'superseded')),
  comparison jsonb, metric_key text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX concepts_open_key ON concepts (key) WHERE status = 'open';

CREATE TABLE candidates (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  concept_id integer NOT NULL REFERENCES concepts(id),
  position integer NOT NULL, spec jsonb NOT NULL, verification jsonb
);
CREATE INDEX candidates_concept ON candidates (concept_id, position);

CREATE TABLE metrics (
  key text PRIMARY KEY, name text NOT NULL,
  status text NOT NULL DEFAULT 'certified' CHECK (status IN ('certified', 'retired')),
  owner text NOT NULL, current_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE metric_versions (
  metric_key text NOT NULL REFERENCES metrics(key), version integer NOT NULL, body jsonb NOT NULL,
  certified_by text NOT NULL, certified_at timestamptz NOT NULL, PRIMARY KEY (metric_key, version)
);

CREATE TABLE events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL, action text NOT NULL, subject text NOT NULL, detail jsonb
);
CREATE INDEX events_subject ON events (subject, id DESC);

CREATE TABLE saved_queries (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL, sql text NOT NULL, created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- certified versions and the audit log can only grow
CREATE FUNCTION creama_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '%', TG_ARGV[0]; END $$;
CREATE TRIGGER metric_versions_immutable BEFORE UPDATE OR DELETE ON metric_versions
  FOR EACH ROW EXECUTE FUNCTION creama_refuse_change('certified versions are immutable');
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION creama_refuse_change('audit log is append-only');
`,
  },
  {
    id: "002_hosted_databases",
    sql: `
-- databases Creama created for apps elsewhere (core/hosting.ts); passwords are never stored
CREATE TABLE hosted_databases (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL, db_name text NOT NULL UNIQUE,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
`,
  },
  {
    id: "003_hosted_passwords",
    sql: `
-- passwords sealed with AES-256-GCM (core/secret.ts) so connection details can be shown again
ALTER TABLE hosted_databases ADD COLUMN owner_password text, ADD COLUMN reader_password text;
`,
  },
];

export type Db = { pool: pg.Pool; ready: Promise<void>; migrated: string };
const dbs: Map<string, Db> = ((globalThis as any).__creamaDbs ??= new Map());

/**
 * One pool per (url, schema), migrated once. `schema` isolates tests: every connection gets
 * that search_path, so the same SQL runs against a throwaway namespace.
 */
export function database(url = process.env.DATABASE_URL, schema?: string): Db {
  if (!url) throw new Error("DATABASE_URL is not set. Creama keeps its state in Postgres: point DATABASE_URL at a database it can write to.");
  const id = `${url}#${schema ?? ""}`;
  const wanted = MIGRATIONS.map((m) => m.id).join(",");
  let d = dbs.get(id);
  if (!d) {
    const pool = new pg.Pool({ connectionString: url, max: 8, idleTimeoutMillis: 30_000, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
    pool.on("error", () => {}); // a dropped idle client must not crash the server
    d = { pool, ready: migrate(pool, schema), migrated: wanted };
    d.ready.catch(() => dbs.delete(id)); // let the next call retry a failed migration
    dbs.set(id, d);
  } else if (d.migrated !== wanted) {
    // the pool outlives hot reloads (it's on globalThis): apply migrations added since it was created
    const db = d;
    db.migrated = wanted;
    db.ready = db.ready.catch(() => {}).then(() => migrate(db.pool, schema));
    db.ready.catch(() => { db.migrated = ""; }); // retry on the next call
  }
  return d;
}

async function migrate(pool: pg.Pool, schema?: string) {
  const c = await pool.connect();
  try {
    if (schema) await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await c.query("SELECT pg_advisory_lock(hashtext('creama.migrations'))"); // several processes may boot at once
    await c.query("CREATE TABLE IF NOT EXISTS creama_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query<{ id: string }>("SELECT id FROM creama_migrations")).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
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
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext('creama.migrations'))").catch(() => {});
    c.release();
  }
}

export async function closeDatabases() {
  await Promise.all([...dbs.values()].map((d) => d.pool.end()));
  dbs.clear();
}
