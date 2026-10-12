// Domain types shared by every adapter (web, REST, CLI, MCP).

export type Confidence = "high" | "medium" | "low";
export type MetricKind = "flow" | "snapshot";
export type MetricUnit = "count" | "currency" | "percent" | "number";

// ---------- schema understanding ----------

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  comment: string | null;
}

export interface ForeignKey {
  columns: string[];
  refTable: string; // schema-qualified
  refColumns: string[];
}

export interface Table {
  schema: string;
  name: string;
  qualified: string; // schema.name
  kind: "table" | "view";
  comment: string | null;
  estimatedRows: number;
  primaryKey: string[];
  columns: Column[];
  foreignKeys: ForeignKey[];
}

export interface ColumnProfile {
  column: string;
  type: string;
  nullFraction: number;
  distinct: number | null;
  min?: string | null;
  max?: string | null;
  /** Only for low-cardinality, non-identifying columns. */
  topValues?: { value: string | null; count: number }[];
  /** Why values were not profiled, if they were not. */
  withheld?: "identifying" | "high_cardinality" | "unsupported_type";
}

export interface TableProfile {
  table: string;
  rows: number;
  sampled: boolean;
  columns: ColumnProfile[];
}

export interface SchemaSnapshot {
  tables: Table[];
  profiles: TableProfile[];
}

// ---------- proposals ----------

export interface Assumption {
  text: string;
  column: string | null; // schema.table.column the assumption is about
  confidence: Confidence;
}

export interface CandidateSpec {
  label: string;
  description: string;
  kind: MetricKind;
  unit: MetricUnit;
  sql: string;
  membersSql: string | null;
  memberTable: string | null;
  assumptions: Assumption[];
  confidence: Confidence;
  why: string;
}

export interface ConceptSpec {
  key: string;
  name: string;
  question: string;
  candidates: CandidateSpec[];
}

export interface EntityReading {
  table: string;
  meaning: string;
  confidence: Confidence;
}

export interface Understanding {
  summary: string;
  entities: EntityReading[];
  concepts: ConceptSpec[];
}

// ---------- verification ----------

export type CheckLevel = "pass" | "warn" | "fail" | "info";

export interface Check {
  id: string;
  level: CheckLevel;
  message: string;
}

export interface SeriesPoint {
  start: string; // ISO
  value: number | null;
  partial?: boolean; // bucket still in progress
}

export interface Verification {
  ok: boolean;
  error: string | null;
  value: number | null; // latest window (flow) or now (snapshot)
  window: { start: string; end: string };
  series: SeriesPoint[];
  members: number | null;
  membersTotal: number | null; // sum of member contributions; equals value when the trace is faithful
  relations: string[]; // relations the plan touches
  checks: Check[];
  ms: number;
}

export interface DiffPart {
  rows: number;
  amount: number; // contribution to the gap (B minus A for "changed")
  explain: string | null;
  sample: Record<string, unknown>[];
}

/** Row-level comparison of two definitions over the same table. */
export interface MemberDiff {
  a: number; // candidate index
  b: number;
  table: string;
  both: number;
  onlyA: DiffPart;
  onlyB: DiffPart;
  changed: DiffPart; // rows both count, with different contributions
}

export interface Comparison {
  spread: number | null; // (max-min)/max of current values
  diffs: MemberDiff[];
}

// ---------- registry ----------

export type ConceptStatus = "open" | "certified" | "dismissed" | "superseded";

export interface Candidate extends CandidateSpec {
  id: number;
  conceptId: number;
  verification: Verification | null;
}

export interface Concept {
  id: number;
  runId: number;
  key: string;
  name: string;
  question: string;
  status: ConceptStatus;
  candidates: Candidate[];
  comparison: Comparison | null;
  metricKey: string | null;
  createdAt: string;
}

export interface MetricVersion {
  metricKey: string;
  version: number;
  name: string;
  question: string;
  description: string;
  kind: MetricKind;
  unit: MetricUnit;
  sql: string;
  membersSql: string | null;
  memberTable: string | null;
  origin: "ai" | "ai+human-edit" | "human";
  candidateId: number | null;
  certifiedBy: string;
  certifiedAt: string;
  note: string | null;
  fingerprint: Record<string, string>;
  verification: Verification;
}

export interface Metric {
  key: string;
  name: string;
  status: "certified" | "retired";
  owner: string;
  currentVersion: number;
  createdAt: string;
  current: MetricVersion;
}

export interface RunStep {
  at: string;
  kind: "step" | "detail" | "found" | "error";
  text: string;
}

export interface Run {
  id: number;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  model: string;
  hint: string | null;
  steps: RunStep[];
  summary: string | null;
  entities: EntityReading[];
  sentToModel: unknown;
  error: string | null;
}

export interface HostedDatabase {
  id: number;
  name: string;
  dbName: string;
  createdBy: string;
  createdAt: string;
}

export interface SavedQuery {
  id: number;
  name: string;
  sql: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: number;
  at: string;
  actor: string;
  action: string;
  subject: string;
  detail: unknown;
}
