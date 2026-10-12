// Real Postgres checks, opt-in on a disposable cluster. Never reads .env files.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../core/db";
import { Hosting } from "../core/hosting";
import { Registry } from "../core/registry";
import { Creama } from "../core/service";
import { closePools } from "../core/warehouse";
import { closeDatabases } from "../core/db";
import { unseal } from "../core/secret";

const url = process.env.CREAMA_SAFETY_TEST_URL;
const suite = url ? describe : describe.skip;
const schemas: string[] = [];
const schema = () => { const s = `safety_${randomUUID().replaceAll("-", "")}`; schemas.push(s); return s; };
const admin = new pg.Pool({ connectionString: url, max: 2 });
const hosting = new Hosting(url ?? "postgresql://localhost/postgres", { host: "127.0.0.1", port: 55483, ssl: false });

afterAll(async () => {
  if (url) for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await closePools(); await closeDatabases(); await admin.end();
});

suite("step 1 safety regressions", () => {
  it("does not delete an existing database when provisioning or retry collides", async () => {
    const name = `app_safety_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const previous = process.env.CREAMA_HOSTING_ADMIN_URL;
    process.env.CREAMA_HOSTING_ADMIN_URL = url;
    try {
      const svc = new Creama(new Registry(url, { schema: schema() }));
      await expect(svc.createHosted(name.replace(/^app_/, ""), "test")).rejects.toThrow(/already exists/);
      const failed = (await svc.reg.sources("default"))[0];
      expect(failed.status).toBe("failed");
      await expect(svc.retryHosted(failed.id, "test")).rejects.toThrow(/already exists/);
      expect((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.CREAMA_HOSTING_ADMIN_URL; else process.env.CREAMA_HOSTING_ADMIN_URL = previous;
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    }
  });

  it("checks the pinned version's tables without poisoning the current version", async () => {
    const s = schema();
    await admin.query(`CREATE SCHEMA ${s}; CREATE TABLE ${s}.old_orders (id int); CREATE TABLE ${s}.new_orders (id int); INSERT INTO ${s}.old_orders VALUES (1); INSERT INTO ${s}.new_orders VALUES (2)`);
    const base = new Creama(new Registry(url, { schema: schema() }));
    const { source } = await base.addExternal(url!, "test", "Safety");
    const svc = await base.withSource(source.id);
    await svc.create({ edits: { key: "orders", name: "Orders", kind: "snapshot", unit: "count", sql: `SELECT count(*) AS value FROM ${s}.old_orders` }, actor: "test" });
    await svc.revise({ key: "orders", edits: { sql: `SELECT count(*) AS value FROM ${s}.new_orders` }, actor: "test" });
    await admin.query(`ALTER TABLE ${s}.old_orders ADD COLUMN channel text`);
    await expect(base.query(`${source.slug}/orders`, { version: 1 })).rejects.toThrow(/needs attention/);
    expect((await svc.reg.metric(source.id, "orders"))!.status).toBe("certified");
    expect(await base.query(`${source.slug}/orders`)).toMatchObject({ version: 2, value: 1 });
  });

  it("upgrades the released schema in place, preserves history and seals its source", async () => {
    const s = schema();
    await admin.query(`CREATE SCHEMA ${s}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${s}` });
    const old = execFileSync("git", ["show", "67caf45:core/db.ts"], { encoding: "utf8" });
    const legacy = [...old.matchAll(/id: "([^"]+)",\s*sql: `([\s\S]*?)`/g)];
    try {
      await pool.query("CREATE TABLE creama_migrations (id text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
      for (const [, id, sql] of legacy) {
        await pool.query(sql); await pool.query("INSERT INTO creama_migrations(id) VALUES ($1)", [id]);
      }
      await pool.query("INSERT INTO settings VALUES ('database_url', $1)", [url]);
      await pool.query(`INSERT INTO metrics VALUES ('orders','Orders','certified','Ana',1,now());
        INSERT INTO metric_versions VALUES ('orders',1,'{"metricKey":"orders","version":1}', 'Ana',now());
        INSERT INTO events (actor, action, subject) VALUES ('Ana','metric.certified','metric:orders');
        INSERT INTO hosted_databases(name, db_name, created_by) VALUES ('Old app','app_old','Ana')`);
      const body = (await pool.query("SELECT body FROM metric_versions")).rows[0].body;
      expect(await migrate(pool)).toEqual(["001_init", "002_jobs"]);
      expect(await migrate(pool)).toEqual([]);
      expect((await pool.query("SELECT body FROM metric_versions")).rows[0].body).toEqual(body);
      const row = (await pool.query("SELECT connection FROM sources WHERE slug = 'legacy'")).rows[0];
      expect(row.connection).not.toBe(url); expect(unseal(row.connection)).toBe(url);
      expect((await pool.query("SELECT count(*)::int n FROM events")).rows[0].n).toBe(1);
      expect((await pool.query("SELECT status FROM sources WHERE kind = 'hosted'")).rows[0].status).toBe("failed");
      await expect(pool.query("UPDATE metric_versions SET body = '{}'" )).rejects.toThrow(/immutable/);
      await expect(pool.query("DELETE FROM events")).rejects.toThrow(/append-only/);
    } finally { await pool.end(); }
  });
});
