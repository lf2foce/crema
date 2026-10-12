// The registry is the only writer of state: Postgres (see db.ts), append-only versions,
// an audit event for every state change.
import type pg from "pg";
import { database, type Db } from "./db";
import type {
  AuditEvent, Candidate, CandidateSpec, Comparison, Concept, ConceptSpec, EntityReading,
  HostedDatabase, Metric, MetricVersion, Run, RunStep, SavedQuery, Verification,
} from "./types";

type Q = Pick<pg.PoolClient, "query">;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export class Registry {
  constructor(readonly url?: string, readonly opts: { schema?: string } = {}) {
    database(url, opts.schema); // fail fast without DATABASE_URL
  }

  /** Looked up on every use: picks up migrations added while the process (and its pool) lives on. */
  get db(): Db {
    return database(this.url, this.opts.schema);
  }

  /** Every call waits for migrations once, then runs on the shared pool. */
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

  // ---------- settings ----------
  async getSetting(key: string): Promise<string | null> {
    return (await this.q<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]))[0]?.value ?? null;
  }
  async setSetting(key: string, value: string | null) {
    if (value === null) await this.q("DELETE FROM settings WHERE key = $1", [key]);
    else await this.q("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  // ---------- audit ----------
  async event(actor: string, action: string, subject: string, detail?: unknown, c?: Q) {
    const sql = "INSERT INTO events (actor, action, subject, detail) VALUES ($1, $2, $3, $4)";
    if (c) await c.query(sql, [actor, action, subject, json(detail)]);
    else await this.q(sql, [actor, action, subject, json(detail)]);
  }
  async events(limit = 100, subject?: string): Promise<AuditEvent[]> {
    const rows = subject
      ? await this.q("SELECT * FROM events WHERE subject = $1 ORDER BY id DESC LIMIT $2", [subject, limit])
      : await this.q("SELECT * FROM events ORDER BY id DESC LIMIT $1", [limit]);
    return rows.map((r) => ({ id: r.id, at: iso(r.at), actor: r.actor, action: r.action, subject: r.subject, detail: r.detail ?? null }));
  }

  // ---------- saved queries (the SQL editor's notebook) ----------
  async queries(): Promise<SavedQuery[]> {
    return (await this.q("SELECT * FROM saved_queries ORDER BY updated_at DESC"))
      .map((r) => ({ id: r.id, name: r.name, sql: r.sql, createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }));
  }
  async saveQuery(input: { id?: number | null; name: string; sql: string }, actor: string): Promise<SavedQuery> {
    const id = await this.tx(async (c) => {
      let id: number | null = null;
      if (input.id != null) id = (await c.query("UPDATE saved_queries SET name = $1, sql = $2, updated_at = now() WHERE id = $3 RETURNING id", [input.name, input.sql, input.id])).rows[0]?.id ?? null;
      if (id == null) id = (await c.query("INSERT INTO saved_queries (name, sql, created_by) VALUES ($1, $2, $3) RETURNING id", [input.name, input.sql, actor])).rows[0].id as number;
      await this.event(actor, "query.saved", `query:${id}`, { name: input.name }, c);
      return id;
    });
    return (await this.queries()).find((x) => x.id === id)!;
  }
  async deleteQuery(id: number, actor: string) {
    const rows = await this.q("DELETE FROM saved_queries WHERE id = $1 RETURNING id", [id]);
    if (rows.length) await this.event(actor, "query.deleted", `query:${id}`);
    return { deleted: rows.length };
  }

  // ---------- hosted databases ----------
  async hostedDatabases(): Promise<HostedDatabase[]> {
    return (await this.q("SELECT * FROM hosted_databases WHERE deleted_at IS NULL ORDER BY id"))
      .map((r) => ({ id: r.id, name: r.name, dbName: r.db_name, createdBy: r.created_by, createdAt: iso(r.created_at) }));
  }
  async hostedDatabase(id: number): Promise<HostedDatabase | null> {
    return (await this.hostedDatabases()).find((h) => h.id === id) ?? null;
  }
  async addHostedDatabase(name: string, dbName: string, actor: string, sealed: { owner: string; reader: string }): Promise<number> {
    return this.tx(async (c) => {
      const id = (await c.query("INSERT INTO hosted_databases (name, db_name, created_by, owner_password, reader_password) VALUES ($1, $2, $3, $4, $5) RETURNING id", [name, dbName, actor, sealed.owner, sealed.reader])).rows[0].id as number;
      await this.event(actor, "hosting.created", `hosted:${dbName}`, { name }, c);
      return id;
    });
  }
  /** Sealed passwords (core/secret.ts) — never returned by the listing. */
  async hostedPasswords(id: number): Promise<{ owner: string | null; reader: string | null }> {
    const r = (await this.q("SELECT owner_password, reader_password FROM hosted_databases WHERE id = $1 AND deleted_at IS NULL", [id]))[0];
    return { owner: r?.owner_password ?? null, reader: r?.reader_password ?? null };
  }
  async setHostedPassword(id: number, which: "owner" | "reader", sealed: string) {
    await this.q(`UPDATE hosted_databases SET ${which === "owner" ? "owner_password" : "reader_password"} = $1 WHERE id = $2`, [sealed, id]);
  }
  async removeHostedDatabase(id: number, actor: string) {
    await this.tx(async (c) => {
      const r = (await c.query("UPDATE hosted_databases SET deleted_at = now(), db_name = db_name || '#deleted-' || id WHERE id = $1 AND deleted_at IS NULL RETURNING name, db_name", [id])).rows[0];
      if (r) await this.event(actor, "hosting.deleted", `hosted:${String(r.db_name).split("#")[0]}`, { name: r.name }, c);
    });
  }

  // ---------- runs ----------
  async createRun(model: string, hint: string | null, focus: string | null): Promise<number> {
    return (await this.q("INSERT INTO runs (status, model, hint, focus, pid) VALUES ('running', $1, $2, $3, $4) RETURNING id", [model, hint, focus, process.pid]))[0].id;
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
  async run(id: number): Promise<Run | null> {
    const r = (await this.q("SELECT id, status, started_at, finished_at, model, hint, steps, summary, entities, sent_to_model, error FROM runs WHERE id = $1", [id]))[0];
    return r ? toRun(r) : null;
  }
  async latestRun(opts: { withSummary?: boolean } = {}): Promise<Run | null> {
    const r = (await this.q(`SELECT id, status, started_at, finished_at, model, hint, steps, summary, entities, NULL AS sent_to_model, error FROM runs ${opts.withSummary ? "WHERE summary IS NOT NULL" : ""} ORDER BY id DESC LIMIT 1`))[0];
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
  async saveConcept(runId: number, spec: ConceptSpec, verifications: (Verification | null)[], comparison: Comparison | null): Promise<number> {
    return this.tx(async (c) => {
      // a re-discovery replaces the still-open proposal for the same key
      await c.query("UPDATE concepts SET status = 'superseded' WHERE key = $1 AND status = 'open'", [spec.key]);
      const id = (await c.query("INSERT INTO concepts (run_id, key, name, question, comparison) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [runId, spec.key, spec.name, spec.question, json(comparison ?? undefined)])).rows[0].id as number;
      for (const [i, cand] of spec.candidates.entries()) {
        await c.query("INSERT INTO candidates (concept_id, position, spec, verification) VALUES ($1, $2, $3, $4)", [id, i, json(cand), json(verifications[i] ?? undefined)]);
      }
      return id;
    });
  }
  async setComparison(conceptId: number, comparison: Comparison) {
    await this.q("UPDATE concepts SET comparison = $1 WHERE id = $2", [json(comparison), conceptId]);
  }
  async concept(id: number): Promise<Concept | null> {
    return (await this.loadConcepts("WHERE id = $1", [id]))[0] ?? null;
  }
  async concepts(statuses: string[] = ["open", "dismissed"]): Promise<Concept[]> {
    return this.loadConcepts("WHERE status = ANY($1) ORDER BY id", [statuses]);
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
      id: r.id, runId: r.run_id, key: r.key, name: r.name, question: r.question, status: r.status,
      comparison: r.comparison ?? null, metricKey: r.metric_key, createdAt: iso(r.created_at),
      candidates: cands.filter((c) => c.concept_id === r.id).map((c): Candidate => ({ ...(c.spec as CandidateSpec), id: c.id, conceptId: r.id, verification: c.verification ?? null })),
    }));
  }

  // ---------- certified metrics ----------
  async certify(v: Omit<MetricVersion, "version" | "certifiedAt">, owner: string, after?: (c: Q) => Promise<void>): Promise<MetricVersion> {
    return this.tx(async (c) => {
      // the row lock serialises two people certifying the same key at once
      const existing = (await c.query("SELECT current_version FROM metrics WHERE key = $1 FOR UPDATE", [v.metricKey])).rows[0] as { current_version: number } | undefined;
      const version = (existing?.current_version ?? 0) + 1;
      const full: MetricVersion = { ...v, version, certifiedAt: new Date().toISOString() };
      if (existing) await c.query("UPDATE metrics SET current_version = $1, name = $2, status = 'certified' WHERE key = $3", [version, v.name, v.metricKey]);
      else await c.query("INSERT INTO metrics (key, name, status, owner, current_version) VALUES ($1, $2, 'certified', $3, $4)", [v.metricKey, v.name, owner, version]);
      await c.query("INSERT INTO metric_versions (metric_key, version, body, certified_by, certified_at) VALUES ($1, $2, $3, $4, $5)", [v.metricKey, version, json(full), v.certifiedBy, full.certifiedAt]);
      await this.event(v.certifiedBy, version === 1 ? "metric.certified" : "metric.revised", v.metricKey, { version, origin: v.origin, note: v.note, sql: v.sql }, c);
      if (after) await after(c); // e.g. close the proposal in the same transaction
      return full;
    });
  }
  async setMetricStatus(key: string, status: "certified" | "retired") {
    await this.q("UPDATE metrics SET status = $1 WHERE key = $2", [status, key]);
  }
  async metric(key: string): Promise<Metric | null> {
    return (await this.loadMetrics("WHERE m.key = $1", [key]))[0] ?? null;
  }
  async metrics(opts: { includeRetired?: boolean } = {}): Promise<Metric[]> {
    return this.loadMetrics(`${opts.includeRetired ? "" : "WHERE m.status = 'certified'"} ORDER BY m.created_at`, []);
  }
  async version(key: string, version: number): Promise<MetricVersion | null> {
    return ((await this.q("SELECT body FROM metric_versions WHERE metric_key = $1 AND version = $2", [key, version]))[0]?.body ?? null) as MetricVersion | null;
  }
  async versions(key: string): Promise<MetricVersion[]> {
    return (await this.q("SELECT body FROM metric_versions WHERE metric_key = $1 ORDER BY version DESC", [key])).map((r) => r.body as MetricVersion);
  }
  private async loadMetrics(where: string, values: unknown[]): Promise<Metric[]> {
    const rows = await this.q(`SELECT m.*, v.body FROM metrics m JOIN metric_versions v ON v.metric_key = m.key AND v.version = m.current_version ${where}`, values);
    return rows.map((r) => ({ key: r.key, name: r.name, status: r.status, owner: r.owner, currentVersion: r.current_version, createdAt: iso(r.created_at), current: r.body as MetricVersion }));
  }
}

function toRun(r: any): Run {
  return {
    id: r.id, status: r.status, startedAt: iso(r.started_at), finishedAt: isoOrNull(r.finished_at), model: r.model, hint: r.hint,
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
