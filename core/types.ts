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

export type ConceptStatus = "open" | "certified" | "rejected" | "superseded";

/** A database Crema analyses: one you connected (external) or one it created for an app (hosted). */
export interface Source {
  id: number;
  workspaceId: string;
  slug: string;
  name: string;
  kind: "external" | "hosted";
  status: "provisioning" | "ready" | "failed";
  error: string | null;
  readOnly: boolean;
  writableTables: number;
  dbName: string | null;
  /** hosted: the server it lives on */
  serverId: number | null;
  /** a branch: the database it was copied from (its project's main), and its name ("dev") */
  parentId: number | null;
  branch: string | null;
  /** a branch: what is copied from the parent */
  branchCopy: "data" | "schema" | null;
  /** a branch: when its data was last copied from the parent */
  branchedAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** A Postgres server Crema administers through its own provisioner login, to create databases for apps. */
export interface Server {
  id: number;
  workspaceId: string;
  name: string;
  provisioner: string;
  publicHost: string;
  ssl: boolean;
  version: string;
  createdBy: string;
  createdAt: string;
}

export interface Candidate extends CandidateSpec {
  id: number;
  conceptId: number;
  verification: Verification | null;
}

export interface Concept {
  id: number;
  sourceId: number;
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

export type MetricStatus = "certified" | "needs_attention" | "deprecated";

export interface Metric {
  id: number;
  sourceId: number;
  key: string;
  name: string;
  status: MetricStatus;
  /** why it needs attention (schema drift…); while set, the metric is not served */
  attention: string | null;
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
  sourceId: number;
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
