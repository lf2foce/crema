// AI proposes business meaning. Nothing here is ever trusted without verification.
import { z } from "zod";
import { generateJson, type Usage } from "./model";
import type { Understanding } from "./types";

const confidence = z.enum(["high", "medium", "low"]);

const candidateSchema = z.object({
  label: z.string().describe("2-5 words naming what makes this definition different, e.g. 'Excludes trials'"),
  description: z.string().describe("One or two plain-language sentences a non-technical founder understands"),
  kind: z.enum(["flow", "snapshot"]),
  unit: z.enum(["count", "currency", "percent", "number"]),
  sql: z.string(),
  members_sql: z.string().nullable().describe("The rows that make up the number: same logic, returns <primary key> AS id and that row's contribution AS value. Null for ratios and averages."),
  member_table: z.string().nullable().describe("schema.table whose primary key members_sql returns, or null"),
  assumptions: z.array(z.object({
    text: z.string().describe("A falsifiable statement about what the data means"),
    column: z.string().nullable().describe("schema.table.column it is about"),
    confidence,
  })),
  confidence,
  why: z.string().describe("Why this confidence: what in the schema/profile supports or undermines it"),
});

const understandingSchema = z.object({
  summary: z.string().describe("Two sentences: what this business is and how it makes money, inferred from the schema"),
  entities: z.array(z.object({
    table: z.string(),
    meaning: z.string().describe("What one row represents in business terms"),
    confidence,
  })),
  metrics: z.array(z.object({
    key: z.string().describe("snake_case identifier, e.g. mrr, active_customers"),
    name: z.string(),
    question: z.string().describe("The business question this metric answers"),
    candidates: z.array(candidateSchema).min(1).max(3),
  })),
});

const SYSTEM = `You are a senior analytics engineer joining a company on day one. You are given a
PostgreSQL schema with statistics (row counts, null rates, distinct counts, min/max and value
distributions for low-cardinality columns). You never see rows.

Your job is NOT to list generic KPIs. It is to find the handful of metrics this business is
actually run on, and to expose the hidden decisions that make people disagree about them.

Rules for proposing:
- Propose the 6 to 9 metrics a founder or operator of THIS business would look at weekly.
  Ground every metric in tables that exist. Prefer metrics about money, customers and usage.
- For each metric give 1 to 3 candidate definitions. Give more than one ONLY when the data shows
  a genuine, consequential ambiguity: e.g. trials vs paying, past-due counted or not, internal or
  test accounts, refunds/void/tax, annual plans normalised to monthly, soft-deleted rows,
  subscriptions vs customers. Each candidate must differ in a way that changes the number.
  Do not pad with trivial variants.
- Use the value distributions: if a status column has values, reason about each value.
  If a column like is_internal, is_test, deleted_at exists, decide explicitly whether to use it.
- Assumptions are falsifiable claims about data meaning ("invoices.status = 'paid' means cash was
  collected"), each tied to the column it depends on. State uncertainty honestly; "low" is fine.

SQL contract (strict — definitions that break it are rejected automatically):
- PostgreSQL. ONE statement, SELECT or WITH, returning exactly ONE row with ONE column named value.
- Always schema-qualify tables (public.invoices).
- kind "flow" = something that happens over a period (revenue, signups, events). It MUST filter
  its event time with  >= {{start}} AND < {{end}}.
- kind "snapshot" = a state at a moment (MRR, active customers, open tickets). It MUST evaluate
  the state as of {{at}} using timestamp columns (e.g. started_at <= {{at}} AND (canceled_at IS NULL
  OR canceled_at > {{at}})), so it can be computed historically. Never use the current value of a
  mutable status column alone for a snapshot if timestamps allow reconstructing history.
- Never use now(), current_date, current_timestamp, or $1-style parameters. Only {{start}}, {{end}}, {{at}}.
- Money: if amounts are in cents, divide by 100.0. unit "currency".
- Ratios: return a fraction between 0 and 1, unit "percent", guard denominators with NULLIF.
- Members: for every count or sum, provide members_sql with the identical logic, listing the rows
  that make up the number: SELECT <pk of the counted/summed table> AS id, <that row's contribution> AS value
  (1 for counts, the row's amount for sums, already normalised the same way), one row per id, so that
  sum(value) equals the metric. Set member_table to that table. Same placeholders. Null for ratios/averages.
  This is how humans trace disagreements between definitions to individual rows.
- Aggregates must return a number, wrap sums in COALESCE(..., 0).`;

export function buildPrompt(payload: unknown, opts: { hint?: string | null; certified?: string[]; focus?: string | null }) {
  const parts = [
    "Schema and statistics (JSON):",
    JSON.stringify(payload),
  ];
  if (opts.certified?.length) parts.push(`Already certified by humans, do not propose again: ${opts.certified.join(", ")}.`);
  if (opts.hint) parts.push(`Context from the team about their business: ${opts.hint}`);
  if (opts.focus) parts.push(`Only propose definitions for this one metric the team asked for: "${opts.focus}". Return exactly one metric with 1-3 candidates.`);
  return parts.join("\n\n");
}

export async function propose(payload: unknown, opts: { hint?: string | null; certified?: string[]; focus?: string | null; onUsage?: (u: Usage) => void } = {}): Promise<Understanding> {
  const out = await generateJson({ system: SYSTEM, prompt: buildPrompt(payload, opts), schema: understandingSchema, onUsage: opts.onUsage });
  return {
    summary: out.summary,
    entities: out.entities,
    concepts: out.metrics.map((m) => ({
      key: m.key.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""),
      name: m.name,
      question: m.question,
      candidates: m.candidates.map((c) => ({
        label: c.label,
        description: c.description,
        kind: c.kind,
        unit: c.unit,
        sql: c.sql,
        membersSql: c.members_sql || null,
        memberTable: c.members_sql ? c.member_table : null,
        assumptions: c.assumptions,
        confidence: c.confidence,
        why: c.why,
      })),
    })),
  };
}

const repairSchema = z.object({
  fixes: z.array(z.object({ ref: z.string(), sql: z.string(), members_sql: z.string().nullable() })),
});

/** One repair round for definitions that failed to execute. The model sees the error, never rows. */
export async function repair(
  payload: unknown,
  broken: { ref: string; kind: string; sql: string; membersSql: string | null; error: string }[],
  onUsage?: (u: Usage) => void,
) {
  const out = await generateJson({
    system: SYSTEM,
    onUsage,
    schema: repairSchema,
    prompt: [
      "Schema and statistics (JSON):",
      JSON.stringify(payload),
      "These metric definitions failed when executed against the database. Fix each one, keeping its intent and obeying the SQL contract. Return one fix per ref.",
      JSON.stringify(broken),
    ].join("\n\n"),
  });
  return out.fixes;
}
