// Runs against the Lumen demo database (pnpm demo:db). Deterministic: no model calls.
// Definitions here are written by hand to the same contract the model must follow.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { compare } from "../core/compare";
import { Registry } from "../core/registry";
import { modelPayload, snapshot } from "../core/schema";
import { Crema } from "../core/service";
import type { Candidate, CandidateSpec, SchemaSnapshot } from "../core/types";
import { verify, windows } from "../core/verify";
import { closePools, Warehouse } from "../core/warehouse";
import { closeDatabases, database } from "../core/db";
import pg from "pg";

const ADMIN_PG = process.env.CREMA_TEST_HOSTING_ADMIN_URL ?? "postgresql://localhost:5432/postgres";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const URL = process.env.CREMA_DEMO_URL ?? ""; // pnpm demo:db writes it to .env.local
const ADMIN = process.env.CREMA_TEST_ADMIN_URL ?? "postgresql:///crema_demo?host=/tmp";

let wh: Warehouse;
let snap: SchemaSnapshot;
let available = true;

beforeAll(async () => {
  const required = !!process.env.CREMA_TEST_REQUIRE_DB; // CI: no demo database is a failure, not a pass
  if (!URL) { if (required) throw new Error("CREMA_DEMO_URL is not set (pnpm demo:db)"); available = false; return; }
  wh = new Warehouse(URL);
  try {
    await wh.query("select 1");
    snap = await snapshot(wh);
  } catch (e) {
    if (required) throw e;
    available = false;
  }

});
// Crema's state goes to a throwaway schema per test, dropped at the end.
const STATE_URL = process.env.CREMA_TEST_STATE_URL ?? "postgresql://localhost:5432/crema_test";
const schemas: string[] = [];
function freshRegistry() {
  const schema = `t_${process.pid}_${schemas.length}_${Math.random().toString(36).slice(2, 8)}`;
  schemas.push(schema);
  return new Registry(STATE_URL, { schema });
}
afterAll(async () => {
  const admin = database(STATE_URL).pool;
  for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await closeDatabases();
  await closePools();
});

const MONTHLY = `CASE WHEN p.billing_interval = 'year' THEN p.price_cents / 12.0 ELSE p.price_cents END / 100.0`;
const LIVE = `s.started_at <= {{at}} AND (s.canceled_at IS NULL OR s.canceled_at > {{at}})`;
const FROM = `FROM public.subscriptions s JOIN public.plans p ON p.id = s.plan_id JOIN public.accounts a ON a.id = s.account_id`;

const mrrPaid: CandidateSpec = {
  label: "Paid, normalised", description: "", kind: "snapshot", unit: "currency", confidence: "high", why: "", assumptions: [],
  sql: `SELECT COALESCE(SUM(${MONTHLY}), 0) AS value ${FROM} WHERE NOT a.is_internal AND ${LIVE} AND (s.trial_ends_at IS NULL OR s.trial_ends_at <= {{at}})`,
  membersSql: `SELECT s.id AS id, ${MONTHLY} AS value ${FROM} WHERE NOT a.is_internal AND ${LIVE} AND (s.trial_ends_at IS NULL OR s.trial_ends_at <= {{at}})`,
  memberTable: "public.subscriptions",
};
const mrrNaive: CandidateSpec = {
  ...mrrPaid, label: "List price, incl. trials",
  sql: `SELECT COALESCE(SUM(p.price_cents / 100.0), 0) AS value ${FROM} WHERE NOT a.is_internal AND ${LIVE}`,
  membersSql: `SELECT s.id AS id, p.price_cents / 100.0 AS value ${FROM} WHERE NOT a.is_internal AND ${LIVE}`,
};
const asCandidate = (s: CandidateSpec, id: number, v: Candidate["verification"]): Candidate => ({ ...s, id, conceptId: 1, verification: v });

describe.runIf(() => available)("against the demo database", () => {
  it("never writes, even with a role that could", async () => {
    const admin = new Warehouse(ADMIN);
    await expect(admin.query("DELETE FROM public.plans")).rejects.toThrow(/read-only transaction/);
    const [{ n }] = await admin.query<{ n: number }>("select count(*)::int as n from public.plans");
    expect(n).toBe(6);
  });

  it("profiles the schema without leaking identifying values", () => {
    const payload = JSON.stringify(modelPayload(snap));
    expect(payload).not.toMatch(/@[a-z0-9]+\.com/); // no e-mail addresses
    const users = modelPayload(snap).find((t) => t.table === "public.users")!;
    expect(users.columns.find((c) => c.name === "email")!.values).toBe("withheld (identifying)");
    expect(users.columns.find((c) => c.name === "full_name")!.values).toBe("withheld (identifying)");
    const events = modelPayload(snap).find((t) => t.table === "public.events")!;
    expect(Object.keys(events.columns.find((c) => c.name === "name")!.values as object)).toContain("login");
    expect(snap.tables.find((t) => t.name === "accounts")!.primaryKey).toEqual(["id"]);
  });

  it("verifies a correct definition and finds its history", async () => {
    const v = await verify(wh, mrrPaid, snap);
    expect(v.ok).toBe(true);
    expect(v.value).toBeGreaterThan(100_000);
    expect(v.series).toHaveLength(12);
    expect(v.relations).toEqual(["public.accounts", "public.plans", "public.subscriptions"]);
    expect(v.membersTotal).toBeCloseTo(v.value!, 2);
    expect(v.checks.filter((c) => c.level === "fail" || c.level === "warn")).toEqual([]);
  });

  it("catches what the model could get wrong", async () => {
    const nowBased = await verify(wh, { ...mrrPaid, sql: mrrPaid.sql.replaceAll("{{at}}", "now()") }, snap);
    expect(nowBased.ok).toBe(false);
    expect(nowBased.error).toMatch(/now is not on the safe analytics allowlist/); // rejected before it runs

    const cents = await verify(wh, { kind: "flow", unit: "currency", membersSql: null, memberTable: null,
      sql: "SELECT COALESCE(SUM(total_cents), 0) AS value FROM public.invoices WHERE status = 'paid' AND paid_at >= {{start}} AND paid_at < {{end}}" }, snap);
    expect(cents.checks.find((c) => c.id === "units")?.level).toBe("warn");
    expect(cents.checks.find((c) => c.id.startsWith("internal:"))?.message).toMatch(/is_internal/);

    const deleted = await verify(wh, { kind: "snapshot", unit: "count", memberTable: "public.accounts",
      sql: "SELECT count(*) AS value FROM public.accounts WHERE created_at <= {{at}}",
      membersSql: "SELECT id FROM public.accounts WHERE created_at <= {{at}}" }, snap);
    expect(deleted.checks.find((c) => c.id === "softdelete:public.accounts")?.level).toBe("warn");

    const broken = await verify(wh, { ...mrrPaid, sql: "SELECT sum(nope) AS value FROM public.invoices WHERE paid_at >= {{at}}" }, snap);
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(/nope/);
  });

  it("traces a disagreement to rows and explains each part", async () => {
    const w = windows();
    const [va, vb] = await Promise.all([verify(wh, mrrPaid, snap, w), verify(wh, mrrNaive, snap, w)]);
    const cmp = await compare(wh, [asCandidate(mrrPaid, 1, va), asCandidate(mrrNaive, 2, vb)], snap, w);
    expect(cmp.spread).toBeGreaterThan(0.5);
    const [d] = cmp.diffs;
    // annual plans: same subscriptions, valued 12x by the naive definition
    expect(d.changed.rows).toBeGreaterThan(100);
    expect(d.changed.explain).toMatch(/100% of them have plans\.billing_interval = 'year'/);
    // trials: only the naive definition includes them
    expect(d.onlyB.rows).toBeGreaterThan(10);
    expect(d.onlyB.explain).toMatch(/status = 'trialing'/);
    expect(d.onlyA.rows).toBe(0);
    // the parts add up to the gap
    expect(d.onlyB.amount + d.changed.amount + d.onlyA.amount).toBeCloseTo(vb.value! - va.value!, 2);
    expect(d.onlyB.sample.length).toBeGreaterThan(0);
  });

  it("only certifies with a named human, re-verifies, versions immutably, and serves only certified metrics", async () => {
    const base = new Crema(freshRegistry());
    const { source } = await base.addExternal(URL, "test", "Demo");
    const r = await base.withSource(source.id);
    const ref = `${source.slug}/mrr`;
    const runId = await r.reg.createRun(source.id, "fixture", null, null);
    const [va, vb] = await Promise.all([verify(wh, mrrPaid, snap), verify(wh, mrrNaive, snap)]);
    await r.reg.updateRun(runId, { status: "done", summary: "fixture", snapshot: snap });
    const conceptId = await r.reg.saveConcept(source.id, runId, { key: "mrr", name: "MRR", question: "What is our MRR?", candidates: [mrrPaid, mrrNaive] }, [va, vb], null);
    const concept = (await r.reg.concept(source.id, conceptId))!;

    await expect(r.query(ref)).rejects.toThrow(/No certified metric/);
    expect(await r.listMetrics()).toEqual([]);
    await expect(r.certify({ conceptId, candidateId: concept.candidates[0].id, actor: "" })).rejects.toThrow(/needs a name/);
    await expect(r.certify({ conceptId, candidateId: concept.candidates[0].id, actor: "Ana", edits: { sql: "SELECT 1 AS value FROM public.plans WHERE now() > {{at}}" } })).rejects.toThrow(/Not certified/);

    const v1 = await r.certify({ conceptId, candidateId: concept.candidates[0].id, actor: "Ana", note: "trials excluded" });
    expect(v1).toMatchObject({ metricKey: "mrr", version: 1, certifiedBy: "Ana", origin: "ai" });
    expect(Object.keys(v1.fingerprint)).toContain("public.plans");
    await expect(r.certify({ conceptId, candidateId: concept.candidates[1].id, actor: "Ana" })).rejects.toThrow(/already certified/);

    const q = await r.query(ref, { grain: "month", from: "2026-01-01" });
    expect(q).toMatchObject({ version: 1, certifiedBy: "Ana", trust: "certified" });
    expect((q as { points: unknown[] }).points.length).toBeGreaterThanOrEqual(9);

    const v2 = await r.revise({ key: "mrr", actor: "Ben", note: "list price", edits: { sql: mrrNaive.sql } });
    expect(v2.version).toBe(2);
    const pinned = await r.query(ref, { version: 1 });
    const latest = await r.query(ref);
    expect((latest as { value: number }).value).toBeGreaterThan((pinned as { value: number }).value);

    // a trailing ";" (models write it) passes verification; it must not break the series every consumer reads
    const v3 = await r.revise({ key: "mrr", actor: "Ben", note: "semicolon", edits: { sql: `${mrrNaive.sql};\n` } });
    expect(v3.sql.trim().endsWith(";")).toBe(false);
    const series = await r.query(ref, { grain: "month", from: "2026-01-01" });
    expect((series as { points: unknown[] }).points.length).toBeGreaterThanOrEqual(9);

    const db = r.reg.db.pool;
    await expect(db.query("UPDATE metric_versions SET certified_by = 'x'")).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM metric_versions")).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE events SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM events")).rejects.toThrow(/append-only/);
    // certifying closed the proposal in the same transaction
    expect((await r.reg.concept(source.id, conceptId))!.status).toBe("certified");
    expect((await base.listMetrics()).map((m) => m.ref)).toEqual([ref]);
    expect((await r.audit()).map((e) => e.action)).toEqual(expect.arrayContaining(["metric.certified", "metric.revised", "proposal.certified"]));

    await r.deprecate("mrr", "Ben");
    expect(await r.listMetrics()).toEqual([]);
    await expect(r.query(ref)).rejects.toThrow(/No certified metric/);
  });

  it("lets a person create a metric by hand, with the same checks and audit trail", async () => {
    const base = new Crema(freshRegistry());
    const { source } = await base.addExternal(URL, "test");
    const r = await base.withSource(source.id);
    const edits = { name: "Doanh thu thuần", question: "Doanh thu sau hoàn tiền?", kind: "flow" as const, unit: "currency" as const, sql: "SELECT coalesce(sum(total_cents), 0) / 100.0 AS value FROM public.invoices WHERE status = 'paid' AND paid_at >= {{start}} AND paid_at < {{end}}" };

    await expect(r.create({ edits, actor: "" })).rejects.toThrow(/needs a name/);
    await expect(r.create({ edits: { ...edits, name: "" }, actor: "Ana" })).rejects.toThrow(/needs a name/);
    await expect(r.create({ edits: { ...edits, sql: "SELECT 1 AS value" }, actor: "Ana" })).rejects.toThrow(/Not certified/);
    await expect(r.create({ edits: { ...edits, sql: "DELETE FROM public.invoices" }, actor: "Ana" })).rejects.toThrow();

    const v = await r.create({ edits, actor: "Ana", note: "from finance" });
    expect(v).toMatchObject({ metricKey: "doanh_thu_thuan", version: 1, origin: "human", certifiedBy: "Ana", unit: "currency" });
    expect(Object.keys(v.fingerprint)).toContain("public.invoices");
    await expect(r.create({ edits, actor: "Ana" })).rejects.toThrow(/already exists/);
    expect((await r.query(`${source.slug}/doanh_thu_thuan`)) as { value: number }).toMatchObject({ trust: "certified" });
    expect((await r.audit()).map((e) => e.action)).toEqual(expect.arrayContaining(["metric.certified", "metric.created"]));
  });

  it("keeps metrics on their own source and stops serving one whose tables changed", async () => {
    const dbName = `crema_drift_${process.pid}`;
    const raw = new pg.Client({ connectionString: ADMIN_PG }); await raw.connect();
    try {
      await raw.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await raw.query(`CREATE DATABASE ${dbName}`);
      const u = new globalThis.URL(ADMIN_PG); u.pathname = `/${dbName}`;
      const setup = new pg.Client({ connectionString: u.toString() }); await setup.connect();
      await setup.query("CREATE TABLE orders (id serial PRIMARY KEY, total int); INSERT INTO orders (total) VALUES (5), (7)");

      const base = new Crema(freshRegistry());
      const a = await base.addExternal(u.toString(), "test", "Shop");
      const b = await base.addExternal(URL, "test", "Shop"); // same name → its own slug
      expect(b.source.slug).not.toBe(a.source.slug);
      const shop = await base.withSource(a.source.id);
      await shop.create({ edits: { name: "Orders", kind: "snapshot", unit: "count", sql: "SELECT count(*) AS value FROM public.orders" }, actor: "Ana" });
      const ref = `${a.source.slug}/orders`;
      expect(await shop.query(ref)).toMatchObject({ value: 2, source: a.source.slug });
      // the same key on another source isn't this metric
      await expect(base.query(`${b.source.slug}/orders`)).rejects.toThrow(/No certified metric/);

      // the table changes: not served, marked, until re-certified
      await setup.query("ALTER TABLE orders ADD COLUMN channel text");
      await expect(base.query(ref)).rejects.toThrow(/needs attention.*public\.orders/);
      expect((await shop.reg.metric(a.source.id, "orders"))!.status).toBe("needs_attention");
      await shop.revise({ key: "orders", edits: {}, actor: "Ana", note: "channel column is irrelevant" });
      expect(await base.query(ref)).toMatchObject({ value: 2, version: 2 });
      expect((await shop.reg.metric(a.source.id, "orders"))!.status).toBe("certified");
      await setup.end();
    } finally {
      await raw.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await raw.end();
    }
  });
});
