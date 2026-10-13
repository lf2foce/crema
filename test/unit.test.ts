import { dbNameProblem, naturalDbName } from "../lib/dbName";
import { afterEach, describe, expect, it } from "vitest";
import { display, setCurrency } from "../core/format";
import { driftedRelations, fingerprint, relationsFromPlan } from "../core/verify";
import { assertSingleSelect, bind, placeholders, seriesSql, SqlContractError } from "../core/warehouse";
import type { Table } from "../core/types";

describe("SQL contract", () => {
  it("accepts one SELECT/WITH and strips a trailing semicolon", () => {
    expect(assertSingleSelect("select 1 as value;")).toBe("select 1 as value");
    expect(assertSingleSelect("WITH x AS (SELECT 1) SELECT * FROM x")).toMatch(/^WITH/);
  });
  it("rejects writes, multiple statements and positional params", () => {
    expect(() => assertSingleSelect("delete from t")).toThrow(SqlContractError);
    expect(() => assertSingleSelect("select 1; drop table t")).toThrow(/single statement/);
    expect(() => assertSingleSelect("select $1 as value")).toThrow(/\{\{start\}\}/);
  });
  it("is not fooled by semicolons inside literals or comments", () => {
    expect(() => assertSingleSelect("select ';' as value -- ; drop")).not.toThrow();
  });
  it("binds only the placeholders that are used", () => {
    const b = bind("select 1 where t >= {{start}} and t < {{end}}", { start: "s", end: "e", at: "a" });
    expect(b.text).toBe("select 1 where t >= $1::timestamptz and t < $2::timestamptz");
    expect(b.values).toEqual(["s", "e"]);
    const at = bind("select 1 where t <= {{ at }}", { start: "s", end: "e", at: "a" });
    expect(at).toEqual({ text: "select 1 where t <= $1::timestamptz", values: ["a"] });
    expect([...placeholders("{{start}} {{end}} {{at}}")]).toEqual(["start", "end", "at"]);
  });
  it("uses AST checks for nested writes, locks, functions and quoted SQL", () => {
    for (const sql of [
      "WITH x AS (DELETE FROM t RETURNING *) SELECT count(*) FROM x",
      "SELECT * FROM t FOR UPDATE", "SELECT 1 INTO t", "SELECT pg_sleep(10)",
      "SELECT public.count(*) FROM t", "SELECT 'x'::public.dangerous_type",
    ]) expect(() => assertSingleSelect(sql)).toThrow(SqlContractError);
    // Unsupported PostgreSQL syntax fails closed rather than falling back to regex.
    expect(() => assertSingleSelect("SELECT $$a;b$$ AS value")).toThrow(SqlContractError);
    expect(assertSingleSelect("SELECT count(*) FROM t WHERE created_at >= {{start}} AND created_at < {{ end }}")).toContain("{{start}}");
    expect(() => assertSingleSelect("select '{{at}}' as value")).toThrow(SqlContractError);
  });
  it("lets metrics use common date and text functions, and the editor read freely but not act", () => {
    for (const sql of [
      "SELECT count(DISTINCT concat(a, b)) AS value FROM t WHERE date(created_at) >= {{start}}",
      "SELECT max(to_timestamp(ts)) AS value FROM t",
      "SELECT count(*) AS value FROM generate_series({{start}}, {{end}}, interval '1 day') d",
    ]) expect(() => assertSingleSelect(sql)).not.toThrow();
    expect(() => assertSingleSelect("SELECT now() AS value")).toThrow(SqlContractError);
    expect(() => assertSingleSelect("SELECT version()")).toThrow(SqlContractError);
    expect(assertSingleSelect("SELECT version(), public.my_report(1), pg_size_pretty(1)", "editor")).toContain("version()");
    for (const sql of ["SELECT pg_sleep(10)", "SELECT pg_terminate_backend(1)", "SELECT set_config('a', 'b', false)", "SELECT pg_read_file('/etc/passwd')", "SELECT dblink('x', 'y')"]) {
      expect(() => assertSingleSelect(sql, "editor")).toThrow(SqlContractError);
    }
    expect(() => assertSingleSelect("DELETE FROM t", "editor")).toThrow(SqlContractError);
  });
  it("evaluates every bucket of a series lateral to the bucket, never past the cap", () => {
    const s = seriesSql("select count(*) as value from t where c >= {{start}} and c < {{end}}");
    expect(s).toContain("c >= b.bucket_start and c < b.bucket_end");
    expect(s).toContain("least(s + $3::interval, $4::timestamptz)");
  });
});

describe("drift", () => {
  const t = (cols: [string, string][]): Table => ({
    schema: "public", name: "x", qualified: "public.x", kind: "table", comment: null, estimatedRows: 0,
    primaryKey: ["id"], foreignKeys: [], columns: cols.map(([name, type]) => ({ name, type, nullable: true, comment: null })),
  });
  it("detects a changed, added or dropped column and a dropped table", () => {
    const fp = fingerprint(["public.x"], [t([["id", "integer"], ["amount", "integer"]])]);
    expect(driftedRelations(fp, [t([["amount", "integer"], ["id", "integer"]])])).toEqual([]);
    expect(driftedRelations(fp, [t([["id", "integer"], ["amount", "numeric"]])])).toEqual(["public.x"]);
    expect(driftedRelations(fp, [t([["id", "integer"]])])).toEqual(["public.x"]);
    expect(driftedRelations(fp, [])).toEqual(["public.x"]);
  });
  it("reads relations from an EXPLAIN plan", () => {
    const plan = [{ Plan: { Plans: [{ "Relation Name": "invoices", Schema: "public" }, { Plans: [{ "Relation Name": "accounts", Schema: "public" }] }] } }];
    expect(relationsFromPlan(plan)).toEqual(["public.accounts", "public.invoices"]);
  });
});

describe("display", () => {
  afterEach(() => setCurrency("VND"));
  it("formats units", () => {
    expect(display(0.0064, "percent")).toBe("0.64%");
    expect(display(946, "count")).toBe("946");
    expect(display(null, "count")).toBe("—");
  });
  it("shows money in dong by default", () => {
    expect(display(1_234_567, "currency", { compact: false })).toBe("1.234.567 ₫");
    expect(display(1_250_000_000, "currency")).toBe("1,25 tỷ ₫");
    expect(display(340_000_000, "currency")).toBe("340 tr ₫");
    expect(display(12_500_000, "currency")).toBe("12,5 tr ₫");
    expect(display(250_000, "currency")).toBe("250.000 ₫");
    expect(display(-2_000_000, "currency")).toBe("-2 tr ₫");
  });
  it("supports another workspace currency", () => {
    setCurrency("USD");
    expect(display(172244.33, "currency", { compact: false })).toBe("$172,244");
    expect(display(950.5, "currency")).toBe("$950.50");
  });
});

describe("schema map layout", async () => {
  const { autoLayout, cardHeight, visibleColumns, CARD_W, ROW_GAP } = await import("../lib/schemaLayout");
  const col = (name: string) => ({ name, type: "integer", nullable: false, comment: null });
  const table = (name: string, cols: string[], fks: [string, string][] = []): Table => ({
    schema: "public", name, qualified: `public.${name}`, kind: "table", comment: null, estimatedRows: 10, primaryKey: ["id"],
    columns: ["id", ...cols].map(col), foreignKeys: fks.map(([c, ref]) => ({ columns: [c], refTable: `public.${ref}`, refColumns: ["id"] })),
  });
  const tables = [
    table("events", ["account_id", "user_id", "a", "b", "c", "d", "e", "f"], [["account_id", "accounts"], ["user_id", "users"]]),
    table("users", ["account_id"], [["account_id", "accounts"]]),
    table("accounts", ["name"]),
    table("orphan", ["x"]),
  ];

  it("places referenced tables left of the tables that reference them, unrelated tables last", () => {
    const pos = autoLayout(tables, (t) => cardHeight(t, tables, false));
    expect(pos["public.accounts"].x).toBeLessThan(pos["public.users"].x);
    expect(pos["public.users"].x).toBeLessThan(pos["public.events"].x);
    expect(pos["public.orphan"].x).toBeGreaterThan(pos["public.events"].x);
  });

  it("never overlaps cards in a column", () => {
    const pos = autoLayout(tables, (t) => cardHeight(t, tables, false));
    const byX = new Map<number, Table[]>();
    for (const t of tables) byX.set(pos[t.qualified].x, [...(byX.get(pos[t.qualified].x) ?? []), t]);
    for (const group of byX.values()) {
      const sorted = group.sort((a, b) => pos[a.qualified].y - pos[b.qualified].y);
      for (let i = 1; i < sorted.length; i++) expect(pos[sorted[i].qualified].y).toBeGreaterThanOrEqual(pos[sorted[i - 1].qualified].y + cardHeight(sorted[i - 1], tables, false) + ROW_GAP);
    }
    expect(CARD_W).toBeGreaterThan(0);
  });

  it("keeps key columns visible when compacting, and survives FK cycles", () => {
    const { shown, hidden } = visibleColumns(tables[0], tables, false);
    expect(shown.map((c) => c.name).slice(0, 3)).toEqual(["id", "account_id", "user_id"]);
    expect(hidden).toBe(9 - shown.length);
    const cyc = [table("a", ["b_id"], [["b_id", "b"]]), table("b", ["a_id"], [["a_id", "a"]])];
    expect(Object.keys(autoLayout(cyc, () => 100))).toHaveLength(2);
  });
});

describe("sealed secrets", async () => {
  const { seal, unseal } = await import("../core/secret");
  it("round-trips, never repeats ciphertext, and rejects tampering", () => {
    process.env.CREMA_ENCRYPTION_KEY ??= "test-key-for-unit-tests";
    const a = seal("p@ss"), b = seal("p@ss");
    expect(a).not.toBe(b);
    expect(a).not.toContain("p@ss");
    expect(unseal(a)).toBe("p@ss");
    const parts = a.split(".");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA");
    expect(() => unseal(parts.join("."))).toThrow();
  });
});

describe("hosted database names", () => {
  it("suggests natural random names, Neon-style, always valid", () => {
    const names = Array.from({ length: 200 }, naturalDbName);
    for (const n of names) {
      expect(n).toMatch(/^[a-z]+_[a-z]+_[a-z0-9]{4}$/);
      expect(dbNameProblem(n)).toBeNull();
    }
    expect(new Set(names).size).toBeGreaterThan(195); // random, not a short cycle
  });
  it("explains why a name can't be used", () => {
    expect(dbNameProblem("comicai")).toBeNull();
    expect(dbNameProblem("9lives")).toMatch(/Start with a letter/);
    expect(dbNameProblem("Comic")).toMatch(/Start with a letter|lowercase/);
    expect(dbNameProblem("comic-ai")).toMatch(/lowercase letters/);
    for (const n of ["postgres", "template1", "crema", "pg_stats", "crema_provisioner"]) expect(dbNameProblem(n)).toMatch(/reserved/);
  });
});
