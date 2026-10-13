// The first admin on a public address, the production path: no CREMA_SETUP_TOKEN, only the one-time
// link the server logs. Runs Better Auth's real sign-up against a throwaway database on the cluster.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cluster = process.env.CREMA_SAFETY_TEST_URL;
const suite = cluster ? describe : describe.skip;
const dbName = `crema_setup_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
let admin: pg.Client;
let mod: {
  db: typeof import("../core/db"); code: typeof import("../core/setupCode"); auth: typeof import("../lib/auth");
};

beforeAll(async () => {
  if (!cluster) return;
  admin = new pg.Client({ connectionString: cluster }); await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(cluster); u.pathname = `/${dbName}`;
  Object.assign(process.env, { DATABASE_URL: u.toString(), APP_URL: "https://crema.example.com", BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789" });
  delete process.env.CREMA_SETUP_TOKEN;
  mod = { db: await import("../core/db"), code: await import("../core/setupCode"), auth: await import("../lib/auth") };
  await mod.db.migrate(mod.db.database().pool);
});
afterAll(async () => {
  if (!cluster) return;
  await mod.db.closeDatabases();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await admin.end();
});

suite("first admin on a public address", () => {
  const signUp = (email: string, code?: string) => mod.auth.getAuth().api.signUpEmail({
    body: { name: "Owner", email, password: "a-long-password-1" },
    headers: new Headers({ origin: "https://crema.example.com", ...(code ? { "x-crema-setup-token": code } : {}) }),
  });

  it("needs the newest one-time link, then never again", async () => {
    const pool = mod.db.database().pool;
    expect(mod.auth.setupPolicy()).toEqual({ codeRequired: true, fixedToken: false });
    const first = (await mod.code.issueSetupCode(pool))!;
    expect(mod.code.setupLink("https://crema.example.com/", first)).toBe(`https://crema.example.com/sign-in#setup=${first}`); // fragment: never sent to a server
    // only a hash is stored
    expect((await pool.query("SELECT value FROM settings WHERE key = 'setup_code'")).rows[0].value).not.toContain(first);

    await expect(signUp("a@example.com")).rejects.toThrow(/setup link is missing, used or expired/);
    const second = (await mod.code.issueSetupCode(pool))!; // a restart: the old link stops working
    await expect(signUp("a@example.com", first)).rejects.toThrow(/missing, used or expired/);

    // expired after 24 hours
    await pool.query(`UPDATE settings SET value = jsonb_set(value::jsonb, '{at}', to_jsonb((now() - interval '25 hours')::text))::text WHERE key = 'setup_code'`);
    await expect(signUp("a@example.com", second)).rejects.toThrow(/missing, used or expired/);

    const third = (await mod.code.issueSetupCode(pool))!;
    // the account insert fails after the code was accepted: the code survives, and the same person
    // can retry at once; somebody else can't take over meanwhile
    await pool.query(`CREATE FUNCTION fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disk full'; END $$;
      CREATE TRIGGER fail_insert BEFORE INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION fail_insert()`);
    await expect(signUp("owner@example.com", third)).rejects.toThrow();
    await pool.query(`DROP TRIGGER fail_insert ON "user"; DROP FUNCTION fail_insert()`);
    expect((await pool.query(`SELECT count(*)::int AS n FROM "user"`)).rows[0].n).toBe(0);
    expect(await mod.code.setupCodeMatches(pool, third)).toBe(true);
    await expect(signUp("intruder@example.com", third)).rejects.toThrow(/Someone else is setting up/);
    const res = await signUp("owner@example.com", third);
    expect(res.user.email).toBe("owner@example.com");
    expect((await pool.query(`SELECT role FROM "user"`)).rows).toEqual([{ role: "admin" }]);
    // spent, and no new links once someone has an account
    expect((await pool.query("SELECT count(*)::int AS n FROM settings WHERE key = 'setup_code'")).rows[0].n).toBe(0);
    expect(await mod.code.issueSetupCode(pool)).toBeNull();
    await expect(signUp("b@example.com", third)).rejects.toThrow(/invite-only/);
  });
});
