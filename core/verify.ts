// Data checks the model. Every candidate is executed against the real database and
// inspected by deterministic rules; the model's own confidence is never the last word.
import { createHash } from "node:crypto";
import type { CandidateSpec, Check, SchemaSnapshot, SeriesPoint, Table, Verification } from "./types";
import { assertSingleSelect, bind, placeholders, seriesSql, stripSql, Warehouse, type Params } from "./warehouse";
import { findTable } from "./schema";
import { fmt } from "./format";

export { fmt };

export interface Windows {
  now: Date;
  current: Params; // trailing 30 days for flows, `at` = now for snapshots
  seriesFrom: string;
  seriesTo: string;
  step: string;
}

export function windows(now = new Date()): Windows {
  const n = new Date(now);
  n.setUTCMinutes(0, 0, 0);
  const start = new Date(n.getTime() - 30 * 86_400_000);
  const from = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 12, 1));
  const to = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1));
  return {
    now: n,
    current: { start: start.toISOString(), end: n.toISOString(), at: n.toISOString() },
    seriesFrom: from.toISOString(),
    seriesTo: to.toISOString(),
    step: "1 month",
  };
}

type Def = Pick<CandidateSpec, "kind" | "unit" | "sql" | "membersSql" | "memberTable">;

export async function verify(wh: Warehouse, def: Def, schema: SchemaSnapshot, w = windows()): Promise<Verification> {
  const t0 = Date.now();
  const checks: Check[] = [];
  const base: Verification = {
    ok: false, error: null, value: null, window: { start: w.current.start, end: w.current.end },
    series: [], members: null, membersTotal: null, relations: [], checks, ms: 0,
  };
  const fail = (msg: string) => ({ ...base, error: msg, ms: Date.now() - t0 });

  let sql: string;
  try {
    sql = assertSingleSelect(def.sql);
  } catch (e) {
    checks.push({ id: "contract", level: "fail", message: (e as Error).message });
    return fail((e as Error).message);
  }
  contractChecks(sql, def, checks);
  if (checks.some((c) => c.level === "fail")) return fail(checks.find((c) => c.level === "fail")!.message);

  // current value
  const bound = bind(sql, w.current);
  try {
    const rows = await wh.query<Record<string, unknown>>(bound.text, bound.values);
    if (rows.length !== 1 || !("value" in rows[0])) {
      const msg = `Must return exactly one row with a column named value (got ${rows.length} row(s)${rows[0] ? ", columns: " + Object.keys(rows[0]).join(", ") : ""}).`;
      checks.push({ id: "shape", level: "fail", message: msg });
      return fail(msg);
    }
    base.value = toNumber(rows[0].value);
  } catch (e) {
    const msg = pgError(e);
    checks.push({ id: "executes", level: "fail", message: `Fails on your database: ${msg}` });
    return fail(msg);
  }
  checks.push({ id: "executes", level: "pass", message: "Runs on your database in a read-only transaction." });

  // series
  try {
    const rows = await wh.query<{ bucket_start: Date; value: unknown }>(seriesSql(sql), [w.seriesFrom, w.seriesTo, w.step, w.current.end], 15_000);
    base.series = rows.map((r) => ({ start: new Date(r.bucket_start).toISOString(), value: toNumber(r.value) }));
  } catch (e) {
    checks.push({ id: "series", level: "warn", message: `Could not compute history: ${pgError(e)}` });
  }

  // relations actually touched (from the planner, not from parsing)
  try {
    const plan = await wh.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (VERBOSE, FORMAT JSON) ${bound.text}`, bound.values);
    base.relations = relationsFromPlan(plan[0]["QUERY PLAN"]);
  } catch {
    /* non-fatal */
  }

  // members: the rows that make up the number
  if (def.membersSql) {
    try {
      const msql = assertSingleSelect(def.membersSql);
      const hasValue = await membersHaveValue(wh, msql, w);
      const mb = bind(`SELECT count(*)::int AS n, sum(${hasValue ? "coalesce(m.value, 0)" : "1"})::float8 AS total FROM (${msql}) m`, w.current);
      const [r] = await wh.query<{ n: number; total: number | null }>(mb.text, mb.values);
      base.members = r.n;
      base.membersTotal = r.total ?? 0;
      if (base.value !== null) {
        const close = Math.abs(base.membersTotal - base.value) <= Math.max(0.005 * Math.abs(base.value), 0.01);
        const what = def.unit === "count" ? fmt(base.value) : "this number";
        if (close) checks.push({ id: "members", level: "pass", message: `Traceable: ${what} is made of ${fmt(r.n)} individual rows you can inspect.` });
        else checks.push({ id: "members", level: "warn", message: `The row-level trace adds up to ${fmt(Math.round(base.membersTotal * 100) / 100)}, not ${fmt(Math.round(base.value * 100) / 100)}: differences can't be fully traced.` });
      }
    } catch (e) {
      checks.push({ id: "members", level: "warn", message: `Row-level trace failed: ${pgError(e)}` });
    }
  }

  dataChecks(sql, def, base, schema, checks);
  base.ok = true;
  base.ms = Date.now() - t0;
  return base;
}

/** Whether a members query returns a per-row contribution column (`value`) or just ids. */
export async function membersHaveValue(wh: Warehouse, membersSql: string, w: Windows): Promise<boolean> {
  const b = bind(`SELECT * FROM (${membersSql}) m LIMIT 0`, w.current);
  const cols = await wh.readOnly(async (c) => (await c.query(b.text, b.values)).fields.map((f) => f.name));
  if (!cols.includes("id")) throw new Error("members SQL must return a column named id");
  return cols.includes("value");
}

function contractChecks(sql: string, def: Def, checks: Check[]) {
  const bare = stripSql(sql).toLowerCase();
  const ph = placeholders(sql);
  if (/\b(now\s*\(|current_date|current_timestamp|localtimestamp|clock_timestamp)/.test(bare))
    checks.push({ id: "reproducible", level: "fail", message: "Uses the current time, so history can't be recomputed. Use {{start}}/{{end}} or {{at}}." });
  if (def.kind === "flow" && !(ph.has("start") && ph.has("end")))
    checks.push({ id: "window", level: "fail", message: "A flow metric must filter its time column with {{start}} and {{end}}." });
  if (def.kind === "snapshot" && !ph.has("at"))
    checks.push({ id: "window", level: "warn", message: "A snapshot without {{at}} returns today's state for every point in history." });
  if (!checks.length) checks.push({ id: "reproducible", level: "pass", message: "Reproducible for any period: no dependence on the current time." });
}

const SOFT_DELETE = /^(deleted_at|archived_at|removed_at|is_deleted|deleted|is_archived)$/;
const INTERNAL = /^(is_)?(internal|test|demo|sandbox|fake|staff|employee)(_account|_user)?$/;

function dataChecks(sql: string, def: Def, v: Verification, schema: SchemaSnapshot, checks: Check[]) {
  const bare = stripSql(sql).toLowerCase();
  const mentions = (col: string) => new RegExp(`\\b${col.toLowerCase()}\\b`).test(bare);
  const touched = v.relations.map((r) => findTable(schema.tables, r)).filter(Boolean) as Table[];
  const prof = (t: Table) => schema.profiles.find((p) => p.table === t.qualified);
  const flagged = new Set<string>();

  for (const t of touched) {
    const p = prof(t);
    for (const c of t.columns) {
      const cp = p?.columns.find((x) => x.column === c.name);
      if (SOFT_DELETE.test(c.name) && !mentions(c.name)) {
        const set = cp ? Math.round((1 - cp.nullFraction) * (p?.rows ?? 0)) : null;
        if (c.type === "boolean" || set) {
          const counted = def.memberTable === t.qualified;
          const what = `${c.name}${set && c.type !== "boolean" ? `, set on ${fmt(set)} rows` : ""}`;
          checks.push(counted
            ? { id: `softdelete:${t.qualified}`, level: "warn", message: `Counts soft-deleted ${t.name} too (${what}).` }
            : { id: `softdelete:${t.qualified}`, level: "info", message: `Includes rows linked to soft-deleted ${t.name} (${what}): usually right for historical totals, wrong for current state.` });
        }
      }
      if (INTERNAL.test(c.name) && !mentions(c.name) && !flagged.has(`${t.qualified}.${c.name}`)) {
        flagged.add(`${t.qualified}.${c.name}`);
        const yes = cp?.topValues?.find((x) => x.value === "true")?.count;
        checks.push({ id: `internal:${t.qualified}`, level: "warn",
          message: `Includes internal/test rows: ${t.name}.${c.name} is not filtered${yes ? ` (${fmt(yes)} rows are true)` : ""}.` });
      }
      if (/^currency(_code)?$/.test(c.name) && cp) {
        if ((cp.distinct ?? 0) > 1 && !mentions(c.name))
          checks.push({ id: `currency:${t.qualified}`, level: "warn", message: `Adds amounts across ${cp.distinct} currencies in ${t.name}.${c.name} without converting.` });
        else if (cp.distinct === 1)
          checks.push({ id: `currency:${t.qualified}`, level: "pass", message: `Single currency in ${t.name} (${cp.topValues?.[0]?.value ?? "one value"}).` });
      }
    }
    // one hop: an internal/test flag on a parent this table belongs to, which the query never joins
    for (const fk of t.foreignKeys) {
      const parent = findTable(schema.tables, fk.refTable);
      if (!parent || touched.includes(parent)) continue;
      const flag = parent.columns.find((c) => INTERNAL.test(c.name));
      if (flag && !flagged.has(`${parent.qualified}.${flag.name}`)) {
        flagged.add(`${parent.qualified}.${flag.name}`);
        const yes = prof(parent)?.columns.find((x) => x.column === flag.name)?.topValues?.find((x) => x.value === "true")?.count;
        checks.push({ id: `internal:${parent.qualified}`, level: "info",
          message: `${t.name} is not joined to ${parent.name}, so ${parent.name}.${flag.name}${yes ? ` (${fmt(yes)} rows)` : ""} is not considered.` });
      }
    }
  }

  const cents = [...bare.matchAll(/\b(\w+_cents)\b/g)].map((m) => m[1]);
  if (cents.length && def.unit !== "percent") {
    if (/\/\s*100(\.0+)?\b/.test(bare) || /\*\s*0?\.01\b/.test(bare)) checks.push({ id: "units", level: "pass", message: "Converts cents to currency units." });
    else if (v.relations.length) checks.push({ id: "units", level: "warn", message: `Uses ${[...new Set(cents)].join(", ")} without dividing by 100: the result is in cents.` });
  }

  if (v.value === null) checks.push({ id: "value", level: "warn", message: "Returns NULL for the latest period." });
  else if (v.value === 0) checks.push({ id: "value", level: "warn", message: "Returns 0 for the latest period." });

  const vals = v.series.map((p) => p.value).filter((x): x is number => x !== null);
  if (vals.length >= 6 && new Set(vals).size === 1)
    checks.push({ id: "history", level: "warn", message: `Flat at ${fmt(vals[0])} for ${vals.length} months: history may not be reconstructable.` });
}

export function relationsFromPlan(plan: unknown): string[] {
  const out = new Set<string>();
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n["Relation Name"]) out.add(`${n["Schema"] ?? "public"}.${n["Relation Name"]}`);
    for (const k of Object.keys(n)) if (typeof n[k] === "object") walk(n[k]);
  };
  walk(plan);
  return [...out].sort();
}

/** Shape of every relation a definition depends on, to detect drift after certification. */
export function fingerprint(relations: string[], tables: Table[]): Record<string, string> {
  const fp: Record<string, string> = {};
  for (const r of relations) {
    const t = findTable(tables, r);
    fp[r] = t
      ? createHash("sha256").update(t.columns.map((c) => `${c.name}:${c.type}`).sort().join("|")).digest("hex").slice(0, 16)
      : "missing";
  }
  return fp;
}

export function driftedRelations(saved: Record<string, string>, tables: Table[]): string[] {
  const now = fingerprint(Object.keys(saved), tables);
  return Object.keys(saved).filter((r) => saved[r] !== now[r]);
}

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function pgError(e: unknown): string {
  const err = e as { message?: string; position?: string };
  return (err.message ?? String(e)).replace(/\s+/g, " ").slice(0, 300);
}


export type { SeriesPoint };
