import { parse } from "pgsql-ast-parser";

export class SqlContractError extends Error {}

const safeFunctions = new Set(`sum count avg min max round abs ceil ceiling floor date_trunc date_part now coalesce nullif greatest least lower upper length substring trim btrim to_char extract percentile_cont percentile_disc stddev stddev_pop stddev_samp variance var_pop var_samp row_number rank dense_rank lag lead first_value last_value bool_and bool_or`.split(" "));
const mutations = new Set(["insert", "update", "delete", "drop", "alter table", "create table", "truncate table", "do", "set", "copy", "commit", "rollback", "begin", "start transaction", "grant", "revoke", "prepare", "execute", "create function"]);

/** User SQL only. Internal introspection and generated wrappers use Warehouse's READ ONLY guard. */
export function validateSql(sql: string): string {
  if (sql.length > 20_000) throw new SqlContractError("SQL exceeds 20,000 characters.");
  // Parse the metric template as SQL; keep its original text for real parameter binding.
  const text = sql.replace(/\{\{\s*(start|end|at)\s*\}\}/g, "'2000-01-01T00:00:00Z'::timestamptz");
  let statements;
  try { statements = parse(text); }
  catch { throw new SqlContractError("SQL could not be parsed. Use a single SELECT or WITH … SELECT in the supported analytics syntax."); }
  if (statements.length !== 1 || !["select", "with", "union", "union all"].includes(statements[0].type)) {
    throw new SqlContractError("Definition must be a single statement: SELECT or WITH … SELECT.");
  }
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    if (mutations.has(String(node.type)) || node.for || node.into || node.type === "with recursive") {
      throw new SqlContractError("SQL mutations, row locks, SELECT INTO and recursive queries are blocked.");
    }
    if (node.type === "parameter") throw new SqlContractError("Use {{start}}, {{end}} or {{at}} instead of $n parameters.");
    if (node.type === "call") {
      const fn = node.function as { name: string; schema?: string };
      if (!safeFunctions.has(fn.name.toLowerCase()) || (fn.schema && fn.schema !== "pg_catalog")) {
        throw new SqlContractError(`Function ${fn.schema ? fn.schema + "." : ""}${fn.name} is not on the safe analytics allowlist.`);
      }
    }
    if (node.type === "cast") {
      const type = node.to as { name: string; schema?: string };
      if ((type.schema && type.schema !== "pg_catalog") || !/^(numeric|decimal|int|integer|int2|int4|int8|smallint|bigint|float|float4|float8|real|double precision|text|varchar|character varying|boolean|bool|date|timestamp|timestamptz|timestamp with time zone|timestamp without time zone|interval|uuid|json|jsonb)$/.test(type.name.toLowerCase())) {
        throw new SqlContractError(`Type ${type.name} is not allowed in analytics SQL.`);
      }
    }
    Object.values(node).forEach(visit);
  }
  visit(statements[0]);
  return sql.trim().replace(/;\s*$/, "");
}
