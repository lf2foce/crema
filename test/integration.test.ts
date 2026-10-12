// Runs against the Lumen demo database (pnpm demo:db). Deterministic: no model calls.
// Definitions here are written by hand to the same contract the model must follow.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { compare } from "../core/compare";
import { Registry } from "../core/registry";
import { modelPayload, snapshot } from "../core/schema";
import { Creama } from "../core/service";
import type { Candidate, CandidateSpec, SchemaSnapshot } from "../core/types";
import { verify, windows } from "../core/verify";
import { closePools, Warehouse } from "../core/warehouse";
import { closeDatabases, database } from "../core/db";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const URL = process.env.CREAMA_DEMO_URL ?? "postgresql://creama_reader:creama_readonly@localhost:5432/creama_demo";
const ADMIN = process.env.CREAMA_TEST_ADMIN_URL ?? "postgresql:///creama_demo?host=/tmp";

let wh: Warehouse;
let snap: SchemaSnapshot;
let available = true;

beforeAll(async () => {
  wh = new Warehouse(URL);
  try {
    await wh.query("select 1");
    snap = await snapshot(wh);
  } catch {
    available = false;
  }
});
// Creama's state goes to a throwaway schema per test, dropped at the end.
const STATE_URL = process.env.CREAMA_TEST_STATE_URL ?? "postgresql://localhost:5432/creama_test";
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
    expect(nowBased.checks.find((c) => c.id === "reproducible")?.level).toBe("fail");

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
    const r = new Creama(freshRegistry());
    await r.connect(URL, "test");
    const runId = await r.reg.createRun("fixture", null, null);
    const [va, vb] = await Promise.all([verify(wh, mrrPaid, snap), verify(wh, mrrNaive, snap)]);
    await r.reg.updateRun(runId, { status: "done", summary: "fixture", snapshot: snap });
    const conceptId = await r.reg.saveConcept(runId, { key: "mrr", name: "MRR", question: "What is our MRR?", candidates: [mrrPaid, mrrNaive] }, [va, vb], null);
    const concept = (await r.reg.concept(conceptId))!;

    await expect(r.query("mrr")).rejects.toThrow(/No certified metric/);
    expect(await r.listMetrics()).toEqual([]);
    await expect(r.certify({ conceptId, candidateId: concept.candidates[0].id, actor: "" })).rejects.toThrow(/needs a name/);
    await expect(r.certify({ conceptId, candidateId: concept.candidates[0].id, actor: "Ana", edits: { sql: "SELECT 1 AS value FROM public.plans WHERE now() > {{at}}" } })).rejects.toThrow(/Not certified/);

    const v1 = await r.certify({ conceptId, candidateId: concept.candidates[0].id, actor: "Ana", note: "trials excluded" });
    expect(v1).toMatchObject({ metricKey: "mrr", version: 1, certifiedBy: "Ana", origin: "ai" });
    expect(Object.keys(v1.fingerprint)).toContain("public.plans");
    await expect(r.certify({ conceptId, candidateId: concept.candidates[1].id, actor: "Ana" })).rejects.toThrow(/already certified/);

    const q = await r.query("mrr", { grain: "month", from: "2026-01-01" });
    expect(q).toMatchObject({ version: 1, certifiedBy: "Ana", trust: "certified" });
    expect((q as { points: unknown[] }).points.length).toBeGreaterThanOrEqual(9);

    const v2 = await r.revise({ key: "mrr", actor: "Ben", note: "list price", edits: { sql: mrrNaive.sql } });
    expect(v2.version).toBe(2);
    const pinned = await r.query("mrr", { version: 1 });
    const latest = await r.query("mrr");
    expect((latest as { value: number }).value).toBeGreaterThan((pinned as { value: number }).value);

    // a trailing ";" (models write it) passes verification; it must not break the series every consumer reads
    const v3 = await r.revise({ key: "mrr", actor: "Ben", note: "semicolon", edits: { sql: `${mrrNaive.sql};\n` } });
    expect(v3.sql.trim().endsWith(";")).toBe(false);
    const series = await r.query("mrr", { grain: "month", from: "2026-01-01" });
    expect((series as { points: unknown[] }).points.length).toBeGreaterThanOrEqual(9);

    const db = r.reg.db.pool;
    await expect(db.query("UPDATE metric_versions SET certified_by = 'x'")).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM metric_versions")).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE events SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM events")).rejects.toThrow(/append-only/);
    // certifying closed the proposal in the same transaction
    expect((await r.reg.concept(conceptId))!.status).toBe("certified");
    expect((await r.audit()).map((e) => e.action)).toEqual(expect.arrayContaining(["metric.certified", "metric.revised", "proposal.certified"]));

    await r.retire("mrr", "Ben");
    expect(await r.listMetrics()).toEqual([]);
    await expect(r.query("mrr")).rejects.toThrow(/No certified metric/);
  });

  it("lets a person create a metric by hand, with the same checks and audit trail", async () => {
    const r = new Creama(freshRegistry());
    await r.connect(URL, "test");
    const edits = { name: "Doanh thu thuần", question: "Doanh thu sau hoàn tiền?", kind: "flow" as const, unit: "currency" as const, sql: "SELECT coalesce(sum(total_cents), 0) / 100.0 AS value FROM public.invoices WHERE status = 'paid' AND paid_at >= {{start}} AND paid_at < {{end}}" };

    await expect(r.create({ edits, actor: "" })).rejects.toThrow(/needs a name/);
    await expect(r.create({ edits: { ...edits, name: "" }, actor: "Ana" })).rejects.toThrow(/needs a name/);
    await expect(r.create({ edits: { ...edits, sql: "SELECT 1 AS value" }, actor: "Ana" })).rejects.toThrow(/Not certified/);
    await expect(r.create({ edits: { ...edits, sql: "DELETE FROM public.invoices" }, actor: "Ana" })).rejects.toThrow();

    const v = await r.create({ edits, actor: "Ana", note: "from finance" });
    expect(v).toMatchObject({ metricKey: "doanh_thu_thuan", version: 1, origin: "human", certifiedBy: "Ana", unit: "currency" });
    expect(Object.keys(v.fingerprint)).toContain("public.invoices");
    await expect(r.create({ edits, actor: "Ana" })).rejects.toThrow(/already exists/);
    expect((await r.query("doanh_thu_thuan")) as { value: number }).toMatchObject({ trust: "certified" });
    expect((await r.audit()).map((e) => e.action)).toEqual(expect.arrayContaining(["metric.certified", "metric.created"]));
  });
});
