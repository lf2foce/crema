// The only code that touches the customer's database.
// Every statement runs inside a READ ONLY transaction with a statement timeout and is
// always rolled back. Metric SQL must be a single SELECT/WITH statement.
import pg from "pg";
import { validateSql } from "./sqlGuard";
export { SqlContractError } from "./sqlGuard";

// Return numerics/bigints as JS numbers; metric values are aggregates, not ledgers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const pools: Map<string, pg.Pool> = ((globalThis as any).__cremaPools ??= new Map());

function pool(url: string): pg.Pool {
  let p = pools.get(url);
  if (!p) {
    p = new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8_000 });
    p.on("error", () => {}); // idle client errors must not crash the process
    pools.set(url, p);
  }
  return p;
}

export async function closePools() {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}

export class Warehouse {
  constructor(readonly url: string, readonly timeoutMs = 8_000) {}

  async readOnly<T>(fn: (c: pg.PoolClient) => Promise<T>, timeoutMs = this.timeoutMs): Promise<T> {
    const client = await pool(this.url).connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(timeoutMs))}`);
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  async query<R = Record<string, unknown>>(sql: string, params: unknown[] = [], timeoutMs?: number): Promise<R[]> {
    return this.readOnly(async (c) => (await c.query(sql, params)).rows as R[], timeoutMs);
  }
}

// ---------- SQL contract ----------

/** Removes comments and string literals so structural checks can't be fooled by them. */
export function stripSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/** A metric definition is exactly one read query. The READ ONLY transaction is the real guard. */
export function assertSingleSelect(sql: string, mode: "metric" | "editor" = "metric"): string {
  return validateSql(sql, mode);
}

export type Params = { start: string; end: string; at: string };

const PLACEHOLDER = /\{\{\s*(start|end|at)\s*\}\}/g;

export function placeholders(sql: string): Set<string> {
  return new Set([...sql.matchAll(PLACEHOLDER)].map((m) => m[1]));
}

/** Binds the {{start}}/{{end}}/{{at}} placeholders that are used to $1..$n (unused ones are not sent). */
export function bind(sql: string, p: Params): { text: string; values: string[] } {
  const used = (["start", "end", "at"] as const).filter((n) => placeholders(sql).has(n));
  const text = sql.replace(PLACEHOLDER, (_, name: keyof Params) => `$${used.indexOf(name) + 1}::timestamptz`);
  return { text, values: used.map((n) => p[n]) };
}

/**
 * Turns a one-row metric definition into a time series in a single query:
 * each bucket evaluates the definition with its own start/end, and snapshots are taken
 * at the bucket end. Params: $1 first bucket, $2 last bucket, $3 interval, $4 cap (never
 * evaluate the future: the current bucket ends "now").
 */
export function seriesSql(sql: string): string {
  const inner = sql.replace(PLACEHOLDER, (_, name: string) =>
    name === "start" ? "b.bucket_start" : "b.bucket_end",
  );
  return `WITH b AS (
  SELECT s AS bucket_start, least(s + $3::interval, $4::timestamptz) AS bucket_end
  FROM generate_series($1::timestamptz, $2::timestamptz, $3::interval) s
)
SELECT b.bucket_start, m.value
FROM b CROSS JOIN LATERAL (${inner}) m
ORDER BY b.bucket_start`;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteQualified(qualified: string): string {
  const [schema, table] = qualified.includes(".") ? qualified.split(".", 2) : ["public", qualified];
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** Redacts the password of a connection string for display. */
export function describeUrl(url: string): { host: string; database: string; user: string; display: string } {
  try {
    const u = new URL(url);
    const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
    const user = decodeURIComponent(u.username);
    const host = u.hostname + (u.port ? `:${u.port}` : "");
    return { host, database, user, display: `${user ? user + "@" : ""}${host}/${database}` };
  } catch {
    return { host: "?", database: "?", user: "?", display: "postgres" };
  }
}
