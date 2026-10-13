// Hosted databases against the local cluster, the way production runs them: through a provisioner
// (CREATEDB CREATEROLE, not a superuser) that a superuser login creates once
// (CREMA_TEST_HOSTING_ADMIN_URL, default: the local superuser). Local pg_hba is usually `trust`,
// so this checks privileges and isolation; password checks only bite where scram is enforced.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { Hosting, password } from "../core/hosting";

const ADMIN = process.env.CREMA_TEST_HOSTING_ADMIN_URL ?? "postgresql://localhost:5432/postgres";
let h: Hosting;
// what the service stores before provisioning: a token per database and both passwords
const make = (dbName: string) => ({ dbName, token: randomUUID(), ownerPassword: password(), readerPassword: password() });
let provisioner = "";
const tag = `t${process.pid}`;
const A = `ztest_${tag}_a`, B = `ztest_${tag}_b`;
const TA = make(A), TB = make(B);
let available = true;

const as = async <T>(role: string, db: string, fn: (c: pg.Client) => Promise<T>) => {
  const u = new URL(ADMIN); u.username = role; u.password = "x"; u.pathname = `/${db}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
};

beforeAll(async () => {
  try { const c = new pg.Client({ connectionString: ADMIN }); await c.connect(); await c.end(); } catch (e) {
    if (process.env.CREMA_TEST_REQUIRE_DB) throw e; // CI: no cluster is a failure, not a pass
    available = false; return;
  }
  const p = await Hosting.createProvisioner(ADMIN);
  provisioner = p.role;
  h = new Hosting(p.url, Hosting.address(p.url, "db.example.com:5432", true));
});
afterAll(async () => {
  if (!available) return;
  for (const t of [TA, TB]) await h.drop(t.dbName, t.token).catch(() => {});
  const c = new pg.Client({ connectionString: ADMIN }); await c.connect();
  await c.query(`DROP ROLE IF EXISTS ${provisioner}`); await c.end();
});

describe("hosted databases", () => {
  it("administers through a limited login, never a superuser", async () => {
    if (!available) return;
    const su = await Hosting.check(ADMIN);
    if (su.superuser) expect(Hosting.refusal(su)).toMatch(/superuser/);
    const mine = await Hosting.check(h.adminUrl);
    expect(mine).toMatchObject({ user: provisioner, superuser: false, canProvision: true });
    expect(Hosting.refusal(mine)).toBeNull();
    expect(Hosting.refusal({ ...mine, versionNum: 150004, version: "15.4" })).toMatch(/16 or newer/);
    expect(Hosting.address("postgresql://x@localhost:5432/postgres")).toEqual({ host: "localhost", port: 5432, ssl: false });
    expect(() => Hosting.address("postgresql://x@localhost/postgres", "evil host;")).toThrow(/Public address/);
    await expect(Hosting.dropRole(ADMIN, "postgres")).rejects.toThrow(/Not a provisioner/);
  });

  it("creates an isolated database an app can use and Crema can only read", async () => {
    if (!available) return;
    expect(A).toMatch(/^ztest_/);
    const a = await h.create(A, TA);
    await h.create(B, TB);
    expect(TA.ownerPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(h.connectionString(A, a.owner, TA.ownerPassword)).toBe(`postgresql://${A}_owner:${TA.ownerPassword}@db.example.com:5432/${A}?sslmode=require`);

    // the app: full use of its own database
    await as(a.owner, A, async (c) => {
      await c.query("CREATE TABLE orders (id serial PRIMARY KEY, total int)");
      await c.query("INSERT INTO orders (total) VALUES (10), (20)");
    });
    // Crema: reads what the app created later, writes nothing
    await as(a.reader, A, async (c) => {
      expect((await c.query("SELECT sum(total)::int AS s FROM orders")).rows[0].s).toBe(30);
      await expect(c.query("INSERT INTO orders (total) VALUES (1)")).rejects.toThrow(/read-only/);
    });
    // isolation: no way into another hosted database, no new roles or databases
    await expect(as(a.owner, B, async () => {})).rejects.toThrow(/permission denied/);
    await expect(as(a.reader, B, async () => {})).rejects.toThrow(/permission denied/);
    await as(a.owner, A, async (c) => {
      await expect(c.query("CREATE ROLE sneaky")).rejects.toThrow(/permission denied/);
      await expect(c.query("CREATE DATABASE sneaky")).rejects.toThrow(/permission denied/);
    });
    // sizes and connections are visible to the admin
    const info = await h.info([A, B]);
    expect(info[A].sizeBytes).toBeGreaterThan(0);
  });

  it("rotates passwords, refuses odd names, and drops everything", async () => {
    if (!available) return;
    const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
    const before = (await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [`${A}_owner`])).rows[0].rolpassword;
    const pw = await h.resetPassword(A, "owner", TA.token);
    const after = (await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [`${A}_owner`])).rows[0].rolpassword;
    expect(pw).not.toHaveLength(0);
    expect(after).not.toBe(before);
    await expect(h.resetPassword(A, "owner", TB.token)).rejects.toThrow(/isn’t one Crema created/); // another source's token
    await expect(h.create(`${A}; DROP DATABASE x`, TA)).rejects.toThrow(/Invalid database name/);
    await expect(h.create(A, make(A))).rejects.toThrow(/already exists/); // same name, different source
    expect(await h.taken(A)).toEqual(expect.arrayContaining([A, `${A}_owner`, `${A}_crema`]));
    await expect(h.create("postgres", make("postgres"))).rejects.toThrow(/Invalid database name/);

    expect(await h.drop(A, TB.token)).toEqual({ dropped: [], left: [A, `${A}_crema`, `${A}_owner`] }); // not B's to drop
    expect((await h.drop(A, TA.token)).dropped).toEqual([A, `${A}_crema`, `${A}_owner`]);
    const left = await admin.query("SELECT (SELECT count(*) FROM pg_database WHERE datname = $1)::int + (SELECT count(*) FROM pg_roles WHERE rolname LIKE $1 || '\\_%')::int AS n", [A]);
    expect(left.rows[0].n).toBe(0);
    await admin.end();
  });

  it("resumes an interrupted attempt with the same token, and never adopts a stranger's", async () => {
    if (!available) return;
    const C = `ztest_${tag}_c`, TC = make(C);
    const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
    try {
      // a crash after the roles were made: create the owner role the way an attempt would have
      const prov = new pg.Client({ connectionString: h.adminUrl }); await prov.connect();
      await prov.query("SET createrole_self_grant = 'set, inherit'");
      await prov.query(`CREATE ROLE ${C}_owner LOGIN PASSWORD 'stale'`);
      await prov.query(`COMMENT ON ROLE ${C}_owner IS '${TC.token}'`);
      await prov.end();
      await h.create(C, TC); // resumes: same token
      await as(`${C}_owner`, C, async (c) => { expect((await c.query("SELECT current_database() AS d")).rows[0].d).toBe(C); });
      expect((await h.drop(C, TC.token)).dropped).toHaveLength(3);

      // somebody else's database of that name (made by the superuser): never adopted, never dropped
      await admin.query(`CREATE DATABASE ${C}`);
      await expect(h.create(C, TC)).rejects.toThrow(/already exists/);
      expect(await h.drop(C, TC.token)).toEqual({ dropped: [], left: [C] });
      expect((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [C])).rowCount).toBe(1);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${C} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${C}_owner`); await admin.query(`DROP ROLE IF EXISTS ${C}_crema`);
      await admin.end();
    }
  });
});
