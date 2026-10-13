import { parse } from "pgsql-ast-parser";

export class SqlContractError extends Error {}

/**
 * Functions a certified metric may call: pure, deterministic analytics. The model's prompt lists
 * them too (core/propose.ts), so proposals and the guard agree on one list.
 */
export const METRIC_FUNCTIONS = `sum count avg min max round abs ceil ceiling floor trunc sign mod power sqrt ln exp
  date_trunc date_part date_bin extract date age make_date make_interval justify_days justify_interval
  to_char to_date to_timestamp to_number timezone coalesce nullif greatest least
  lower upper length char_length substring substr trim btrim ltrim rtrim left right replace split_part position strpos
  concat concat_ws regexp_replace regexp_match string_agg array_agg array_length cardinality mode
  json_extract_path_text jsonb_extract_path_text jsonb_array_length json_array_length
  percentile_cont percentile_disc stddev stddev_pop stddev_samp variance var_pop var_samp corr
  row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value
  bool_and bool_or every generate_series`.split(/\s+/).filter(Boolean);
const metricFunctions = new Set(METRIC_FUNCTIONS);

/**
 * The SQL editor reads freely (its READ ONLY transaction is the real guard); this only stops calls
 * that act outside the query even in a read-only transaction: sleeping, signalling other sessions,
 * reading server files, changing settings, reaching other servers.
 */
const editorBlocked = /^(pg_sleep.*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_read_file|pg_read_binary_file|pg_ls_.*|pg_stat_file|pg_advisory.*|pg_try_advisory.*|pg_notify|pg_logical_.*|pg_replication_.*|pg_create_.*|pg_drop_.*|pg_switch_wal|pg_promote|set_config|lo_.*|dblink.*|query_to_xml.*|.*_to_xml)$/;

const mutations = new Set(["insert", "update", "delete", "drop", "alter table", "create table", "truncate table", "do", "set", "copy", "commit", "rollback", "begin", "start transaction", "grant", "revoke", "prepare", "execute", "create function"]);
const castTypes = /^(numeric|decimal|int|integer|int2|int4|int8|smallint|bigint|float|float4|float8|real|double precision|text|varchar|character varying|char|character|boolean|bool|date|time|timestamp|timestamptz|timestamp with time zone|timestamp without time zone|interval|uuid|json|jsonb)$/;

/**
 * User SQL only. Internal introspection and generated wrappers use Warehouse's READ ONLY guard.
 * `metric` (the default) is the certification contract; `editor` is the ad-hoc SQL editor.
 */
export function validateSql(sql: string, mode: "metric" | "editor" = "metric"): string {
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
      const name = fn.name.toLowerCase(), label = `${fn.schema ? fn.schema + "." : ""}${fn.name}`;
      if (mode === "editor") {
        if (editorBlocked.test(name)) throw new SqlContractError(`Function ${label} is not available in the SQL editor.`);
      } else if (!metricFunctions.has(name) || (fn.schema && fn.schema !== "pg_catalog")) {
        throw new SqlContractError(`Function ${label} is not on the safe analytics allowlist.`);
      }
    }
    if (node.type === "cast" && mode === "metric") {
      const type = node.to as { name: string; schema?: string };
      if ((type.schema && type.schema !== "pg_catalog") || !castTypes.test(type.name.toLowerCase())) {
        throw new SqlContractError(`Type ${type.name} is not allowed in analytics SQL.`);
      }
    }
    Object.values(node).forEach(visit);
  }
  visit(statements[0]);
  return sql.trim().replace(/;\s*$/, "");
}
