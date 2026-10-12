// Ad-hoc reading for people: the SQL editor and the table browser. Same guard as metrics —
// one SELECT/WITH statement, inside a READ ONLY transaction that is always rolled back.
import type { Table } from "./types";
import { assertSingleSelect, bind, placeholders, quoteIdent, quoteQualified, SqlContractError, Warehouse } from "./warehouse";

export type ResultColumn = { name: string; type: string };
export type ResultSet = { columns: ResultColumn[]; rows: unknown[][]; rowCount: number; truncated: boolean; ms: number; bound: Record<string, string> | null };

export class ExploreError extends Error {}

// pg type oids → short names for column headers
const TYPES: Record<number, string> = {
  16: "bool", 17: "bytea", 20: "int8", 21: "int2", 23: "int4", 25: "text", 114: "json", 700: "float4", 701: "float8",
  1042: "char", 1043: "varchar", 1082: "date", 1083: "time", 1114: "timestamp", 1184: "timestamptz", 1186: "interval",
  1700: "numeric", 2950: "uuid", 3802: "jsonb", 1000: "bool[]", 1007: "int4[]", 1009: "text[]", 1016: "int8[]",
};

/** Cells as JSON-safe values: dates as ISO strings, bytes as hex, everything else as pg returned it. */
function cell(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString("hex").slice(0, 64)}${v.length > 32 ? "…" : ""}`;
  return v;
}

export async function runSql(wh: Warehouse, sql: string, limit = 500): Promise<ResultSet> {
  let body: string;
  try { body = assertSingleSelect(sql); } catch (e) {
    if (e instanceof SqlContractError) throw new ExploreError(`${e.message.replace(/^Definition/, "A query")} The editor is read-only: one SELECT or WITH statement at a time.`);
    throw e;
  }
  // Metric SQL can be pasted as is: its period placeholders get the last 30 days.
  const now = new Date(), start = new Date(now.getTime() - 30 * 86_400_000);
  const used = placeholders(body);
  const params = { start: start.toISOString(), end: now.toISOString(), at: now.toISOString() };
  const b = bind(body, params);
  const t0 = Date.now();
  const res = await wh.readOnly((c) => c.query({ text: `SELECT * FROM (${b.text}\n) AS creama_q LIMIT ${limit + 1}`, values: b.values, rowMode: "array" }), 15_000);
  const rows = (res.rows as unknown[][]).map((r) => r.map(cell));
  return {
    columns: res.fields.map((f) => ({ name: f.name, type: TYPES[f.dataTypeID] ?? `oid ${f.dataTypeID}` })),
    rows: rows.slice(0, limit),
    rowCount: Math.min(rows.length, limit),
    truncated: rows.length > limit,
    ms: Date.now() - t0,
    bound: used.size ? Object.fromEntries([...used].map((k) => [k, params[k as keyof typeof params]])) : null,
  };
}

export async function tableRows(wh: Warehouse, t: Table, opts: { limit?: number; offset?: number; order?: string | null; dir?: string | null }) {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  if (opts.order && !t.columns.some((c) => c.name === opts.order)) throw new ExploreError(`No column “${opts.order}” on ${t.qualified}.`);
  const dir = opts.dir === "desc" ? "DESC" : "ASC";
  // Stable pages: the chosen column, then the primary key as a tiebreaker.
  const keys = [...(opts.order ? [`${quoteIdent(opts.order)} ${dir} NULLS LAST`] : []), ...t.primaryKey.filter((k) => k !== opts.order).map((k) => `${quoteIdent(k)} ASC`)];
  const from = quoteQualified(t.qualified);
  const t0 = Date.now();
  const { res, total, exact } = await wh.readOnly(async (c) => {
    const res = await c.query({ text: `SELECT * FROM ${from}${keys.length ? ` ORDER BY ${keys.join(", ")}` : ""} LIMIT $1 OFFSET $2`, values: [limit, offset], rowMode: "array" });
    // exact counts are cheap on small tables; big ones keep the planner's estimate
    if (t.estimatedRows > 250_000) return { res, total: t.estimatedRows, exact: false };
    const n = await c.query(`SELECT count(*)::int8 AS n FROM ${from}`);
    return { res, total: Number(n.rows[0].n), exact: true };
  }, 15_000);
  return {
    table: t.qualified,
    columns: res.fields.map((f) => ({ name: f.name, type: TYPES[f.dataTypeID] ?? `oid ${f.dataTypeID}` })),
    rows: (res.rows as unknown[][]).map((r) => r.map(cell)),
    total, exact, limit, offset,
    ms: Date.now() - t0,
  };
}
