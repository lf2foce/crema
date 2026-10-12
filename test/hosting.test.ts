// Hosted databases against the local cluster. Needs a role that may CREATE DATABASE/ROLE
// (CREAMA_TEST_HOSTING_ADMIN_URL, default: the local superuser). Local pg_hba is usually `trust`,
// so this checks privileges and isolation; password checks only bite where scram is enforced.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Hosting } from "../core/hosting";

const ADMIN = process.env.CREAMA_TEST_HOSTING_ADMIN_URL ?? "postgresql://localhost:5432/postgres";
const h = new Hosting(ADMIN, { host: "db.example.com", port: 5432, ssl: true });
const tag = `t${process.pid}`;
const A = Hosting.dbNameFor(`ztest ${tag} a`), B = Hosting.dbNameFor(`ztest ${tag} b`);
let available = true;

const as = async <T>(role: string, db: string, fn: (c: pg.Client) => Promise<T>) => {
  const u = new URL(ADMIN); u.username = role; u.password = "x"; u.pathname = `/${db}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
};

beforeAll(async () => {
  try { const c = new pg.Client({ connectionString: ADMIN }); await c.connect(); await c.end(); } catch { available = false; }
});
afterAll(async () => { if (available) for (const d of [A, B]) await h.drop(d).catch(() => {}); });

describe("hosted databases", () => {
  it("creates an isolated database an app can use and Creama can only read", async () => {
    if (!available) return;
    expect(A).toMatch(/^app_ztest_/);
    const a = await h.create(A);
    await h.create(B);
    expect(a.ownerPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(h.connectionString(A, a.owner, a.ownerPassword)).toBe(`postgresql://${A}_owner:${a.ownerPassword}@db.example.com:5432/${A}?sslmode=require`);

    // the app: full use of its own database
    await as(a.owner, A, async (c) => {
      await c.query("CREATE TABLE orders (id serial PRIMARY KEY, total int)");
      await c.query("INSERT INTO orders (total) VALUES (10), (20)");
    });
    // Creama: reads what the app created later, writes nothing
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
    const pw = await h.resetPassword(`${A}_owner`);
    const after = (await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [`${A}_owner`])).rows[0].rolpassword;
    expect(pw).not.toHaveLength(0);
    expect(after).not.toBe(before);
    await expect(h.resetPassword("postgres")).rejects.toThrow(/Not a hosted database role/);
    await expect(h.create(`${A}; DROP DATABASE x`)).rejects.toThrow(/Invalid database name/);
    await expect(h.create(A)).rejects.toThrow(/already exists/);

    await h.drop(A);
    const left = await admin.query("SELECT (SELECT count(*) FROM pg_database WHERE datname = $1)::int + (SELECT count(*) FROM pg_roles WHERE rolname LIKE $1 || '\\_%')::int AS n", [A]);
    expect(left.rows[0].n).toBe(0);
    await admin.end();
  });
});
