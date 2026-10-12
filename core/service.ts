// The application API. Web routes, the REST API, the CLI and the MCP servers are thin adapters over
// this class. Invariants:
//   - AI output is only ever a proposal; a metric becomes certified solely through certify()/create()/
//     revise(), which require a named human and re-verify the definition against the live database.
//   - Everything analytical belongs to one source. A metric runs on the source it was certified on,
//     never on "whatever is connected", and is not served while its tables have drifted.
import { compare } from "./compare";
import { ExploreError, runSql, tableRows } from "./explore";
import { currentCurrency, display, fmt } from "./format";
import { Hosting, HostingError } from "./hosting";
import { modelConfigured, modelName, thinkingLevel, type Usage } from "./model";
import { propose, repair } from "./propose";
import { DEFAULT_WORKSPACE, implId, Registry, registry } from "./registry";
import { introspect, modelPayload, snapshot } from "./schema";
import { seal, unseal } from "./secret";
import type { Candidate, CandidateSpec, Concept, Metric, MetricKind, MetricUnit, MetricVersion, SchemaSnapshot, Source, Table, Verification } from "./types";
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

/** Who a request acts for: a workspace, and (for everything analytical) one of its sources. */
export type Scope = { workspaceId: string; source: Source | null };

// introspection is cached per source for 30s: the schema map, table browser and drift checks share it
const tablesCache: Map<number, { at: number; tables: Table[] }> = ((globalThis as any).__creamaTables ??= new Map());

export class Creama {
  constructor(readonly reg: Registry = registry(), readonly scope: Scope = { workspaceId: DEFAULT_WORKSPACE, source: null }) {}

  /** The same service, pointed at one of the workspace's sources. */
  async withSource(idOrSlug: number | string): Promise<Creama> {
    const source = await this.reg.source(this.scope.workspaceId, idOrSlug);
    if (!source) throw new CreamaError(`No database “${idOrSlug}” in this workspace.`, 404);
    return new Creama(this.reg, { ...this.scope, source });
  }

  src(): Source {
    if (!this.scope.source) throw new CreamaError("Choose a database first.", 409);
    return this.scope.source;
  }
  private ev(actor: string, action: string, subject: string, detail?: unknown, source: Source | null = this.scope.source) {
    return this.reg.event({ workspaceId: this.scope.workspaceId, sourceId: source?.id ?? null }, actor, action, subject, detail);
  }

  /** The read-only connection Creama queries a source with. */
  async warehouse(source: Source = this.src()): Promise<Warehouse> {
    if (source.status !== "ready") throw new CreamaError(`${source.name} isn’t ready (${source.status}${source.error ? `: ${source.error}` : ""}).`, 409);
    const sealed = (await this.reg.sourceSecrets(source.id)).connection;
    let url = "";
    try { url = sealed ? unseal(sealed) : ""; } catch { /* encryption key changed */ }
    if (!url) throw new CreamaError(`Creama can’t read the connection for ${source.name} (the encryption key may have changed). Reconnect it.`, 409);
    return new Warehouse(url);
  }

  // ---------- sources (workspace level) ----------

  /** Every database in the workspace, with what Creama knows about each. */
  async sources() {
    const list = await this.reg.sources(this.scope.workspaceId);
    const h = Hosting.fromEnv();
    const hosted = list.filter((s) => s.kind === "hosted" && s.status === "ready" && s.dbName);
    const info = h && hosted.length ? await h.info(hosted.map((s) => s.dbName!)).catch(() => null) : null;
    return Promise.all(list.map(async (s) => {
      const [metrics, open] = await Promise.all([this.reg.metrics(s.id), this.reg.concepts(s.id, ["open"])]);
      const i = s.dbName ? info?.[s.dbName] : undefined;
      return {
        ...s,
        metrics: metrics.length, proposals: open.length, attention: metrics.filter((m) => m.status === "needs_attention").length,
        sizeBytes: i?.sizeBytes ?? null, connections: i?.connections ?? null,
        missing: s.kind === "hosted" && s.status === "ready" && info !== null && !i, // reconciliation: gone from the cluster
      };
    }));
  }

  /** Connect a database you already have. Creama reads it in READ ONLY transactions; a read-only role is still advised. */
  async addExternal(url: string, actor: string, name?: string) {
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
    const label = (name ?? "").trim() || info.db;
    const source = await this.reg.addSource(this.scope.workspaceId, {
      slug: await this.reg.freeSlug(this.scope.workspaceId, slugify(label)), name: label, kind: "external",
      connection: seal(url), readOnly: info.ro === "on" || info.writable === 0, writableTables: info.writable,
    }, actor);
    return { source, ...describeUrl(url), tables: info.tables, writableTables: info.writable, readOnlyRole: info.ro === "on" };
  }

  // ---------- hosted databases: Postgres Creama creates for apps elsewhere ----------

  private hosting(): Hosting {
    const h = Hosting.fromEnv();
    if (!h) throw new CreamaError("Database hosting needs a Postgres server: set CREAMA_HOSTING_ADMIN_URL.", 409);
    return h;
  }

  async hostingStatus() {
    const h = Hosting.fromEnv();
    const check = h ? await h.canAdminister() : { ok: false, reason: "No Postgres server configured for hosting." };
    return { enabled: check.ok, reason: check.ok ? null : check.reason ?? null, shared: h?.shared ?? false, address: h ? `${h.publicAddress.host}:${h.publicAddress.port}` : null, ssl: h?.publicAddress.ssl ?? false };
  }

  /**
   * Creates a database for an app and adds it as a source. The source row comes first (status
   * "provisioning"), so a failure part-way leaves a visible, retryable record instead of orphans.
   */
  async createHosted(name: string, actor: string) {
    const h = this.hosting();
    if (!name?.trim()) throw new CreamaError("Give the database a name.");
    let dbName: string;
    try { dbName = Hosting.dbNameFor(name); } catch (e) { throw hostingError(e); }
    if ((await this.reg.sources(this.scope.workspaceId)).some((s) => s.dbName === dbName)) throw new CreamaError(`A database named “${dbName}” already exists.`, 409);
    const source = await this.reg.addSource(this.scope.workspaceId, {
      slug: await this.reg.freeSlug(this.scope.workspaceId, dbName.replace(/^app_/, "")), name: name.trim().slice(0, 80),
      kind: "hosted", status: "provisioning", dbName, readOnly: true,
    }, actor);
    await this.provision(h, source, actor);
    return (await this.reg.source(this.scope.workspaceId, source.id))!;
  }

  /** Run provisioning again for a hosted source that failed. */
  async retryHosted(id: number, actor: string) {
    const h = this.hosting();
    const source = await this.reg.source(this.scope.workspaceId, id);
    if (!source || source.kind !== "hosted") throw new CreamaError("Hosted database not found.", 404);
    if (source.status !== "failed") throw new CreamaError("Only a database that failed to provision can be retried.", 409);
    await this.provision(h, source, actor);
    return (await this.reg.source(this.scope.workspaceId, id))!;
  }

  private async provision(h: Hosting, source: Source, actor: string) {
    const dbName = source.dbName!;
    await this.reg.updateSource(source.id, { status: "provisioning", error: null });
    try {
      const r = await h.create(dbName);
      await this.reg.updateSource(source.id, {
        status: "ready", error: null, readOnly: true,
        connection: seal(h.internalUrl(dbName, r.reader, r.readerPassword)),
        ownerPassword: seal(r.ownerPassword), readerPassword: seal(r.readerPassword),
      });
    } catch (e) {
      const message = hostingError(e).message;
      // Hosting.create cleans up only resources this attempt actually created. Never drop by
      // name here: the error may be a collision with somebody else's existing database.
      await this.reg.updateSource(source.id, { status: "failed", error: message });
      await this.ev(actor, "source.provisioning_failed", `source:${source.slug}`, { dbName, error: message }, source);
      throw new CreamaError(`Could not create ${dbName}: ${message}`, 502);
    }
    await this.ev(actor, "source.provisioned", `source:${source.slug}`, { dbName }, source);
  }

  /** Host, user, password… for one of a hosted database's logins. Admin only (enforced by the route). */
  async hostedConnection(id: number, role: "owner" | "reader") {
    const h = this.hosting();
    const source = await this.reg.source(this.scope.workspaceId, id);
    if (!source || source.kind !== "hosted" || !source.dbName) throw new CreamaError("Hosted database not found.", 404);
    const secrets = await this.reg.sourceSecrets(id);
    const sealed = role === "owner" ? secrets.ownerPassword : secrets.readerPassword;
    let pw = "";
    try { pw = sealed ? unseal(sealed) : ""; } catch { /* key changed */ }
    if (!pw) throw new CreamaError("This password can’t be shown (it was never stored, or the encryption key changed). Reset it to get a new one.", 409);
    return h.connectionParts(source.dbName, `${source.dbName}_${role === "owner" ? "owner" : "creama"}`, pw);
  }

  async resetHostedPassword(id: number, actor: string, role: "owner" | "reader" = "owner") {
    const h = this.hosting();
    const source = await this.reg.source(this.scope.workspaceId, id);
    if (!source || source.kind !== "hosted" || !source.dbName) throw new CreamaError("Hosted database not found.", 404);
    const login = `${source.dbName}_${role === "owner" ? "owner" : "creama"}`;
    let pw: string;
    try { pw = await h.resetPassword(login); } catch (e) { throw hostingError(e); }
    // the role already has the new password: record it, and Creama's own connection when it's the reader
    try {
      await this.reg.updateSource(id, role === "owner" ? { ownerPassword: seal(pw) } : { readerPassword: seal(pw), connection: seal(h.internalUrl(source.dbName, login, pw)) });
    } catch (e) {
      throw new CreamaError(`The password was changed but couldn’t be saved (${(e as Error).message}). Reset it again.`, 500);
    }
    await this.ev(actor, "source.password_reset", `source:${source.slug}`, { role }, source);
    return this.hostedConnection(id, role);
  }

  /** Remove a database from the workspace. A hosted one is dropped with its data; an external one is only forgotten. */
  async removeSource(id: number, actor: string) {
    const source = await this.reg.source(this.scope.workspaceId, id);
    if (!source) throw new CreamaError("Database not found.", 404);
    if (source.kind === "hosted" && source.dbName) {
      try { await this.hosting().drop(source.dbName); } catch (e) { throw hostingError(e); }
    }
    await this.reg.removeSource(source, actor);
    tablesCache.delete(source.id);
  }

  // ---------- overview of one source ----------

  async state() {
    const source = this.scope.source;
    const [sources, hosting] = await Promise.all([this.sources(), this.hostingStatus()]);
    const base = { workspace: this.scope.workspaceId, sources, hosting, model: { name: modelName(), configured: modelConfigured() }, currency: currentCurrency() };
    if (!source) return { ...base, source: null, run: null, understanding: null, proposals: [] as Concept[], rejected: [] as Concept[], metrics: [] as Metric[] };
    const [run, understood, proposals, rejected, metrics] = await Promise.all([
      this.reg.latestRun(source.id), this.reg.latestRun(source.id, { withSummary: true }),
      this.reg.concepts(source.id, ["open"]), this.reg.concepts(source.id, ["rejected"]), this.reg.metrics(source.id),
    ]);
    return {
      ...base, source,
      run: run && { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error },
      understanding: understood && { runId: understood.id, summary: understood.summary, entities: understood.entities, model: understood.model, at: understood.startedAt },
      proposals, rejected, metrics,
    };
  }

  // ---------- discovery ----------

  async startDiscovery(opts: { hint?: string | null; focus?: string | null; actor?: string } = {}): Promise<number> {
    const source = this.src();
    const running = await this.reg.latestRun(source.id);
    if (running?.status === "running") return running.id;
    if (!modelConfigured()) throw new CreamaError("No model configured. Set GEMINI_API_KEY and restart.", 409);
    await this.warehouse();
    const { enqueueDiscovery } = await import("./jobs");
    return enqueueDiscovery(this.reg, { workspaceId: this.scope.workspaceId, sourceId: source.id,
      model: modelName(), hint: opts.hint ?? null, focus: opts.focus ?? null, actor: opts.actor ?? "anonymous" });
  }

  async discover(runId: number, opts: { hint?: string | null; focus?: string | null } = {}) {
    const source = this.src();
    const wh = await this.warehouse();
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
    const certified = (await this.reg.metrics(source.id, { includeDeprecated: true })).map((m) => m.key);
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
      const id = await this.reg.saveConcept(source.id, runId, spec, keep.map((x) => x.v), null);
      const concept = (await this.reg.concept(source.id, id))!;
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
    const { reconcileRun } = await import("./jobs");
    await this.reg.db.ready;
    await reconcileRun(this.reg, this.src().id, id);
    const r = await this.reg.run(this.src().id, id);
    if (!r) throw new CreamaError("Run not found.", 404);
    return r;
  }

  // ---------- SQL editor and table browser (read-only, for people) ----------

  async sql(sql: string, limit?: number) {
    if (!sql?.trim()) throw new CreamaError("Write a query first.");
    try { return await runSql(await this.warehouse(), sql, limit); }
    catch (e) { throw e instanceof CreamaError ? e : e instanceof ExploreError ? new CreamaError(e.message) : new CreamaError(pgError(e), 422); }
  }

  async tableRows(qualified: string, opts: { limit?: number; offset?: number; order?: string | null; dir?: string | null }) {
    const t = (await this.tables()).find((x) => x.qualified === qualified || x.name === qualified);
    if (!t) throw new CreamaError(`No table “${qualified}”.`, 404);
    try { return await tableRows(await this.warehouse(), t, opts); }
    catch (e) { throw e instanceof CreamaError ? e : e instanceof ExploreError ? new CreamaError(e.message) : new CreamaError(pgError(e), 422); }
  }

  async queries() { return this.reg.queries(this.src().id); }

  async saveQuery(input: { id?: number | null; name?: string; sql?: string }, actor: string) {
    const name = (input.name ?? "").trim() || "Untitled query";
    if (!input.sql?.trim()) throw new CreamaError("Nothing to save: the query is empty.");
    return this.reg.saveQuery(this.src(), { id: input.id ?? null, name: name.slice(0, 120), sql: input.sql }, actor);
  }

  async deleteQuery(id: number, actor: string) { return this.reg.deleteQuery(this.src(), id, actor); }

  // ---------- schema map ----------

  /** Tables, their profiles and meaning, plus which metrics and proposals read each one. */
  async schemaMap() {
    const source = this.src();
    const latest = (await this.reg.latestRun(source.id, { withSummary: true })) ?? (await this.reg.latestRun(source.id));
    const snap = latest ? await this.reg.runSnapshot<SchemaSnapshot>(latest.id) : null;
    const tables = snap?.tables ?? (await this.tables());
    const usage: Record<string, { kind: "metric" | "proposal"; ref: string; name: string; contested: boolean }[]> = {};
    const use = (rel: string, u: (typeof usage)[string][number]) => {
      const list = (usage[rel] ??= []);
      if (!list.some((x) => x.kind === u.kind && x.ref === u.ref)) list.push(u);
    };
    for (const m of await this.reg.metrics(source.id)) for (const rel of m.current.verification.relations) use(rel, { kind: "metric", ref: m.key, name: m.name, contested: false });
    for (const c of await this.reg.concepts(source.id, ["open"])) {
      const contested = c.candidates.length > 1 && (c.comparison?.spread ?? 0) > 0.005;
      for (const cand of c.candidates) for (const rel of cand.verification?.relations ?? []) use(rel, { kind: "proposal", ref: String(c.id), name: c.name, contested });
    }
    return { database: source.name, scannedAt: latest?.startedAt ?? null, tables, profiles: snap?.profiles ?? [], entities: latest?.entities ?? [], usage };
  }

  // ---------- review ----------

  private async liveSchema(): Promise<SchemaSnapshot> {
    const source = this.src();
    const latest = (await this.reg.latestRun(source.id, { withSummary: true })) ?? (await this.reg.latestRun(source.id));
    const cached = latest ? await this.reg.runSnapshot<SchemaSnapshot>(latest.id) : null;
    const tables = await this.tables(true);
    if (cached) return { tables, profiles: cached.profiles };
    return snapshot(await this.warehouse());
  }

  async tables(fresh = false, source: Source = this.src()): Promise<Table[]> {
    const hit = tablesCache.get(source.id);
    if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.tables;
    const tables = await introspect(await this.warehouse(source));
    tablesCache.set(source.id, { at: Date.now(), tables });
    return tables;
  }

  /** Runs an (edited) definition without saving anything. */
  async preview(def: Pick<CandidateSpec, "kind" | "unit" | "sql" | "membersSql" | "memberTable">): Promise<Verification> {
    return verify(await this.warehouse(), def, await this.liveSchema());
  }

  async certify(input: { conceptId: number; candidateId: number; edits?: Edits; actor: string; note?: string | null }): Promise<MetricVersion> {
    const source = this.src();
    const actor = requireActor(input.actor);
    const concept = await this.reg.concept(source.id, input.conceptId);
    if (!concept) throw new CreamaError("Proposal not found.", 404);
    if (concept.status !== "open") throw new CreamaError(`This proposal is already ${concept.status}.`, 409);
    const cand = concept.candidates.find((c) => c.id === input.candidateId);
    if (!cand) throw new CreamaError("Definition not found in this proposal.", 404);

    const e = input.edits ?? {};
    const key = slug(e.key ?? concept.key);
    if (await this.reg.metric(source.id, key)) throw new CreamaError(`A metric with key “${key}” is already certified in ${source.name}. Choose another key or revise that metric.`, 409);

    const def = mergeDef(cand, e);
    const edited = def.sql !== cand.sql || def.membersSql !== cand.membersSql || def.kind !== cand.kind || def.unit !== cand.unit;
    return this.saveVersion({
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
      await this.reg.event({ workspaceId: source.workspaceId, sourceId: source.id }, actor, "proposal.certified", `proposal:${concept.id}`, { metric: key, candidate: cand.label, alternatives: concept.candidates.filter((x) => x.id !== cand.id).map((x) => x.label) }, c);
    });
  }

  /** A metric written by a person from scratch: no AI proposal involved. Verified like any other. */
  async create(input: { edits: Edits; actor: string; note?: string | null }): Promise<MetricVersion> {
    const source = this.src();
    const actor = requireActor(input.actor);
    const e = input.edits;
    const name = (e.name ?? "").trim();
    if (!name) throw new CreamaError("A metric needs a name.");
    if (!e.sql?.trim()) throw new CreamaError("A metric needs a SQL definition.");
    const key = slug(e.key || name);
    if (await this.reg.metric(source.id, key)) throw new CreamaError(`A metric with key “${key}” already exists in ${source.name}. Choose another key or revise that metric.`, 409);
    const def = mergeDef({ kind: "snapshot", unit: "number", sql: "", membersSql: null, memberTable: null }, e);
    const version = await this.saveVersion({
      metricKey: key, name,
      question: (e.question ?? "").trim() || name,
      description: (e.description ?? "").trim() || name,
      ...def, origin: "human", candidateId: null, certifiedBy: actor, note: input.note?.trim() || null,
    }, actor);
    await this.ev(actor, "metric.created", `metric:${source.slug}/${key}`, { by: "hand" });
    return version;
  }

  /** A new immutable version of an already-certified metric (also how a metric that needs attention is cleared). */
  async revise(input: { key: string; edits: Edits; actor: string; note?: string | null }): Promise<MetricVersion> {
    const actor = requireActor(input.actor);
    const m = await this.reg.metric(this.src().id, input.key);
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
      candidateId: cur.candidateId, certifiedBy: actor, note: input.note?.trim() || null,
    }, actor);
  }

  private async saveVersion(v: Omit<MetricVersion, "version" | "certifiedAt" | "fingerprint" | "verification">, owner: string, after?: Parameters<Registry["certify"]>[3]) {
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
    const verification = await verify(await this.warehouse(), v, schema);
    if (!verification.ok) throw new CreamaError(`Not certified: the definition fails on your database right now. ${verification.error ?? ""}`.trim(), 422);
    const failing = verification.checks.filter((c) => c.level === "fail");
    if (failing.length) throw new CreamaError(`Not certified: ${failing.map((c) => c.message).join(" ")}`, 422);
    return this.reg.certify(this.src(), { ...v, fingerprint: fingerprint(verification.relations, schema.tables), verification }, owner, after);
  }

  async reject(conceptId: number, actor: string, reason?: string | null) {
    const who = requireActor(actor);
    const c = await this.reg.concept(this.src().id, conceptId);
    if (!c) throw new CreamaError("Proposal not found.", 404);
    await this.reg.setConceptStatus(conceptId, "rejected");
    await this.ev(who, "proposal.rejected", `proposal:${conceptId}`, { key: c.key, reason: reason ?? null });
  }

  async reopen(conceptId: number, actor: string) {
    const who = requireActor(actor);
    const c = await this.reg.concept(this.src().id, conceptId);
    if (!c || c.status !== "rejected") throw new CreamaError("Only rejected proposals can be reopened.", 409);
    await this.reg.setConceptStatus(conceptId, "open");
    await this.ev(who, "proposal.reopened", `proposal:${conceptId}`, { key: c.key });
  }

  async deprecate(key: string, actor: string, reason?: string | null) {
    const who = requireActor(actor);
    const m = await this.reg.metric(this.src().id, key);
    if (!m) throw new CreamaError("Metric not found.", 404);
    await this.reg.setMetricStatus(m.id, "deprecated");
    await this.ev(who, "metric.deprecated", `metric:${this.src().slug}/${key}`, { reason: reason ?? null });
  }

  // ---------- reuse: certified metrics for software, AI and people ----------

  /** Every live metric in the workspace. `ref` ("source/key") addresses it everywhere else. */
  async listMetrics() {
    return (await this.reg.workspaceMetrics(this.scope.workspaceId)).map((m) => contract(m, m.sourceSlug));
  }

  /** "source/key" → the metric, scoped to this workspace. */
  async resolve(ref: string): Promise<{ svc: Creama; metric: Metric }> {
    const [sourceSlug, key, extra] = ref.split("/");
    if (!sourceSlug || !key || extra) throw new CreamaError(`A metric is addressed as “database/metric”, e.g. “demo/mrr” (got “${ref}”).`);
    const svc = await this.withSource(sourceSlug).catch(() => { throw new CreamaError(`No certified metric “${ref}”.`, 404); });
    const metric = await this.reg.metric(svc.src().id, key);
    if (!metric || metric.status === "deprecated") throw new CreamaError(`No certified metric “${ref}”. Only certified metrics can be read.`, 404);
    return { svc, metric };
  }

  async getMetric(ref: string) {
    const { svc, metric: m } = await this.resolve(ref);
    const [versions, events] = await Promise.all([this.reg.versions(m.id), this.reg.events(this.scope.workspaceId, { limit: 50, subject: `metric:${svc.src().slug}/${m.key}` })]);
    return {
      ...contract(m, svc.src().slug),
      history: versions.map((v) => ({ version: v.version, certifiedBy: v.certifiedBy, certifiedAt: v.certifiedAt, note: v.note, origin: v.origin, sql: v.sql, description: v.description })),
      events,
    };
  }

  /**
   * Values of a certified metric, on its own source. If the tables it reads changed since it was
   * certified, it's marked "needs attention" and not served until someone re-certifies it.
   */
  async query(ref: string, opts: { from?: string; to?: string; grain?: Grain | null; version?: number } = {}) {
    const { svc, metric: m } = await this.resolve(ref);
    const source = svc.src();
    const v = opts.version ? await this.reg.version(m.id, opts.version) : m.current;
    if (!v) throw new CreamaError(`Version ${opts.version} of “${ref}” does not exist.`, 404);

    const tables = await svc.tables(true, source);
    const drift = driftedRelations(v.fingerprint, tables);
    if (drift.length) {
      const why = `Schema changed since certification in: ${drift.join(", ")}.`;
      if (v.version === m.current.version && (m.status !== "needs_attention" || m.attention !== why)) await this.reg.setMetricStatus(m.id, "needs_attention", why);
      throw new CreamaError(`“${ref}” needs attention: ${why} It isn’t served until someone re-certifies it.`, 409);
    }
    if (m.status === "needs_attention" && !driftedRelations(m.current.fingerprint, tables).length) await this.reg.setMetricStatus(m.id, "certified"); // the schema came back

    const to = opts.to ? parseDate(opts.to, "to") : new Date();
    const from = opts.from ? parseDate(opts.from, "from") : new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), 1));
    if (from >= to) throw new CreamaError("`from` must be before `to`.");
    const wh = await svc.warehouse();
    const meta = {
      metric: ref, source: source.slug, key: m.key, name: v.name, version: v.version, latestVersion: m.currentVersion, unit: v.unit, kind: v.kind,
      certifiedBy: v.certifiedBy, certifiedAt: v.certifiedAt, trust: "certified" as const,
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
    return this.reg.events(this.scope.workspaceId, { limit, sourceId: this.scope.source?.id });
  }
}

// ---------- helpers ----------

function contract(m: Metric, sourceSlug: string) {
  const v = m.current;
  return {
    ref: `${sourceSlug}/${m.key}`, source: sourceSlug, key: m.key, name: v.name, question: v.question, description: v.description,
    kind: v.kind, unit: v.unit, version: v.version, status: m.status, attention: m.attention,
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

function hostingError(e: unknown): Error {
  if (e instanceof CreamaError) return e;
  if (e instanceof HostingError) return new CreamaError(e.message);
  return new CreamaError(`Hosting: ${pgError(e)}`, 502);
}

function requireActor(actor: string | undefined | null): string {
  const a = (actor ?? "").trim();
  if (!a || a === "anonymous") throw new CreamaError("Certifying needs a name: who is vouching for this definition?", 401);
  return a.slice(0, 80);
}

function slugify(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "db";
}

function slug(s: string) {
  const k = s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
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

/**
 * A service for one request's workspace (and source, when the request names one). Cheap: the
 * registry, pools and caches are shared. Stale discovery runs are closed once per process.
 */
export function creama(scope?: Partial<Scope>): Creama {
  const g = globalThis as any;
  const id = implId(Creama);
  if (g.__creamaBooted !== id) {
    g.__creamaBooted = id;
    void registry().failStaleRuns("Interrupted: the server restarted during discovery.").catch(() => {});
  }
  return new Creama(registry(), { workspaceId: scope?.workspaceId ?? DEFAULT_WORKSPACE, source: scope?.source ?? null });
}

export type { Candidate, Concept };
