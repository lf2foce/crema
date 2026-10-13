// Real Postgres checks, opt-in on a disposable cluster. Never reads .env files.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { Registry } from "../core/registry";
import { Creama } from "../core/service";
import { closePools } from "../core/warehouse";
import { closeDatabases } from "../core/db";

const url = process.env.CREAMA_SAFETY_TEST_URL;
const suite = url ? describe : describe.skip;
const schemas: string[] = [];
const schema = () => { const s = `safety_${randomUUID().replaceAll("-", "")}`; schemas.push(s); return s; };
const admin = new pg.Pool({ connectionString: url, max: 2 });

afterAll(async () => {
  if (url) for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await closePools(); await closeDatabases(); await admin.end();
});

suite("step 1 safety regressions", () => {
  it("does not delete an existing database when provisioning or retry collides", async () => {
    const name = `app_safety_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const svc = new Creama(new Registry(url, { schema: schema() }));
    const { createdProvisioner } = await svc.addServer({ url: url! }, "test");
    try {
      await expect(svc.createHosted(name.replace(/^app_/, ""), "test")).rejects.toThrow(/already exists/);
      const failed = (await svc.reg.sources("default"))[0];
      expect(failed.status).toBe("failed");
      await expect(svc.retryHosted(failed.id, "test")).rejects.toThrow(/already exists/);
      expect((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount).toBe(1);
    } finally {
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${createdProvisioner}`);
    }
  });

  it("hosts through its own limited login: full lifecycle, and nothing else on the server", async () => {
    const svc = new Creama(new Registry(url, { schema: schema() }));
    await expect(svc.createHosted("nowhere", "test")).rejects.toThrow(/Add a Postgres server first/);
    const { server, createdProvisioner } = await svc.addServer({ url: url!, name: "Local", publicHost: "db.example.com:6543" }, "test");
    expect(createdProvisioner).toMatch(/^creama_provisioner_[0-9a-f]{6}$/);
    expect(server).toMatchObject({ name: "Local", publicHost: "db.example.com:6543", ssl: true, provisioner: createdProvisioner });
    // the superuser URL is not what Creama keeps
    const stored = (await svc.reg.db.pool.query("SELECT admin_url FROM servers WHERE id = $1", [server.id])).rows[0].admin_url;
    expect(stored).not.toContain(new URL(url!).username || "@@");
    const role = (await admin.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1", [createdProvisioner])).rows[0];
    expect(role).toEqual({ rolsuper: false, rolcreatedb: true, rolcreaterole: true, rolbypassrls: false });

    const stranger = `stranger_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await admin.query(`CREATE ROLE ${stranger} LOGIN`);
    const dbName = `app_life_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    try {
      const source = await svc.createHosted(dbName.replace(/^app_/, ""), "test");
      expect(source).toMatchObject({ status: "ready", serverId: server.id, dbName });
      const conn = await svc.hostedConnection(source.id, "owner");
      expect(conn).toMatchObject({ host: "db.example.com", port: 6543, ssl: true, user: `${dbName}_owner` });
      expect((await svc.resetHostedPassword(source.id, "test", "reader")).password).not.toBe(conn.password);
      expect((await svc.sources())[0].sizeBytes).toBeGreaterThan(0);
      await expect(svc.removeServer(server.id, "test")).rejects.toThrow(/still has 1 database/);

      // the provisioner can't reach past what it created
      expect(await svc.checkServer(server.id)).toMatchObject({ ok: true });
      const prov = new URL(url!); prov.username = createdProvisioner!; prov.password = "";
      const p = new pg.Client({ connectionString: prov.toString() });
      await p.connect();
      try {
        await expect(p.query(`ALTER ROLE ${stranger} PASSWORD 'x'`)).rejects.toThrow(/permission denied/);
        await expect(p.query(`DROP ROLE ${stranger}`)).rejects.toThrow(/permission denied/);
        await expect(p.query("CREATE ROLE sneaky SUPERUSER")).rejects.toThrow(/permission denied/);
      } finally { await p.end(); }

      await svc.removeSource(source.id, "test");
      expect((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])).rowCount).toBe(0);
      expect(await svc.removeServer(server.id, "test")).toEqual({ provisioner: createdProvisioner });
      expect(await svc.servers()).toEqual([]);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${dbName}_owner`); await admin.query(`DROP ROLE IF EXISTS ${dbName}_creama`);
      await admin.query(`DROP ROLE IF EXISTS ${stranger}`); await admin.query(`DROP ROLE IF EXISTS ${createdProvisioner}`);
    }
  });

  it("keeps a provisioner login it is given, and offers the bundled server once", async () => {
    const c = new pg.Client({ connectionString: url }); await c.connect();
    const role = `creama_provisioner_${randomUUID().replaceAll("-", "").slice(0, 6)}`;
    await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'p' CREATEDB CREATEROLE`);
    const preexisting = new Set((await c.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'creama\\_provisioner\\_%'")).rows.map((r) => r.rolname));
    const bundled = new URL(url!); bundled.username = role; bundled.password = "p"; bundled.pathname = "/postgres";
    const previous = { u: process.env.CREAMA_BUNDLED_SERVER_URL, h: process.env.CREAMA_BUNDLED_SERVER_PUBLIC_HOST };
    process.env.CREAMA_BUNDLED_SERVER_URL = bundled.toString();
    process.env.CREAMA_BUNDLED_SERVER_PUBLIC_HOST = "db.example.com:5433";
    try {
      const svc = new Creama(new Registry(url, { schema: schema() }));
      expect((await svc.state()).suggestedServer).toEqual({ name: "Bundled server", publicHost: "db.example.com:5433" });
      // the first "New database" uses it without asking
      const name = `bundled_${randomUUID().replaceAll("-", "").slice(0, 6)}`;
      const source = await svc.createHosted(name, "test");
      const [server] = await svc.servers();
      expect(server).toMatchObject({ name: "Bundled server", provisioner: role, publicHost: "db.example.com:5433", ssl: true, databases: 1 });
      expect(source.serverId).toBe(server.id);
      expect((await c.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'creama\\_provisioner\\_%' AND rolname <> $1", [role])).rows.filter((r) => !preexisting.has(r.rolname))).toEqual([]); // kept as is: no new role
      await svc.removeSource(source.id, "test");
      expect((await svc.state()).suggestedServer).toBeNull();
      await expect(svc.addSuggestedServer("test")).rejects.toThrow(/already exists/);
      // a login that can't provision is refused, never kept
      await c.query(`ALTER ROLE ${role} NOCREATEROLE`);
      await expect(svc.addServer({ url: bundled.toString(), name: "weak" }, "test")).rejects.toThrow(/needs CREATEDB and CREATEROLE/);
    } finally {
      for (const [k, v] of [["CREAMA_BUNDLED_SERVER_URL", previous.u], ["CREAMA_BUNDLED_SERVER_PUBLIC_HOST", previous.h]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await c.query(`DROP ROLE IF EXISTS ${role}`); await c.end();
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
    await admin.query(`ALTER TABLE ${s}.new_orders ADD COLUMN channel text`);
    expect(await base.checkDrift()).toMatchObject({ checked: 1, changed: 1, errors: [] });
    expect((await svc.reg.metric(source.id, "orders"))!.status).toBe("needs_attention");
    expect(await base.checkDrift()).toMatchObject({ changed: 0 });
    expect((await base.audit()).filter((event) => event.action === "metric.drift_detected")).toHaveLength(1);
  });
});
