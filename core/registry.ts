// The registry is the only writer of state: Postgres (see db.ts), append-only versions, an audit
// event for every state change. Everything analytical is scoped to a source; sources to a workspace.
import type pg from "pg";
import { database, type Db } from "./db";
import type {
  AuditEvent, Candidate, CandidateSpec, Comparison, Concept, ConceptSpec, EntityReading,
  Metric, MetricStatus, MetricVersion, Run, RunStep, SavedQuery, Source, Verification,
} from "./types";

type Q = Pick<pg.PoolClient, "query">;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export const DEFAULT_WORKSPACE = "default";

/** Sealed secrets of a source (core/secret.ts); never part of `Source`. */
export type SourceSecrets = { connection: string | null; ownerPassword: string | null; readerPassword: string | null };

export class Registry {
  constructor(readonly url?: string, readonly opts: { schema?: string } = {}) {
    database(url, opts.schema); // fail fast without DATABASE_URL
  }

  /** Looked up on every use: picks up migrations added while the process (and its pool) lives on. */
  get db(): Db {
    return database(this.url, this.opts.schema);
  }

  private async q<R extends pg.QueryResultRow = any>(text: string, values: unknown[] = []): Promise<R[]> {
    await this.db.ready;
    return (await this.db.pool.query<R>(text, values)).rows;
  }

  async tx<T>(fn: (c: Q) => Promise<T>): Promise<T> {
    await this.db.ready;
    const c = await this.db.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  // ---------- settings (instance-wide) ----------
  async getSetting(key: string): Promise<string | null> {
    return (await this.q<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]))[0]?.value ?? null;
  }
  async setSetting(key: string, value: string | null) {
    if (value === null) await this.q("DELETE FROM settings WHERE key = $1", [key]);
    else await this.q("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  // ---------- audit ----------
  async event(scope: { workspaceId: string; sourceId?: number | null }, actor: string, action: string, subject: string, detail?: unknown, c?: Q) {
    const sql = "INSERT INTO events (workspace_id, source_id, actor, action, subject, detail) VALUES ($1, $2, $3, $4, $5, $6)";
    const vals = [scope.workspaceId, scope.sourceId ?? null, actor, action, subject, json(detail)];
    if (c) await c.query(sql, vals); else await this.q(sql, vals);
  }
  async events(workspaceId: string, opts: { limit?: number; subject?: string; sourceId?: number } = {}): Promise<AuditEvent[]> {
    const where = ["workspace_id = $1"], vals: unknown[] = [workspaceId];
    if (opts.subject) { vals.push(opts.subject); where.push(`subject = $${vals.length}`); }
    if (opts.sourceId) { vals.push(opts.sourceId); where.push(`source_id = $${vals.length}`); }
    vals.push(opts.limit ?? 100);
    const rows = await this.q(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $${vals.length}`, vals);
    return rows.map((r) => ({ id: r.id, at: iso(r.at), actor: r.actor, action: r.action, subject: r.subject, detail: r.detail ?? null }));
  }

  // ---------- sources ----------
  private toSource(r: any): Source {
    return {
      id: r.id, workspaceId: r.workspace_id, slug: r.slug, name: r.name, kind: r.kind, status: r.status, error: r.error,
      readOnly: r.read_only, writableTables: r.writable_tables, dbName: r.db_name, createdBy: r.created_by, createdAt: iso(r.created_at),
    };
  }
  async sources(workspaceId: string): Promise<Source[]> {
    return (await this.q("SELECT * FROM sources WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY id", [workspaceId])).map((r) => this.toSource(r));
  }
  async source(workspaceId: string, idOrSlug: number | string): Promise<Source | null> {
    const byId = typeof idOrSlug === "number" || /^\d+$/.test(String(idOrSlug));
    const r = (await this.q(`SELECT * FROM sources WHERE workspace_id = $1 AND deleted_at IS NULL AND ${byId ? "id = $2" : "slug = $2"}`, [workspaceId, byId ? Number(idOrSlug) : idOrSlug]))[0];
    return r ? this.toSource(r) : null;
  }
  async sourceSecrets(id: number): Promise<SourceSecrets> {
    const r = (await this.q("SELECT connection, owner_password, reader_password FROM sources WHERE id = $1", [id]))[0];
    return { connection: r?.connection ?? null, ownerPassword: r?.owner_password ?? null, readerPassword: r?.reader_password ?? null };
  }
  /** A unique slug in the workspace: `name`, then `name_2`, … */
  async freeSlug(workspaceId: string, base: string): Promise<string> {
    const taken = new Set((await this.q<{ slug: string }>("SELECT slug FROM sources WHERE workspace_id = $1 AND deleted_at IS NULL", [workspaceId])).map((r) => r.slug));
    let slug = base, n = 1;
    while (taken.has(slug)) slug = `${base}_${++n}`;
    return slug;
  }
  async addSource(workspaceId: string, s: { slug: string; name: string; kind: Source["kind"]; status?: Source["status"]; connection?: string | null; readOnly?: boolean; writableTables?: number; dbName?: string | null }, actor: string): Promise<Source> {
    return this.tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO sources (workspace_id, slug, name, kind, status, connection, read_only, writable_tables, db_name, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [workspaceId, s.slug, s.name, s.kind, s.status ?? "ready", s.connection ?? null, s.readOnly ?? false, s.writableTables ?? 0, s.dbName ?? null, actor])).rows[0];
      await this.event({ workspaceId, sourceId: r.id }, actor, `source.${s.kind === "hosted" ? "provisioning" : "connected"}`, `source:${r.slug}`, { name: s.name, dbName: s.dbName ?? null }, c);
      return this.toSource(r);
    });
  }
  async updateSource(id: number, patch: Partial<{ status: Source["status"]; error: string | null; connection: string; readOnly: boolean; writableTables: number; ownerPassword: string; readerPassword: string; name: string }>) {
    const cols: Record<string, string> = { status: "status", error: "error", connection: "connection", readOnly: "read_only", writableTables: "writable_tables", ownerPassword: "owner_password", readerPassword: "reader_password", name: "name" };
    const sets: string[] = [], vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; vals.push(v); sets.push(`${cols[k]} = $${vals.length}`); }
    if (sets.length) await this.q(`UPDATE sources SET ${sets.join(", ")} WHERE id = $${vals.length + 1}`, [...vals, id]);
  }
  /** Soft delete: history (versions, audit) stays; the slug and hosted db name become free again. */
  async removeSource(source: Source, actor: string) {
    await this.tx(async (c) => {
      await c.query("UPDATE sources SET deleted_at = now(), slug = slug || '#' || id, db_name = CASE WHEN db_name IS NULL THEN NULL ELSE db_name || '#' || id END WHERE id = $1", [source.id]);
      await this.event({ workspaceId: source.workspaceId, sourceId: source.id }, actor, "source.removed", `source:${source.slug}`, { name: source.name, kind: source.kind }, c);
    });
  }

  // ---------- saved queries (the SQL editor's notebook) ----------
  async queries(sourceId: number): Promise<SavedQuery[]> {
    return (await this.q("SELECT * FROM saved_queries WHERE source_id = $1 ORDER BY updated_at DESC", [sourceId]))
      .map((r) => ({ id: r.id, name: r.name, sql: r.sql, createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }));
  }
  async saveQuery(source: Source, input: { id?: number | null; name: string; sql: string }, actor: string): Promise<SavedQuery> {
    const id = await this.tx(async (c) => {
      let id: number | null = null;
      if (input.id != null) id = (await c.query("UPDATE saved_queries SET name = $1, sql = $2, updated_at = now() WHERE id = $3 AND source_id = $4 RETURNING id", [input.name, input.sql, input.id, source.id])).rows[0]?.id ?? null;
      if (id == null) id = (await c.query("INSERT INTO saved_queries (source_id, name, sql, created_by) VALUES ($1, $2, $3, $4) RETURNING id", [source.id, input.name, input.sql, actor])).rows[0].id as number;
      await this.event({ workspaceId: source.workspaceId, sourceId: source.id }, actor, "query.saved", `query:${id}`, { name: input.name }, c);
      return id;
    });
    return (await this.queries(source.id)).find((x) => x.id === id)!;
  }
  async deleteQuery(source: Source, id: number, actor: string) {
    const rows = await this.q("DELETE FROM saved_queries WHERE id = $1 AND source_id = $2 RETURNING id", [id, source.id]);
    if (rows.length) await this.event({ workspaceId: source.workspaceId, sourceId: source.id }, actor, "query.deleted", `query:${id}`);
    return { deleted: rows.length };
  }

  // ---------- runs ----------
  async createRun(sourceId: number, model: string, hint: string | null, focus: string | null): Promise<number> {
    return (await this.q("INSERT INTO runs (source_id, status, model, hint, focus, pid) VALUES ($1, 'running', $2, $3, $4, $5) RETURNING id", [sourceId, model, hint, focus, process.pid]))[0].id;
  }
  async appendStep(runId: number, step: Omit<RunStep, "at">) {
    // jsonb append in place: concurrent steps can't overwrite each other
    await this.q("UPDATE runs SET steps = steps || $1::jsonb WHERE id = $2", [JSON.stringify([{ at: new Date().toISOString(), ...step }]), runId]);
  }
  async updateRun(runId: number, patch: { status?: Run["status"]; summary?: string; entities?: EntityReading[]; sentToModel?: unknown; error?: string; snapshot?: unknown }) {
    const sets: string[] = [], vals: unknown[] = [];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.status) { set("status", patch.status); if (patch.status !== "running") sets.push("finished_at = now()"); }
    if (patch.summary !== undefined) set("summary", patch.summary);
    if (patch.entities) set("entities", json(patch.entities));
    if (patch.sentToModel !== undefined) set("sent_to_model", json(patch.sentToModel));
    if (patch.error !== undefined) set("error", patch.error);
    if (patch.snapshot !== undefined) set("snapshot", json(patch.snapshot));
    if (sets.length) await this.q(`UPDATE runs SET ${sets.join(", ")} WHERE id = $${vals.length + 1}`, [...vals, runId]);
  }
  async run(sourceId: number, id: number): Promise<Run | null> {
    const r = (await this.q("SELECT id, source_id, status, started_at, finished_at, model, hint, steps, summary, entities, sent_to_model, error FROM runs WHERE id = $1 AND source_id = $2", [id, sourceId]))[0];
    return r ? toRun(r) : null;
  }
  async latestRun(sourceId: number, opts: { withSummary?: boolean } = {}): Promise<Run | null> {
    const r = (await this.q(`SELECT id, source_id, status, started_at, finished_at, model, hint, steps, summary, entities, NULL AS sent_to_model, error FROM runs WHERE source_id = $1 ${opts.withSummary ? "AND summary IS NOT NULL" : ""} ORDER BY id DESC LIMIT 1`, [sourceId]))[0];
    return r ? toRun(r) : null;
  }
  async runSnapshot<T>(id: number): Promise<T | null> {
    return ((await this.q("SELECT snapshot FROM runs WHERE id = $1", [id]))[0]?.snapshot ?? null) as T | null;
  }
  /** A process that died mid-discovery leaves a run 'running' forever; close those out. */
  async failStaleRuns(reason: string) {
    const running = await this.q<{ id: number; pid: number | null }>("SELECT id, pid FROM runs WHERE status = 'running'");
    for (const r of running) {
      if (r.pid && r.pid !== process.pid && alive(r.pid)) continue;
      await this.q("UPDATE runs SET status = 'failed', error = $1, finished_at = now() WHERE id = $2", [reason, r.id]);
    }
  }

  // ---------- proposals ----------
  async saveConcept(sourceId: number, runId: number, spec: ConceptSpec, verifications: (Verification | null)[], comparison: Comparison | null): Promise<number> {
    return this.tx(async (c) => {
      // a re-discovery replaces the still-open proposal for the same key in the same source
      await c.query("UPDATE concepts SET status = 'superseded' WHERE source_id = $1 AND key = $2 AND status = 'open'", [sourceId, spec.key]);
      const id = (await c.query("INSERT INTO concepts (source_id, run_id, key, name, question, comparison) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [sourceId, runId, spec.key, spec.name, spec.question, json(comparison ?? undefined)])).rows[0].id as number;
      for (const [i, cand] of spec.candidates.entries()) {
        await c.query("INSERT INTO candidates (concept_id, position, spec, verification) VALUES ($1, $2, $3, $4)", [id, i, json(cand), json(verifications[i] ?? undefined)]);
      }
      return id;
    });
  }
  async setComparison(conceptId: number, comparison: Comparison) {
    await this.q("UPDATE concepts SET comparison = $1 WHERE id = $2", [json(comparison), conceptId]);
  }
  async concept(sourceId: number, id: number): Promise<Concept | null> {
    return (await this.loadConcepts("WHERE source_id = $1 AND id = $2", [sourceId, id]))[0] ?? null;
  }
  async concepts(sourceId: number, statuses: string[] = ["open", "rejected"]): Promise<Concept[]> {
    return this.loadConcepts("WHERE source_id = $1 AND status = ANY($2) ORDER BY id", [sourceId, statuses]);
  }
  async setConceptStatus(id: number, status: string, metricKey: string | null = null, c?: Q) {
    const sql = "UPDATE concepts SET status = $1, metric_key = coalesce($2, metric_key) WHERE id = $3";
    if (c) await c.query(sql, [status, metricKey, id]);
    else await this.q(sql, [status, metricKey, id]);
  }
  /** Concepts with their candidates in two queries, not one per concept. */
  private async loadConcepts(where: string, values: unknown[]): Promise<Concept[]> {
    const rows = await this.q(`SELECT * FROM concepts ${where}`, values);
    if (!rows.length) return [];
    const cands = await this.q("SELECT * FROM candidates WHERE concept_id = ANY($1) ORDER BY concept_id, position", [rows.map((r) => r.id)]);
    return rows.map((r) => ({
      id: r.id, sourceId: r.source_id, runId: r.run_id, key: r.key, name: r.name, question: r.question, status: r.status,
      comparison: r.comparison ?? null, metricKey: r.metric_key, createdAt: iso(r.created_at),
      candidates: cands.filter((c) => c.concept_id === r.id).map((c): Candidate => ({ ...(c.spec as CandidateSpec), id: c.id, conceptId: r.id, verification: c.verification ?? null })),
    }));
  }

  // ---------- certified metrics ----------
  async certify(source: Source, v: Omit<MetricVersion, "version" | "certifiedAt">, owner: string, after?: (c: Q) => Promise<void>): Promise<MetricVersion> {
    return this.tx(async (c) => {
      // the row lock serialises two people certifying the same key at once
      const existing = (await c.query("SELECT id, current_version FROM metrics WHERE source_id = $1 AND key = $2 FOR UPDATE", [source.id, v.metricKey])).rows[0] as { id: number; current_version: number } | undefined;
      const version = (existing?.current_version ?? 0) + 1;
      const full: MetricVersion = { ...v, version, certifiedAt: new Date().toISOString() };
      let metricId = existing?.id;
      // a new version is a fresh certification: it clears "needs attention" and brings a deprecated metric back
      if (existing) await c.query("UPDATE metrics SET current_version = $1, name = $2, status = 'certified', attention = NULL WHERE id = $3", [version, v.name, existing.id]);
      else metricId = (await c.query("INSERT INTO metrics (source_id, key, name, status, owner, current_version) VALUES ($1, $2, $3, 'certified', $4, $5) RETURNING id", [source.id, v.metricKey, v.name, owner, version])).rows[0].id;
      await c.query("INSERT INTO metric_versions (metric_id, version, body, certified_by, certified_at) VALUES ($1, $2, $3, $4, $5)", [metricId, version, json(full), v.certifiedBy, full.certifiedAt]);
      await this.event({ workspaceId: source.workspaceId, sourceId: source.id }, v.certifiedBy, version === 1 ? "metric.certified" : "metric.revised", `metric:${source.slug}/${v.metricKey}`, { version, origin: v.origin, note: v.note, sql: v.sql }, c);
      if (after) await after(c); // e.g. close the proposal in the same transaction
      return full;
    });
  }
  async setMetricStatus(metricId: number, status: MetricStatus, attention: string | null = null) {
    await this.q("UPDATE metrics SET status = $1, attention = $2 WHERE id = $3", [status, attention, metricId]);
  }
  async metric(sourceId: number, key: string): Promise<Metric | null> {
    return (await this.loadMetrics("WHERE m.source_id = $1 AND m.key = $2", [sourceId, key]))[0] ?? null;
  }
  /** A source's metrics; deprecated ones only when asked for. */
  async metrics(sourceId: number, opts: { includeDeprecated?: boolean } = {}): Promise<Metric[]> {
    return this.loadMetrics(`WHERE m.source_id = $1 ${opts.includeDeprecated ? "" : "AND m.status <> 'deprecated'"} ORDER BY m.created_at`, [sourceId]);
  }
  /** Every live metric in a workspace with its source's slug, for the consumer API and MCP. */
  async workspaceMetrics(workspaceId: string): Promise<(Metric & { sourceSlug: string })[]> {
    const rows = await this.q(`SELECT m.*, v.body, s.slug AS source_slug FROM metrics m
      JOIN metric_versions v ON v.metric_id = m.id AND v.version = m.current_version
      JOIN sources s ON s.id = m.source_id AND s.deleted_at IS NULL
      WHERE s.workspace_id = $1 AND m.status <> 'deprecated' ORDER BY s.id, m.created_at`, [workspaceId]);
    return rows.map((r) => ({ ...toMetric(r), sourceSlug: r.source_slug }));
  }
  async version(metricId: number, version: number): Promise<MetricVersion | null> {
    return ((await this.q("SELECT body FROM metric_versions WHERE metric_id = $1 AND version = $2", [metricId, version]))[0]?.body ?? null) as MetricVersion | null;
  }
  async versions(metricId: number): Promise<MetricVersion[]> {
    return (await this.q("SELECT body FROM metric_versions WHERE metric_id = $1 ORDER BY version DESC", [metricId])).map((r) => r.body as MetricVersion);
  }
  private async loadMetrics(where: string, values: unknown[]): Promise<Metric[]> {
    const rows = await this.q(`SELECT m.*, v.body FROM metrics m JOIN metric_versions v ON v.metric_id = m.id AND v.version = m.current_version ${where}`, values);
    return rows.map(toMetric);
  }
}

function toMetric(r: any): Metric {
  return { id: r.id, sourceId: r.source_id, key: r.key, name: r.name, status: r.status, attention: r.attention, owner: r.owner, currentVersion: r.current_version, createdAt: iso(r.created_at), current: r.body as MetricVersion };
}

function toRun(r: any): Run {
  return {
    id: r.id, sourceId: r.source_id, status: r.status, startedAt: iso(r.started_at), finishedAt: isoOrNull(r.finished_at), model: r.model, hint: r.hint,
    steps: r.steps ?? [], summary: r.summary, entities: r.entities ?? [], sentToModel: r.sent_to_model ?? null, error: r.error,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Identity of an implementation across dev hot reloads. Turbopack can load this module once per
 * route bundle, so `instanceof` fails between identical copies; the class source is the same in
 * every copy and changes exactly when the code does.
 */
export function implId(cls: Function): string {
  // Methods too: compiled output may turn a class into a constructor plus prototype assignments,
  // and then cls.toString() is only the constructor.
  const proto = cls.prototype as Record<string, unknown>;
  const src = [cls.toString(), ...Object.getOwnPropertyNames(proto).sort().map((k) => {
    const d = Object.getOwnPropertyDescriptor(proto, k);
    return `${k}:${String(d?.value ?? d?.get ?? "")}`;
  })].join("\n");
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
  return `${src.length}:${h}`;
}

// One registry per process, shared by every route bundle; rebuilt only when its code changed.
// The pool lives in db.ts (keyed by URL), so a rebuilt registry reuses the same connections.
let shared: Registry | null = (globalThis as any).__creamaRegistry ?? null;
export function registry(): Registry {
  const id = implId(Registry);
  if (!shared || (shared as any).__impl !== id) {
    shared = (globalThis as any).__creamaRegistry = Object.assign(new Registry(), { __impl: id });
  }
  return shared;
}
