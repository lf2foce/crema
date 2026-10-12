// The application API. Web routes, the REST API, the CLI and the MCP server are all thin
// adapters over this class. The invariant it enforces: AI output is only ever a proposal;
// a metric becomes certified solely through certify()/revise(), which require a named human
// and re-verify the definition against the live database at that moment.
import { compare } from "./compare";
import { modelConfigured, modelName, thinkingLevel, type Usage } from "./model";
import { propose, repair } from "./propose";
import { implId, Registry, registry } from "./registry";
import { introspect, modelPayload, snapshot } from "./schema";
import { ExploreError, runSql, tableRows } from "./explore";
import type { Candidate, CandidateSpec, Concept, Metric, MetricKind, MetricUnit, MetricVersion, SchemaSnapshot, Table, Verification } from "./types";
import { currentCurrency, display, fmt } from "./format";
import { driftedRelations, fingerprint, pgError, verify, windows } from "./verify";
import { assertSingleSelect, bind, describeUrl, seriesSql, SqlContractError, Warehouse } from "./warehouse";

export class CreamaError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface Edits {
  key?: string; name?: string; question?: string; description?: string;
  sql?: string; membersSql?: string | null; kind?: MetricKind; unit?: MetricUnit;
}

export type Grain = "day" | "week" | "month" | "quarter" | "year";

export class Creama {
  private tablesCache: { at: number; url: string; tables: Table[] } | null = null;

  constructor(readonly reg: Registry = registry()) {}

  // ---------- connection ----------

  async connectionUrl(): Promise<string | null> {
    return process.env.CREAMA_DATABASE_URL || (await this.reg.getSetting("database_url"));
  }

  async connection() {
    const url = await this.connectionUrl();
    if (!url) return null;
    const [ro, writable] = await Promise.all([this.reg.getSetting("read_only"), this.reg.getSetting("writable_tables")]);
    return { ...describeUrl(url), source: process.env.CREAMA_DATABASE_URL ? ("env" as const) : ("ui" as const), readOnly: ro === "true", writableTables: Number(writable ?? 0) };
  }

  async warehouse(): Promise<Warehouse> {
    const url = await this.connectionUrl();
    if (!url) throw new CreamaError("No database connected.", 409);
    return new Warehouse(url);
  }

  async connect(url: string, actor = "anonymous") {
    if (!/^postgres(ql)?:\/\//.test(url)) throw new CreamaError("Expected a postgres:// connection string.");
    const wh = new Warehouse(url, 8_000);
    let info: { db: string; usr: string; ro: string; writable: number; tables: number };
    try {
      [info] = await wh.query(`
        SELECT current_database() AS db, current_user AS usr, current_setting('default_transaction_read_only') AS ro,
               count(*) FILTER (WHERE has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE'))::int AS writable,
               count(*)::int AS tables
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'`);
    } catch (e) {
      throw new CreamaError(`Could not connect: ${pgError(e)}`);
    }
    if (!process.env.CREAMA_DATABASE_URL) await this.reg.setSetting("database_url", url);
    await this.reg.setSetting("read_only", String(info.ro === "on" || info.writable === 0));
    await this.reg.setSetting("writable_tables", String(info.writable));
    await this.reg.event(actor, "connection.set", describeUrl(url).display, { user: info.usr, writableTables: info.writable });
    this.tablesCache = null;
    return { ...describeUrl(url), tables: info.tables, writableTables: info.writable, readOnlyRole: info.ro === "on" };
  }

  async disconnect(actor = "anonymous") {
    await this.reg.setSetting("database_url", null);
    await this.reg.event(actor, "connection.removed", "database");
  }

  // ---------- overview ----------

  async state() {
    const [run, understood, connection, proposals, dismissed, metrics] = await Promise.all([
      this.reg.latestRun(), this.reg.latestRun({ withSummary: true }), this.connection(),
      this.reg.concepts(["open"]), this.reg.concepts(["dismissed"]), this.reg.metrics(),
    ]);
    return {
      connection,
      model: { name: modelName(), configured: modelConfigured() },
      run: run && { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error },
      understanding: understood && { runId: understood.id, summary: understood.summary, entities: understood.entities, model: understood.model, at: understood.startedAt },
      proposals,
      dismissed,
      metrics,
      currency: currentCurrency(),
    };
  }

  // ---------- discovery ----------

  async startDiscovery(opts: { hint?: string | null; focus?: string | null; actor?: string } = {}): Promise<number> {
    const running = await this.reg.latestRun();
    if (running?.status === "running") return running.id;
    if (!modelConfigured()) throw new CreamaError("No model configured. Set GEMINI_API_KEY and restart.", 409);
    await this.warehouse();
    const runId = await this.reg.createRun(modelName(), opts.hint ?? null, opts.focus ?? null);
    await this.reg.event(opts.actor ?? "anonymous", opts.focus ? "discovery.asked" : "discovery.started", `run:${runId}`, { hint: opts.hint, focus: opts.focus });
    void this.discover(runId, opts).catch(async (e) => {
      await this.reg.appendStep(runId, { kind: "error", text: (e as Error).message }).catch(() => {});
      await this.reg.updateRun(runId, { status: "failed", error: (e as Error).message }).catch(() => {});
    });
    return runId;
  }

  async discover(runId: number, opts: { hint?: string | null; focus?: string | null } = {}) {
    const wh = (await this.warehouse());
    // steps are written in order through one chain, even from the snapshot's synchronous callback
    let log = Promise.resolve();
    const write = (kind: "step" | "detail" | "found", text: string) => { log = log.then(() => this.reg.appendStep(runId, { kind, text })); return log; };
    const step = (text: string) => write("step", text);
    const detail = (text: string) => write("detail", text);

    step("Reading your schema");
    const snap = await snapshot(wh, (t, p) => {
      const interesting = p.columns.filter((c) => c.topValues && c.topValues.length > 1 && c.topValues.length <= 6).slice(0, 2)
        .map((c) => `${c.column}: ${c.topValues!.slice(0, 3).map((v) => `${v.value} ${Math.round((v.count / Math.max(p.rows, 1)) * 100)}%`).join(", ")}`);
      detail(`${t.qualified} · ${fmt(p.rows)} rows${interesting.length ? " · " + interesting.join(" · ") : ""}`);
    });
    const fks = snap.tables.reduce((n, t) => n + t.foreignKeys.length, 0);
    detail(`${snap.tables.length} tables, ${snap.tables.reduce((n, t) => n + t.columns.length, 0)} columns, ${fks} relationships`);
    const payload = modelPayload(snap);
    await this.reg.updateRun(runId, { sentToModel: payload, snapshot: snap });
    detail("Sent to the model: schema, row counts and value distributions of low-cardinality columns. No rows.");

    step(opts.focus ? `Asking ${modelName()} how to define “${opts.focus}”` : `Asking ${modelName()} what this business runs on`);
    const certified = (await this.reg.metrics({ includeRetired: true })).map((m) => m.key);
    const usage: Usage = { input: 0, output: 0, thinking: 0 };
    const count = (x: Usage) => { usage.input += x.input; usage.output += x.output; usage.thinking += x.thinking; };
    const t0 = Date.now();
    const u = await propose(payload, { hint: opts.hint, certified: opts.focus ? [] : certified, focus: opts.focus, onUsage: count });
    detail(`Model answered in ${((Date.now() - t0) / 1000).toFixed(0)}s · thinking ${thinkingLevel().toLowerCase()}`);
    if (!opts.focus) await this.reg.updateRun(runId, { summary: u.summary, entities: u.entities });
    detail(u.summary);
    const concepts = u.concepts.filter((c) => opts.focus || !certified.includes(c.key));
    const total = concepts.reduce((n, c) => n + c.candidates.length, 0);

    step(`Checking ${total} definitions against your data`);
    const w = windows();
    const results = await Promise.all(concepts.map(async (c) => ({ c, v: await Promise.all(c.candidates.map((d) => verify(wh, d, snap, w))) })));

    const broken = results.flatMap(({ c, v }) => v.map((x, i) => ({ x, i, c })).filter(({ x }) => !x.ok)
      .map(({ x, i, c }) => ({ ref: `${c.key}#${i}`, kind: c.candidates[i].kind, sql: c.candidates[i].sql, membersSql: c.candidates[i].membersSql, error: x.error ?? "unknown" })));
    if (broken.length) {
      detail(`${broken.length} definition${broken.length > 1 ? "s" : ""} failed on your database; asking the model to repair ${broken.length > 1 ? "them" : "it"} with the error message`);
      try {
        const fixes = await repair(payload, broken, count);
        for (const f of fixes) {
          const [key, idx] = f.ref.split("#");
          const r = results.find((x) => x.c.key === key);
          const i = Number(idx);
          if (!r || !r.c.candidates[i]) continue;
          r.c.candidates[i] = { ...r.c.candidates[i], sql: f.sql, membersSql: f.members_sql ?? r.c.candidates[i].membersSql };
          r.v[i] = await verify(wh, r.c.candidates[i], snap, w);
        }
      } catch (e) {
        detail(`Repair failed: ${(e as Error).message}`);
      }
    }

    step("Comparing competing definitions");
    let saved = 0, contested = 0;
    for (const { c, v } of results) {
      const keep = c.candidates.map((d, i) => ({ d, v: v[i] })).filter((x) => x.v.ok);
      const dropped = c.candidates.length - keep.length;
      if (!keep.length) { detail(`Dropped “${c.name}”: no definition ran successfully (${v[0]?.error ?? "error"})`); continue; }
      if (dropped) detail(`${c.name}: dropped ${dropped} definition${dropped > 1 ? "s" : ""} that still failed`);
      const spec = { ...c, candidates: keep.map((x) => x.d) };
      const id = await this.reg.saveConcept(runId, spec, keep.map((x) => x.v), null);
      const concept = (await this.reg.concept(id))!;
      let line = `${c.name} · ${display(keep[0].v.value, keep[0].d.unit)}`;
      if (concept.candidates.length > 1) {
        const cmp = await compare(wh, concept.candidates, snap, w);
        await this.reg.setComparison(id, cmp);
        if ((cmp.spread ?? 0) > 0.005) { contested++; line += ` · ${concept.candidates.length} definitions disagree by ${Math.round((cmp.spread ?? 0) * 100)}%`; }
        else line += ` · ${concept.candidates.length} definitions agree`;
      }
      write("found", line);
      saved++;
    }
    detail(`Model usage: ${fmt(usage.input)} tokens in, ${fmt(usage.output + usage.thinking)} out (${fmt(usage.thinking)} thinking). No rows were sent.`);
    step(`Found ${saved} metric${saved === 1 ? "" : "s"}${contested ? `, ${contested} with competing definitions` : ""}. Nothing is certified until you say so.`);
    await log;
    await this.reg.updateRun(runId, { status: "done" });
  }

  async run(id: number) {
    const r = await this.reg.run(id);
    if (!r) throw new CreamaError("Run not found.", 404);
    return r;
  }

  // ---------- SQL editor and table browser (read-only, for people) ----------

  async sql(sql: string, limit?: number) {
    if (!sql?.trim()) throw new CreamaError("Write a query first.");
    try { return await runSql((await this.warehouse()), sql, limit); }
    catch (e) { throw e instanceof ExploreError ? new CreamaError(e.message) : new CreamaError(pgError(e), 422); }
  }

  async tableRows(qualified: string, opts: { limit?: number; offset?: number; order?: string | null; dir?: string | null }) {
    const t = (await this.tables()).find((x) => x.qualified === qualified || x.name === qualified);
    if (!t) throw new CreamaError(`No table “${qualified}”.`, 404);
    try { return await tableRows((await this.warehouse()), t, opts); }
    catch (e) { throw e instanceof ExploreError ? new CreamaError(e.message) : new CreamaError(pgError(e), 422); }
  }

  async queries() { return await this.reg.queries(); }

  async saveQuery(input: { id?: number | null; name?: string; sql?: string }, actor: string) {
    const name = (input.name ?? "").trim() || "Untitled query";
    if (!input.sql?.trim()) throw new CreamaError("Nothing to save: the query is empty.");
    return await this.reg.saveQuery({ id: input.id ?? null, name: name.slice(0, 120), sql: input.sql }, actor);
  }

  async deleteQuery(id: number, actor: string) { return await this.reg.deleteQuery(id, actor); }

  // ---------- schema map ----------

  /** Tables, their profiles and meaning, plus which metrics and proposals read each one. */
  async schemaMap() {
    const latest = await this.reg.latestRun({ withSummary: true }) ?? await this.reg.latestRun();
    const snap = latest ? await this.reg.runSnapshot<SchemaSnapshot>(latest.id) : null;
    const tables = snap?.tables ?? (await this.tables());
    const usage: Record<string, { kind: "metric" | "proposal"; ref: string; name: string; contested: boolean }[]> = {};
    const use = (rel: string, u: (typeof usage)[string][number]) => {
      const list = (usage[rel] ??= []);
      if (!list.some((x) => x.kind === u.kind && x.ref === u.ref)) list.push(u);
    };
    for (const m of await this.reg.metrics()) for (const rel of m.current.verification.relations) use(rel, { kind: "metric", ref: m.key, name: m.name, contested: false });
    for (const c of await this.reg.concepts(["open"])) {
      const contested = c.candidates.length > 1 && (c.comparison?.spread ?? 0) > 0.005;
      for (const cand of c.candidates) for (const rel of cand.verification?.relations ?? []) use(rel, { kind: "proposal", ref: String(c.id), name: c.name, contested });
    }
    return {
      database: (await this.connection())?.database ?? null,
      scannedAt: latest?.startedAt ?? null,
      tables,
      profiles: snap?.profiles ?? [],
      entities: latest?.entities ?? [],
      usage,
    };
  }

  // ---------- review ----------

  private async liveSchema(): Promise<SchemaSnapshot> {
    const latest = await this.reg.latestRun({ withSummary: true }) ?? await this.reg.latestRun();
    const cached = latest ? await this.reg.runSnapshot<SchemaSnapshot>(latest.id) : null;
    const tables = await this.tables(true);
    if (cached) return { tables, profiles: cached.profiles };
    return snapshot((await this.warehouse()));
  }

  private async tables(fresh = false): Promise<Table[]> {
    const url = (await this.connectionUrl())!;
    if (!fresh && this.tablesCache && this.tablesCache.url === url && Date.now() - this.tablesCache.at < 30_000) return this.tablesCache.tables;
    const tables = await introspect((await this.warehouse()));
    this.tablesCache = { at: Date.now(), url, tables };
    return tables;
  }

  /** Runs an (edited) definition without saving anything. */
  async preview(def: Pick<CandidateSpec, "kind" | "unit" | "sql" | "membersSql" | "memberTable">): Promise<Verification> {
    return verify((await this.warehouse()), def, await this.liveSchema());
  }

  async certify(input: { conceptId: number; candidateId: number; edits?: Edits; actor: string; note?: string | null }): Promise<MetricVersion> {
    const actor = requireActor(input.actor);
    const concept = await this.reg.concept(input.conceptId);
    if (!concept) throw new CreamaError("Proposal not found.", 404);
    if (concept.status !== "open") throw new CreamaError(`This proposal is already ${concept.status}.`, 409);
    const cand = concept.candidates.find((c) => c.id === input.candidateId);
    if (!cand) throw new CreamaError("Definition not found in this proposal.", 404);

    const e = input.edits ?? {};
    const key = slug(e.key ?? concept.key);
    const existing = await this.reg.metric(key);
    if (existing) throw new CreamaError(`A metric with key “${key}” is already certified. Choose another key or revise that metric.`, 409);

    const def = mergeDef(cand, e);
    const edited = def.sql !== cand.sql || def.membersSql !== cand.membersSql || def.kind !== cand.kind || def.unit !== cand.unit;
    const version = await this.saveVersion({
      metricKey: key,
      name: (e.name ?? concept.name).trim(),
      question: (e.question ?? concept.question).trim(),
      description: (e.description ?? cand.description).trim(),
      ...def,
      origin: edited ? "ai+human-edit" : "ai",
      candidateId: cand.id,
      certifiedBy: actor,
      note: input.note?.trim() || null,
    }, actor, async (c) => {
      await this.reg.setConceptStatus(concept.id, "certified", key, c);
      await this.reg.event(actor, "proposal.certified", `proposal:${concept.id}`, { metric: key, candidate: cand.label, alternatives: concept.candidates.filter((x) => x.id !== cand.id).map((x) => x.label) }, c);
    });
    return version;
  }

  /** A metric written by a person from scratch: no AI proposal involved. Verified like any other. */
  async create(input: { edits: Edits; actor: string; note?: string | null }): Promise<MetricVersion> {
    const actor = requireActor(input.actor);
    const e = input.edits;
    const name = (e.name ?? "").trim();
    if (!name) throw new CreamaError("A metric needs a name.");
    if (!e.sql?.trim()) throw new CreamaError("A metric needs a SQL definition.");
    const key = slug(e.key || name);
    if (await this.reg.metric(key)) throw new CreamaError(`A metric with key “${key}” already exists. Choose another key or revise that metric.`, 409);
    const def = mergeDef({ kind: "snapshot", unit: "number", sql: "", membersSql: null, memberTable: null }, e);
    const version = await this.saveVersion({
      metricKey: key,
      name,
      question: (e.question ?? "").trim() || name,
      description: (e.description ?? "").trim() || name,
      ...def,
      origin: "human",
      candidateId: null,
      certifiedBy: actor,
      note: input.note?.trim() || null,
    }, actor);
    await this.reg.event(actor, "metric.created", key, { by: "hand" });
    return version;
  }

  /** A new immutable version of an already-certified metric. */
  async revise(input: { key: string; edits: Edits; actor: string; note?: string | null }): Promise<MetricVersion> {
    const actor = requireActor(input.actor);
    const m = await this.reg.metric(input.key);
    if (!m) throw new CreamaError("Metric not found.", 404);
    const cur = m.current;
    const def = mergeDef(cur, input.edits);
    return this.saveVersion({
      metricKey: m.key,
      name: (input.edits.name ?? cur.name).trim(),
      question: (input.edits.question ?? cur.question).trim(),
      description: (input.edits.description ?? cur.description).trim(),
      ...def,
      origin: cur.origin === "human" ? "human" : "ai+human-edit",
      candidateId: cur.candidateId,
      certifiedBy: actor,
      note: input.note?.trim() || null,
    }, actor);
  }

  private async saveVersion(v: Omit<MetricVersion, "version" | "certifiedAt" | "fingerprint" | "verification">, owner: string, after?: Parameters<Registry["certify"]>[2]) {
    if (!v.name) throw new CreamaError("A metric needs a name.");
    // Store the SQL exactly as consumers will run it: the series wrapper embeds it as a subquery,
    // so a trailing ";" that passed verification would break every later read.
    try {
      v = { ...v, sql: assertSingleSelect(v.sql), membersSql: v.membersSql ? assertSingleSelect(v.membersSql) : v.membersSql };
    } catch (e) {
      if (e instanceof SqlContractError) throw new CreamaError(`Not certified: ${e.message}`, 422);
      throw e;
    }
    const schema = await this.liveSchema();
    const verification = await verify((await this.warehouse()), v, schema);
    if (!verification.ok) throw new CreamaError(`Not certified: the definition fails on your database right now. ${verification.error ?? ""}`.trim(), 422);
    const failing = verification.checks.filter((c) => c.level === "fail");
    if (failing.length) throw new CreamaError(`Not certified: ${failing.map((c) => c.message).join(" ")}`, 422);
    return this.reg.certify({ ...v, fingerprint: fingerprint(verification.relations, schema.tables), verification }, owner, after);
  }

  async dismiss(conceptId: number, actor: string, reason?: string | null) {
    const who = requireActor(actor);
    const c = await this.reg.concept(conceptId);
    if (!c) throw new CreamaError("Proposal not found.", 404);
    await this.reg.setConceptStatus(conceptId, "dismissed");
    await this.reg.event(who, "proposal.dismissed", `proposal:${conceptId}`, { key: c.key, reason: reason ?? null });
  }

  async reopen(conceptId: number, actor: string) {
    const who = requireActor(actor);
    const c = await this.reg.concept(conceptId);
    if (!c || c.status !== "dismissed") throw new CreamaError("Only dismissed proposals can be reopened.", 409);
    await this.reg.setConceptStatus(conceptId, "open");
    await this.reg.event(who, "proposal.reopened", `proposal:${conceptId}`, { key: c.key });
  }

  async retire(key: string, actor: string, reason?: string | null) {
    const who = requireActor(actor);
    if (!await this.reg.metric(key)) throw new CreamaError("Metric not found.", 404);
    await this.reg.setMetricStatus(key, "retired");
    await this.reg.event(who, "metric.retired", key, { reason: reason ?? null });
  }

  // ---------- reuse ----------

  async listMetrics() {
    return (await this.reg.metrics()).map(contract);
  }

  async getMetric(key: string) {
    const m = await this.reg.metric(key);
    if (!m || m.status !== "certified") throw new CreamaError(`No certified metric “${key}”. Only certified metrics can be read.`, 404);
    const [versions, events] = await Promise.all([this.reg.versions(key), this.reg.events(50, key)]);
    return { ...contract(m), history: versions.map((v) => ({ version: v.version, certifiedBy: v.certifiedBy, certifiedAt: v.certifiedAt, note: v.note, origin: v.origin, sql: v.sql, description: v.description })), events };
  }

  async query(key: string, opts: { from?: string; to?: string; grain?: Grain | null; version?: number } = {}) {
    const m = await this.reg.metric(key);
    if (!m || m.status !== "certified") throw new CreamaError(`No certified metric “${key}”. Only certified metrics can be queried.`, 404);
    const v = opts.version ? await this.reg.version(key, opts.version) : m.current;
    if (!v) throw new CreamaError(`Version ${opts.version} of “${key}” does not exist.`, 404);

    const to = opts.to ? parseDate(opts.to, "to") : new Date();
    const from = opts.from ? parseDate(opts.from, "from") : new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), 1));
    if (from >= to) throw new CreamaError("`from` must be before `to`.");

    const wh = (await this.warehouse());
    const drift = driftedRelations(v.fingerprint, await this.tables());
    const meta = {
      metric: key, name: v.name, version: v.version, latestVersion: m.currentVersion, unit: v.unit, kind: v.kind,
      certifiedBy: v.certifiedBy, certifiedAt: v.certifiedAt,
      trust: drift.length ? ("drifted" as const) : ("certified" as const),
      drift: drift.length ? `Schema changed since certification in: ${drift.join(", ")}. Re-verify before relying on this number.` : null,
    };

    try {
      if (!opts.grain) {
        const b = bind(v.sql, { start: from.toISOString(), end: to.toISOString(), at: to.toISOString() });
        const [row] = await wh.query<{ value: unknown }>(b.text, b.values);
        return { ...meta, from: from.toISOString(), to: to.toISOString(), value: num(row?.value) };
      }
      const start = truncate(from, opts.grain);
      const buckets = estimateBuckets(start, to, opts.grain);
      if (buckets > 500) throw new CreamaError(`That would be ${buckets} ${opts.grain}s; narrow the range or use a coarser grain.`);
      const rows = await wh.query<{ bucket_start: Date; value: unknown }>(seriesSql(v.sql), [start.toISOString(), to.toISOString(), INTERVAL[opts.grain], to.toISOString()], 20_000);
      return {
        ...meta, from: start.toISOString(), to: to.toISOString(), grain: opts.grain,
        // the last bucket is usually still in progress: say so instead of letting it look like a drop
        points: rows.filter((r) => new Date(r.bucket_start) < to).map((r) => {
          const start = new Date(r.bucket_start);
          return { start: start.toISOString(), value: num(r.value), ...(bucketEnd(start, opts.grain!) > to ? { partial: true } : {}) };
        }),
      };
    } catch (e) {
      if (e instanceof CreamaError) throw e;
      throw new CreamaError(`The certified definition failed: ${pgError(e)}`, 502);
    }
  }

  async audit(limit = 100) {
    return await this.reg.events(limit);
  }
}

// ---------- helpers ----------

function contract(m: Metric) {
  const v = m.current;
  return {
    key: m.key, name: v.name, question: v.question, description: v.description,
    kind: v.kind, unit: v.unit, version: v.version,
    certifiedBy: v.certifiedBy, certifiedAt: v.certifiedAt, owner: m.owner, origin: v.origin,
    sql: v.sql, dependsOn: Object.keys(v.fingerprint),
    latest: { value: v.verification.value, window: v.verification.window, series: v.verification.series },
  };
}

function mergeDef(base: Pick<CandidateSpec, "kind" | "unit" | "sql" | "membersSql" | "memberTable">, e: Edits) {
  const sql = (e.sql ?? base.sql).trim();
  const membersSql = e.membersSql === undefined ? base.membersSql : e.membersSql?.trim() || null;
  return { kind: e.kind ?? base.kind, unit: e.unit ?? base.unit, sql, membersSql, memberTable: membersSql ? base.memberTable : null };
}

function requireActor(actor: string | undefined | null): string {
  const a = (actor ?? "").trim();
  if (!a || a === "anonymous") throw new CreamaError("Certifying needs a name: who is vouching for this definition?", 401);
  return a.slice(0, 80);
}

function slug(s: string) {
  const k = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!k) throw new CreamaError("A metric needs a key.");
  return k;
}

function parseDate(s: string, name: string): Date {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) throw new CreamaError(`Invalid \`${name}\` date: ${s}`);
  return d;
}

const INTERVAL: Record<Grain, string> = { day: "1 day", week: "1 week", month: "1 month", quarter: "3 months", year: "1 year" };

function truncate(d: Date, grain: Grain): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  switch (grain) {
    case "day": return new Date(Date.UTC(y, m, d.getUTCDate()));
    case "week": { const x = new Date(Date.UTC(y, m, d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; }
    case "month": return new Date(Date.UTC(y, m, 1));
    case "quarter": return new Date(Date.UTC(y, m - (m % 3), 1));
    case "year": return new Date(Date.UTC(y, 0, 1));
  }
}

function bucketEnd(start: Date, grain: Grain): Date {
  const d = new Date(start);
  if (grain === "day") d.setUTCDate(d.getUTCDate() + 1);
  else if (grain === "week") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + (grain === "month" ? 1 : grain === "quarter" ? 3 : 12));
  return d;
}

function estimateBuckets(from: Date, to: Date, grain: Grain) {
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  return Math.ceil(days / { day: 1, week: 7, month: 30, quarter: 91, year: 365 }[grain]);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Same rule as the registry: shared across route bundles, rebuilt only when the code changed.
let shared: Creama | null = (globalThis as any).__creama ?? null;
export function creama(): Creama {
  const id = implId(Creama);
  if (!shared || (shared as any).__impl !== id || shared.reg !== registry()) {
    const fresh = !shared;
    shared = (globalThis as any).__creama = Object.assign(new Creama(), { __impl: id });
    // a previous process can't be finishing these anymore (a hot reload in the same process still can)
    if (fresh) void shared.reg.failStaleRuns("Interrupted: the server restarted during discovery.").catch(() => {});
  }
  return shared;
}

export type { Candidate, Concept };
