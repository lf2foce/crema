#!/usr/bin/env -S npx tsx
// One-off: copy a registry from the old SQLite file (.creama/creama.db) into Postgres (DATABASE_URL).
// Keeps ids, so links like #p/5 keep working. Refuses to run into a registry that already has data.
//   npx tsx bin/import-sqlite.ts [path/to/creama.db]
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env.local", ".env"]) if (existsSync(resolve(root, f))) process.loadEnvFile(resolve(root, f));
const file = resolve(process.argv[2] ?? resolve(root, ".creama/creama.db"));
if (!existsSync(file)) throw new Error(`No SQLite registry at ${file}`);

const { database, closeDatabases } = await import("../core/db");
const src = new DatabaseSync(file, { readOnly: true });
const { pool, ready } = database();
await ready;

const rows = (table: string) => src.prepare(`SELECT * FROM ${table}`).all() as Record<string, any>[];
const parse = (v: unknown) => (typeof v === "string" ? v : v == null ? null : JSON.stringify(v)); // already JSON text in SQLite
const has = (table: string) => (src.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { n: number }).n > 0;

const c = await pool.connect();
try {
  const existing = (await c.query("SELECT (SELECT count(*) FROM runs) + (SELECT count(*) FROM metrics) + (SELECT count(*) FROM events) AS n")).rows[0].n;
  if (Number(existing) > 0) throw new Error("The Postgres registry already has data; refusing to import over it.");
  await c.query("BEGIN");
  for (const r of rows("settings")) await c.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [r.key, r.value]);
  for (const r of rows("runs")) await c.query(
    `INSERT INTO runs (id, status, started_at, finished_at, model, hint, focus, steps, summary, entities, sent_to_model, error, snapshot, pid)
     OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [r.id, r.status, r.started_at, r.finished_at, r.model, r.hint, r.focus, parse(r.steps) ?? "[]", r.summary, parse(r.entities) ?? "[]", parse(r.sent_to_model), r.error, parse(r.snapshot), r.pid]);
  for (const r of rows("concepts")) await c.query(
    `INSERT INTO concepts (id, run_id, key, name, question, status, comparison, metric_key, created_at) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [r.id, r.run_id, r.key, r.name, r.question, r.status === "ratified" ? "certified" : r.status, parse(r.comparison), r.metric_key, r.created_at]);
  for (const r of rows("candidates")) await c.query(
    `INSERT INTO candidates (id, concept_id, position, spec, verification) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5)`,
    [r.id, r.concept_id, r.position, parse(r.spec), parse(r.verification)]);
  for (const r of rows("metrics")) await c.query(
    `INSERT INTO metrics (key, name, status, owner, current_version, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [r.key, r.name, r.status === "ratified" ? "certified" : r.status, r.owner, r.current_version, r.created_at]);
  for (const r of rows("metric_versions")) await c.query(
    `INSERT INTO metric_versions (metric_key, version, body, certified_by, certified_at) VALUES ($1,$2,$3,$4,$5)`,
    [r.metric_key, r.version, parse(r.body), r.certified_by ?? r.ratified_by, r.certified_at ?? r.ratified_at]);
  for (const r of rows("events")) await c.query(
    `INSERT INTO events (id, at, actor, action, subject, detail) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6)`,
    [r.id, r.at, r.actor, r.action, r.subject, parse(r.detail)]);
  if (has("saved_queries")) for (const r of rows("saved_queries")) await c.query(
    `INSERT INTO saved_queries (id, name, sql, created_by, created_at, updated_at) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6)`,
    [r.id, r.name, r.sql, r.created_by, r.created_at, r.updated_at]);
  // identity columns continue after the imported ids
  for (const t of ["runs", "concepts", "candidates", "events", "saved_queries"]) {
    await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), coalesce((SELECT max(id) FROM ${t}), 0) + 1, false)`);
  }
  await c.query("COMMIT");
  const counts = (await c.query(`SELECT (SELECT count(*) FROM runs) runs, (SELECT count(*) FROM concepts) concepts, (SELECT count(*) FROM candidates) candidates,
    (SELECT count(*) FROM metrics) metrics, (SELECT count(*) FROM metric_versions) versions, (SELECT count(*) FROM events) events, (SELECT count(*) FROM saved_queries) queries`)).rows[0];
  console.log("Imported:", counts);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  c.release();
  src.close();
  await closeDatabases();
}
