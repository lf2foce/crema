// Schema understanding: catalog introspection + column statistics.
// The profile is what the model sees, so the privacy boundary lives here:
// values are only collected for low-cardinality, non-identifying columns.
import type { ColumnProfile, SchemaSnapshot, Table, TableProfile } from "./types";
import { quoteIdent, quoteQualified, Warehouse } from "./warehouse";

export async function introspect(wh: Warehouse): Promise<Table[]> {
  const rows = await wh.query<{
    schema: string; name: string; relkind: string; comment: string | null; est: number;
    columns: { name: string; type: string; nullable: boolean; comment: string | null }[];
    pk: string[] | null;
    fks: { columns: string[]; ref_table: string; ref_columns: string[] }[] | null;
  }>(`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind,
           obj_description(c.oid, 'pg_class') AS comment,
           greatest(c.reltuples, 0)::bigint AS est,
           (SELECT json_agg(json_build_object(
                     'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                     'nullable', NOT a.attnotnull, 'comment', col_description(c.oid, a.attnum))
                   ORDER BY a.attnum)
              FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
           (SELECT array_agg(a.attname::text ORDER BY array_position(con.conkey, a.attnum))
              FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
             WHERE con.conrelid = c.oid AND con.contype = 'p') AS pk,
           (SELECT json_agg(json_build_object(
                     'columns', (SELECT array_agg(a.attname ORDER BY array_position(con.conkey, a.attnum))
                                   FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)),
                     'ref_table', rn.nspname || '.' || rc.relname,
                     'ref_columns', (SELECT array_agg(a.attname ORDER BY array_position(con.confkey, a.attnum))
                                       FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attnum = ANY(con.confkey))))
              FROM pg_constraint con
              JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
             WHERE con.conrelid = c.oid AND con.contype = 'f') AS fks
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND NOT c.relispartition
      AND has_table_privilege(c.oid, 'SELECT')
    ORDER BY n.nspname, c.relname`);

  return rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    qualified: `${r.schema}.${r.name}`,
    kind: r.relkind === "v" || r.relkind === "m" ? "view" : "table",
    comment: r.comment,
    estimatedRows: Number(r.est),
    primaryKey: r.pk ?? [],
    columns: r.columns ?? [],
    foreignKeys: (r.fks ?? []).map((f) => ({ columns: f.columns, refTable: f.ref_table, refColumns: f.ref_columns })),
  }));
}

/** Columns whose values identify people or are secrets: never sampled, whatever their cardinality. */
const IDENTIFYING = /(e_?mail|phone|mobile|password|passwd|secret|token|api_?key|ssn|social|passport|iban|card|address|street|postal|zip|birth|dob|ip_?addr|^ip$|first_?name|last_?name|full_?name|username|^lat(itude)?$|^lng$|^lon(gitude)?$)/i;
const TINY_TABLE = 60; // lookup/config tables: values are configuration, not people
const MAX_DISTINCT = 25;

function typeClass(type: string): "text" | "bool" | "number" | "time" | "other" {
  if (/^(text|character|varchar|char|citext|name|"char")/.test(type) || type.startsWith("USER-DEFINED")) return "text";
  if (type === "boolean") return "bool";
  if (/^(smallint|integer|bigint|numeric|real|double|decimal|money)/.test(type)) return "number";
  if (/^(timestamp|date|time)/.test(type)) return "time";
  return "other";
}

export async function profileTable(wh: Warehouse, t: Table, isIdentifying = (col: string) => IDENTIFYING.test(col) && !/_id$/.test(col)): Promise<TableProfile> {
  const rel = quoteQualified(t.qualified);
  const sampled = t.estimatedRows > 500_000;
  const from = sampled ? `${rel} TABLESAMPLE SYSTEM (${Math.max(0.1, (200_000 / t.estimatedRows) * 100).toFixed(2)})` : rel;

  const cols = t.columns.map((c) => ({ c, cls: typeClass(c.type), q: quoteIdent(c.name) }));
  const aggs = ["count(*) AS n"];
  cols.forEach(({ cls, q }, i) => {
    aggs.push(`count(${q}) AS nn${i}`);
    if (cls !== "other") aggs.push(`count(DISTINCT ${q}) AS d${i}`);
    if (cls === "number" || cls === "time") aggs.push(`min(${q})::text AS mn${i}`, `max(${q})::text AS mx${i}`);
  });
  const [stats] = await wh.query<Record<string, any>>(`SELECT ${aggs.join(", ")} FROM ${from}`, [], 20_000);
  const n = Number(stats.n);
  const rows = sampled ? t.estimatedRows : n;

  const profiles: ColumnProfile[] = [];
  for (const [i, { c, cls, q }] of cols.entries()) {
    const nonNull = Number(stats[`nn${i}`]);
    const distinct = stats[`d${i}`] == null ? null : Number(stats[`d${i}`]);
    const p: ColumnProfile = { column: c.name, type: c.type, nullFraction: n ? 1 - nonNull / n : 0, distinct };
    if (cls === "number" || cls === "time") {
      p.min = stats[`mn${i}`];
      p.max = stats[`mx${i}`];
    }
    const lowCard = distinct !== null && distinct <= MAX_DISTINCT && (n <= TINY_TABLE || distinct / Math.max(nonNull, 1) < 0.5);
    if (cls === "other") p.withheld = "unsupported_type";
    else if (isIdentifying(c.name)) p.withheld = "identifying";
    else if ((cls === "text" || cls === "bool" || cls === "number") && lowCard && t.primaryKey[0] !== c.name) {
      const top = await wh.query<{ v: string | null; n: number }>(
        `SELECT ${q}::text AS v, count(*)::int AS n FROM ${from} GROUP BY 1 ORDER BY 2 DESC LIMIT ${MAX_DISTINCT}`,
      );
      p.topValues = top.map((r) => ({ value: r.v, count: sampled ? Math.round(r.n * (rows / Math.max(n, 1))) : r.n }));
    } else if (cls === "text" || cls === "bool") p.withheld = "high_cardinality";
    profiles.push(p);
  }
  return { table: t.qualified, rows, sampled, columns: profiles };
}

export async function snapshot(wh: Warehouse, onTable?: (t: Table, p: TableProfile) => void): Promise<SchemaSnapshot> {
  const tables = await introspect(wh);
  const profiles: TableProfile[] = [];
  for (const t of tables) {
    const p = await profileTable(wh, t);
    profiles.push(p);
    onTable?.(t, p);
  }
  return { tables, profiles };
}

/** Exactly what the model receives. Kept compact; stored with the run so users can inspect it. */
export function modelPayload(s: SchemaSnapshot) {
  return s.tables.map((t) => {
    const prof = s.profiles.find((p) => p.table === t.qualified);
    return {
      table: t.qualified,
      kind: t.kind,
      comment: t.comment ?? undefined,
      rows: prof?.rows ?? t.estimatedRows,
      primary_key: t.primaryKey,
      foreign_keys: t.foreignKeys.map((f) => `${f.columns.join(",")} -> ${f.refTable}(${f.refColumns.join(",")})`),
      columns: t.columns.map((c) => {
        const cp = prof?.columns.find((x) => x.column === c.name);
        const out: Record<string, unknown> = { name: c.name, type: c.type };
        if (c.comment) out.comment = c.comment;
        if (cp) {
          if (cp.nullFraction > 0) out.null_pct = Math.round(cp.nullFraction * 1000) / 10;
          if (cp.distinct !== null) out.distinct = cp.distinct;
          if (cp.min != null) out.min = cp.min;
          if (cp.max != null) out.max = cp.max;
          if (cp.topValues) out.values = Object.fromEntries(cp.topValues.map((v) => [v.value ?? "NULL", v.count]));
          if (cp.withheld === "identifying") out.values = "withheld (identifying)";
        }
        return out;
      }),
    };
  });
}

export function findTable(tables: Table[], name: string): Table | undefined {
  const n = name.replace(/"/g, "").toLowerCase();
  return tables.find((t) => t.qualified.toLowerCase() === n) ?? tables.find((t) => t.name.toLowerCase() === n);
}
