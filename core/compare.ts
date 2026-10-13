// When two plausible definitions disagree, show by how much, which rows cause it,
// and what those rows have in common. Deterministic; rows never leave the server.
//
// Each definition can list the rows that make up its number (id + contribution). Two lists over
// the same table split the gap into three parts: rows only A counts, rows only B counts, and rows
// both count with a different contribution (e.g. annual plans normalised differently).
import { display } from "./format";
import { findTable } from "./schema";
import type { Candidate, Comparison, DiffPart, MemberDiff, SchemaSnapshot, Table } from "./types";
import { fmt, membersHaveValue, windows, type Windows } from "./verify";
import { assertSingleSelect, bind, quoteIdent, quoteQualified, Warehouse } from "./warehouse";

const MAX_IDS = 5000;
const IDENTIFYING = /(e_?mail|phone|password|secret|token|address|full_?name|first_?name|last_?name)/i;

export async function compare(wh: Warehouse, candidates: Candidate[], schema: SchemaSnapshot, w: Windows = windows()): Promise<Comparison> {
  const values = candidates.map((c) => (c.verification?.ok ? c.verification.value : null)).filter((v): v is number => v !== null);
  const hi = Math.max(...values.map(Math.abs));
  const spread = values.length >= 2 && hi > 0 ? (Math.max(...values) - Math.min(...values)) / hi : values.length >= 2 ? 0 : null;

  const diffs: MemberDiff[] = [];
  for (let a = 0; a < candidates.length; a++) {
    for (let b = a + 1; b < candidates.length; b++) {
      const A = candidates[a], B = candidates[b];
      if (!A.verification?.ok || !B.verification?.ok || !A.membersSql || !B.membersSql) continue;
      const ta = A.memberTable ? findTable(schema.tables, A.memberTable) : undefined;
      const tb = B.memberTable ? findTable(schema.tables, B.memberTable) : undefined;
      if (!ta || ta !== tb || ta.primaryKey.length !== 1) continue;
      try {
        diffs.push(await diffMembers(wh, A, B, a, b, ta, schema, w));
      } catch (e) {
        // a failing diff must not hide the comparison of values
        if (process.env.CREMA_DEBUG || process.env.CREAMA_DEBUG) console.error("diff failed", e);
      }
    }
  }
  return { spread, diffs };
}

async function diffMembers(wh: Warehouse, A: Candidate, B: Candidate, a: number, b: number, table: Table, schema: SchemaSnapshot, w: Windows): Promise<MemberDiff> {
  const ma = assertSingleSelect(A.membersSql!), mb = assertSingleSelect(B.membersSql!);
  const va = (await membersHaveValue(wh, ma, w)) ? "coalesce(x.value, 0)" : "1";
  const vb = (await membersHaveValue(wh, mb, w)) ? "coalesce(y.value, 0)" : "1";
  const q = bind(
    `WITH a AS (SELECT x.id::text AS id, sum(${va})::float8 AS v FROM (${ma}) x GROUP BY 1),
          b AS (SELECT y.id::text AS id, sum(${vb})::float8 AS v FROM (${mb}) y GROUP BY 1),
          j AS (SELECT coalesce(a.id, b.id) AS id, a.v AS av, b.v AS bv FROM a FULL JOIN b ON a.id = b.id),
          k AS (SELECT *, CASE WHEN bv IS NULL THEN 'a' WHEN av IS NULL THEN 'b'
                               WHEN abs(av - bv) > 1e-6 * greatest(abs(av), abs(bv), 1) THEN 'c' ELSE 's' END AS part FROM j)
     SELECT part, count(*)::int AS n, coalesce(sum(coalesce(bv, 0) - coalesce(av, 0)), 0)::float8 AS amount,
            (array_agg(id ORDER BY md5(id)))[1:${MAX_IDS}] AS ids
     FROM k GROUP BY part`,
    w.current,
  );
  const rows = await wh.query<{ part: "a" | "b" | "c" | "s"; n: number; amount: number; ids: string[] }>(q.text, q.values, 15_000);
  const get = (p: string) => rows.find((r) => r.part === p) ?? { n: 0, amount: 0, ids: [] as string[] };
  const onlyA = get("a"), onlyB = get("b"), changed = get("c"), same = get("s");
  const unit = A.unit;
  const feats = features(table, schema);

  const part = async (p: { n: number; amount: number; ids: string[] }, ref: string[], lead: (n: string) => string): Promise<DiffPart> => {
    if (!p.n) return { rows: 0, amount: 0, explain: null, sample: [] };
    const common = await explain(wh, feats, p.ids, ref);
    return {
      rows: p.n,
      amount: p.amount,
      explain: `${lead(`${fmt(p.n)} ${plural(table.name, p.n)}`)} ${common ?? `No single column on ${table.name} or the tables it links to explains why; see the examples.`}`,
      sample: await sample(wh, table, p.ids.slice(0, 5)),
    };
  };

  const gap = (x: number) => (unit === "count" ? "" : ` (${display(Math.abs(x), unit, { compact: false })} of the gap)`);
  const both = [...same.ids, ...changed.ids];
  return {
    a, b, table: table.qualified,
    both: same.n + changed.n,
    onlyA: await part(onlyA, both, (n) => `${n} are counted only by “${A.label}”${gap(onlyA.amount)}.`),
    onlyB: await part(onlyB, both, (n) => `${n} are counted only by “${B.label}”${gap(onlyB.amount)}.`),
    changed: await part(changed, same.ids, (n) =>
      `${n} are in both, but “${B.label}” values them ${display(Math.abs(changed.amount), unit, { compact: false })} ${changed.amount >= 0 ? "higher" : "lower"} in total.`),
  };
}

const plural = (name: string, n: number) => (n === 1 ? name.replace(/s$/, "") : name);

interface Feature { describe: (v: string) => string; sql: string }

/**
 * Things rows might have in common: their own low-cardinality columns and nullable timestamps,
 * the columns of the rows they point to (parents), and of the rows pointing at them (children).
 */
function features(table: Table, schema: SchemaSnapshot): Feature[] {
  const pk = quoteIdent(table.primaryKey[0]);
  const rel = quoteQualified(table.qualified);
  const profile = (t: Table) => schema.profiles.find((p) => p.table === t.qualified);
  const lowCard = (t: Table) => t.columns.filter((c) => {
    const cp = profile(t)?.columns.find((x) => x.column === c.name);
    return Boolean(cp?.topValues && cp.topValues.length > 1 && !t.primaryKey.includes(c.name));
  });
  const lit = (type: string, v: string) => (type === "boolean" || /^(integer|bigint|smallint|numeric)/.test(type) ? v : `'${v}'`);
  const out: Feature[] = [];

  for (const c of lowCard(table)) {
    out.push({ describe: (v) => `${c.name} = ${lit(c.type, v)}`,
      sql: `SELECT ${quoteIdent(c.name)}::text AS v, count(*)::int AS n FROM ${rel} WHERE ${pk}::text = ANY($1) GROUP BY 1` });
  }
  for (const c of table.columns) {
    const cp = profile(table)?.columns.find((x) => x.column === c.name);
    if (/^timestamp|^date/.test(c.type) && cp && cp.nullFraction > 0 && cp.nullFraction < 1)
      out.push({ describe: (v) => (v === "true" ? `${c.name} set` : `no ${c.name}`),
        sql: `SELECT (${quoteIdent(c.name)} IS NOT NULL)::text AS v, count(*)::int AS n FROM ${rel} WHERE ${pk}::text = ANY($1) GROUP BY 1` });
  }
  // parents: subscriptions → plans.billing_interval, subscriptions → accounts.is_internal
  for (const fk of table.foreignKeys) {
    const parent = findTable(schema.tables, fk.refTable);
    if (!parent || fk.columns.length !== 1 || parent.primaryKey.length !== 1) continue;
    for (const c of lowCard(parent)) {
      out.push({ describe: (v) => `${parent.name}.${c.name} = ${lit(c.type, v)}`,
        sql: `SELECT p.${quoteIdent(c.name)}::text AS v, count(*)::int AS n FROM ${rel} m JOIN ${quoteQualified(parent.qualified)} p ON p.${quoteIdent(parent.primaryKey[0])} = m.${quoteIdent(fk.columns[0])} WHERE m.${pk}::text = ANY($1) GROUP BY 1` });
    }
  }
  // children: accounts ← subscriptions.status
  for (const child of schema.tables) {
    for (const fk of child.foreignKeys) {
      if (fk.refTable !== table.qualified || fk.columns.length !== 1) continue;
      const fkq = quoteIdent(fk.columns[0]);
      for (const c of lowCard(child)) {
        if (c.name === fk.columns[0]) continue;
        out.push({ describe: (v) => `a ${child.name.replace(/s$/, "")} with ${c.name} = ${lit(c.type, v)}`,
          sql: `SELECT ${quoteIdent(c.name)}::text AS v, count(DISTINCT ${fkq})::int AS n FROM ${quoteQualified(child.qualified)} WHERE ${fkq}::text = ANY($1) GROUP BY 1` });
      }
    }
  }
  return out.slice(0, 32);
}

/** The feature most over-represented in `set` compared with `ref`, as a sentence. */
async function explain(wh: Warehouse, feats: Feature[], set: string[], ref: string[]): Promise<string | null> {
  let best: { lift: number; share: number; refShare: number; text: string } | null = null;
  for (const f of feats) {
    try {
      const [inSet, inRef] = await Promise.all([
        wh.query<{ v: string | null; n: number }>(f.sql, [set]),
        ref.length ? wh.query<{ v: string | null; n: number }>(f.sql, [ref]) : Promise.resolve([]),
      ]);
      for (const row of inSet) {
        if (row.v === null) continue;
        const share = row.n / set.length;
        const refShare = ref.length ? (inRef.find((x) => x.v === row.v)?.n ?? 0) / ref.length : 0;
        const lift = share - refShare;
        if (share >= 0.5 && lift > 0.25 && (!best || lift > best.lift + 1e-9)) best = { lift, share, refShare, text: f.describe(row.v) };
      }
    } catch {
      /* skip feature */
    }
  }
  if (!best) return null;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return `${pct(best.share)} of them have ${best.text}${ref.length ? `, versus ${pct(best.refShare)} of the rest` : ""}.`;
}

async function sample(wh: Warehouse, table: Table, ids: string[]) {
  if (!ids.length) return [];
  const pk = quoteIdent(table.primaryKey[0]);
  const cols = table.columns.filter((c) => !IDENTIFYING.test(c.name) && !/json/.test(c.type)).slice(0, 8).map((c) => quoteIdent(c.name));
  return wh.query(`SELECT ${cols.join(", ")} FROM ${quoteQualified(table.qualified)} WHERE ${pk}::text = ANY($1) ORDER BY ${pk} LIMIT 5`, [ids]);
}
