"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { setCurrency } from "@/core/format";
import { api, contested, session, setCurrentSource, sourceHref, spreadOf, type AppState, type Run } from "@/lib/client";
import { ProposalView } from "./Proposal";
import { MetricView } from "./MetricView";
import { Overview } from "./Overview";
import { Registry } from "./Registry";
import { NewMetric } from "./NewMetric";
import { Schema } from "./Schema";
import { SqlEditor } from "./SqlEditor";
import { Tables } from "./Tables";
import { People } from "./People";
import { Databases } from "./Databases";
import { EnvBadge } from "./ui";
import { authClient } from "@/lib/authClient";

export type Sel = { type: "list" } | { type: "business" } | { type: "new" } | { type: "schema" } | { type: "sql" } | { type: "people" } | { type: "databases"; id: number | null; server?: number } | { type: "connect" } | { type: "tables"; table: string | null } | { type: "proposal"; id: number } | { type: "metric"; key: string };

function readHash(): Sel {
  if (typeof window === "undefined") return { type: "list" };
  const h = window.location.hash.slice(1);
  if (h === "business" || h === "overview") return { type: "business" };
  if (h === "new") return { type: "new" };
  if (h === "schema") return { type: "schema" };
  if (h === "sql") return { type: "sql" };
  if (h === "people") return { type: "people" };
  if (h === "databases") return { type: "databases", id: null };
  if (h === "connect") return { type: "connect" };
  if (h === "tables") return { type: "tables", table: null };
  const [t, v] = h.split("/");
  if (t === "p" && v) return { type: "proposal", id: Number(v) };
  if (t === "m" && v) return { type: "metric", key: decodeURIComponent(v) };
  if (t === "tables" && v) return { type: "tables", table: decodeURIComponent(v) };
  if (t === "databases" && v?.startsWith("server-")) return { type: "databases", id: null, server: Number(v.slice(7)) };
  if (t === "databases" && v) return { type: "databases", id: Number(v) };
  return { type: "list" };
}

export function hashOf(s: Sel) {
  return s.type === "list" ? "#" : s.type === "business" ? "#business" : s.type === "new" ? "#new" : s.type === "schema" ? "#schema" : s.type === "sql" ? "#sql" : s.type === "people" ? "#people" : s.type === "databases" ? (s.server ? `#databases/server-${s.server}` : s.id ? `#databases/${s.id}` : "#databases") : s.type === "connect" ? "#connect" : s.type === "tables" ? (s.table ? `#tables/${encodeURIComponent(s.table)}` : "#tables") : s.type === "proposal" ? `#p/${s.id}` : `#m/${encodeURIComponent(s.key)}`;
}

/** Workspace pages live at / (#databases, #people, #connect); one database's pages at /s/<slug>. */
export function App({ sourceSlug }: { sourceSlug: string | null }) {
  setCurrentSource(sourceSlug);
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [sel, setSelRaw] = useState<Sel>({ type: "list" });

  const reload = useCallback(async () => {
    try {
      const s = await api<AppState>("/api/state");
      setCurrency(s.currency);
      session.set(s.me);
      setState(s);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    reload();
    setSelRaw(readHash());
    const onHash = () => { setSelRaw(readHash()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [reload]);

  const setSel = (s: Sel) => { window.location.hash = hashOf(s); };
  const notify = (text: string, isError = false) => { setToast({ text, error: isError }); setTimeout(() => setToast(null), isError ? 6000 : 3500); };

  const proposals = useMemo(() => {
    const ps = [...(state?.proposals ?? [])];
    return ps.sort((a, b) => Number(contested(b)) - Number(contested(a)) || spreadOf(b) - spreadOf(a));
  }, [state]);

  // j on a certified metric: on to the next proposal that needs a person
  useEffect(() => {
    if (sel.type !== "metric" || !state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "j" || (e.target as HTMLElement).closest("input, textarea, select")) return;
      const next = nextUp(state);
      if (next) window.location.hash = `#p/${next.id}`;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, state]);

  if (error && !state) return <Shell sel={sel}><div className="center"><div className="hero"><h1>Can’t reach Crema</h1><p className="lead">{error}</p><button className="btn" onClick={reload}>Retry</button></div></div></Shell>;
  if (!state) return <Shell sel={sel}><div className="center"><span className="spin" /></div></Shell>;
  const admin = state.me?.role === "admin";
  const toastEl = toast && <Toast {...toast} />;

  // ---- workspace pages ----
  if (!sourceSlug) {
    const ready = state.sources.filter((x) => x.status === "ready");
    if (sel.type === "people" && state.me) return <Shell state={state} sel={sel}><People me={state.me} notify={notify} />{toastEl}</Shell>;
    if (sel.type === "databases") return <Shell state={state} sel={sel}><Databases state={state} selected={sel.id} server={sel.server ?? null} notify={notify} reload={reload} />{toastEl}</Shell>;
    if (sel.type === "connect" || !ready.length) return <Shell state={state} sel={sel}><Connect state={state} notify={notify} />{toastEl}</Shell>;
    // the workspace home is its first database
    if (typeof window !== "undefined") window.location.replace(sourceHref(ready[0].slug));
    return <Shell state={state} sel={sel}><div className="center"><span className="spin" /></div></Shell>;
  }

  // ---- one database ----
  if (!state.source) return (
    <Shell state={state} sel={sel}>
      <div className="center"><div className="hero"><h1>No database “{sourceSlug}”</h1><p className="lead">It may have been removed, or it belongs to another workspace.</p><a className="btn" href="/#databases">All databases</a></div></div>
    </Shell>
  );
  if (state.source.status !== "ready") return (
    <Shell state={state} sel={sel}>
      <div className="center"><div className="hero"><h1>{state.source.name} isn’t ready</h1><p className="lead">{state.source.status === "provisioning" ? "It’s being created." : state.source.error ?? "It failed to provision."}</p><a className="btn" href={`/#databases/${state.source.id}`}>Open in Databases</a></div></div>
    </Shell>
  );
  if (state.run?.status === "running") return <Shell state={state} sel={sel}><Discovery runId={state.run.id} onDone={() => { setSel({ type: "list" }); reload(); }} /></Shell>;

  const empty = !state.proposals.length && !state.metrics.length;
  const selected = sel.type === "proposal" ? state.proposals.find((p) => p.id === sel.id) ?? state.rejected.find((p) => p.id === sel.id) : null;
  const toList = () => setSel({ type: "list" });
  void admin;

  return (
    <Shell state={state} sel={sel}>
      {sel.type === "list" && (empty
        ? <FirstRun state={state} reload={reload} notify={notify} />
        : <Registry state={state} proposals={proposals} reload={reload} notify={notify} />)}
      {sel.type === "business" && <Overview state={state} reload={reload} notify={notify} back={toList} />}
      {isDatabase(sel) && <DatabaseTabs sel={sel} state={state} />}
      {sel.type === "schema" && <Schema notify={notify} />}
      {sel.type === "sql" && <SqlEditor state={state} notify={notify} />}
      {sel.type === "tables" && <Tables table={sel.table} notify={notify} />}
      {(sel.type === "people" || sel.type === "databases" || sel.type === "connect") && <div className="center"><a className="btn" href={`/${hashOf(sel)}`}>Open workspace page</a></div>}
      {sel.type === "new" && <NewMetric notify={notify} back={toList} onCreated={async (key) => { await reload(); setSel({ type: "metric", key }); }} />}
      {sel.type === "proposal" && selected && (
        <ProposalView key={selected.id} concept={selected} queue={proposals} runId={selected.runId} model={state.understanding?.model ?? state.model.name}
          back={toList} notify={notify}
          onCertified={async (key) => { await reload(); setSel({ type: "metric", key }); }}
          onChanged={async () => { await reload(); const next = proposals.find((p) => p.id !== selected.id); setSel(next ? { type: "proposal", id: next.id } : { type: "list" }); }} />
      )}
      {sel.type === "proposal" && !selected && <div className="page"><button className="btn sm ghost" onClick={toList}>← Metrics</button><p className="muted">This proposal is no longer open.</p></div>}
      {sel.type === "metric" && <MetricView key={sel.key} source={state.source} metricKey={sel.key} back={toList} notify={notify} reload={reload} cwd={state.cwd} tokenRequired={state.tokenRequired} />}
      {toastEl}
    </Shell>
  );
}

const isDatabase = (s: Sel) => s.type === "schema" || s.type === "tables" || s.type === "sql";

/** One place for looking at the raw database: its shape, its rows, and ad-hoc queries. */
function DatabaseTabs({ sel, state }: { sel: Sel; state: AppState }) {
  const tabs: [Sel["type"], string, string][] = [["schema", "Schema", "#schema"], ["tables", "Tables", "#tables"], ["sql", "SQL editor", "#sql"]];
  const src = state.source!;
  const siblings = state.sources.filter((d) => d.projectId === src.projectId && d.status === "ready");
  return (
    <nav className="dbtabs" aria-label="Database">
      <a href={`/#databases/${src.id}`}>Connect</a>
      {tabs.map(([t, label, href]) => <a key={t} href={href} className={sel.type === t ? "on" : ""} aria-current={sel.type === t ? "page" : undefined}>{label}</a>)}
      <span className="grow" />
      <span className="dbtabs-env">
        <EnvBadge environment={src.environment} />
        {siblings.length > 1
          ? <select aria-label="Branch" value={src.slug} onChange={(e) => { window.location.href = sourceHref(e.target.value, window.location.hash); }}>
              {siblings.map((d) => <option key={d.id} value={d.slug}>{d.projectName} · {d.branch}</option>)}
            </select>
          : <span className="dbtabs-note">{src.name}</span>}
        <span className="dbtabs-note">{src.kind === "hosted" ? "hosted" : "connected"} · read-only{!src.readOnly ? " transactions (this login can write)" : ""}</span>
      </span>
    </nav>
  );
}

/** The proposal to review next: one that needs a decision first, in the registry's order. */
function nextUp(state: AppState) {
  return state.proposals.find(contested) ?? state.proposals[0] ?? null;
}

function Toast({ text, error }: { text: string; error?: boolean }) {
  return <div className={`toast ${error ? "error" : ""}`} role="status">{text}</div>;
}

function Shell({ state, sel, children }: { state?: AppState; sel: Sel; children: React.ReactNode }) {
  const src = state?.source ?? null;
  const busy = state?.run?.status === "running";
  const n = state?.proposals.length ?? 0, m = state?.metrics.length ?? 0;
  const inner = sel.type === "proposal" || sel.type === "metric" || sel.type === "business" || sel.type === "new" || isDatabase(sel);
  const workspacePage = !src;
  return (
    <>
      <header className="statusbar">
        <span className="sb-left">
          {src && inner ? <a href="#" className="on">← all metrics</a> : <a href="/#databases">crema</a>}
          <span>—</span>
          {state && state.sources.length > 0 ? (
            <select className="sb-select" aria-label="Database" value={src?.slug ?? ""} onChange={(e) => { window.location.href = e.target.value ? sourceHref(e.target.value) : "/#databases"; }}>
              {!src && <option value="">all databases</option>}
              {state.sources.map((x) => <option key={x.id} value={x.slug}>{x.name}{x.status !== "ready" ? ` (${x.status})` : ""}</option>)}
            </select>
          ) : <span>no database yet</span>}
          {src && !src.readOnly && <span className="warn" title={`This login can write to ${src.writableTables} tables. Crema only runs read-only transactions, but a read-only login is safer.`}>(login can write)</span>}
          {sel.type === "metric" && <span className="ellipsis">/ {sel.key}</span>}
          {sel.type === "proposal" && <span className="ellipsis">/ {state?.proposals.find((p) => p.id === sel.id)?.key ?? "proposal"}</span>}
        </span>
        <span className="grow" />
        {src && !busy && sel.type === "metric" && state && (() => {
          const next = nextUp(state);
          return (
            <nav className="sb-right" aria-label="Main">
              <span>{m} of {n + m} certified</span>
              {next && <><span>·</span><a href={`#p/${next.id}`}>next: {next.name} (j)</a></>}
            </nav>
          );
        })()}
        {src && !busy && sel.type !== "metric" && (
          <nav className="sb-right" aria-label="Main">
            <span className="hide-sm">{n} proposed · {m} certified ·</span>
            <a href="#schema" className={isDatabase(sel) ? "on" : ""}>database</a>
            <span>·</span>
            <a href="#business" className={sel.type === "business" ? "on" : ""}>business &amp; API</a>
            <span>·</span>
            <a href="#new" className={sel.type === "new" ? "on" : ""}>+ new metric</a>
          </nav>
        )}
        {busy && <span>scanning…</span>}
        {state?.me && (
          <span className="sb-user">
            {(src || workspacePage) && <span>·</span>}
            <a href="/#databases" className={sel.type === "databases" ? "on" : ""}>databases</a>
            <span>·</span>
            {state.me.role === "admin" ? <a href="/#people" className={sel.type === "people" ? "on" : ""} title="People who can sign in">{state.me.name}</a> : <span>{state.me.name}</span>}
            <span>·</span>
            <button className="sb-btn" onClick={async () => { await authClient.signOut(); window.location.href = "/sign-in"; }}>sign out</button>
          </span>
        )}
      </header>
      {children}
    </>
  );
}

function Connect({ state, notify }: { state: AppState; notify: (t: string, e?: boolean) => void }) {
  const [url, setUrl] = useState("");
  const [environment, setEnvironment] = useState(""); // what this database is: chosen by the person, never assumed
  const [busy, setBusy] = useState(false);
  const admin = state.me?.role === "admin";
  const go = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await api<{ source: { slug: string }; writableTables: number; readOnlyRole: boolean }>("/api/sources", { body: { ...body, environment: environment || null }, source: null });
      if (state.model.configured) await api("/api/discover", { body: {}, source: r.source.slug });
      window.location.href = sourceHref(r.source.slug);
    } catch (e) { notify((e as Error).message, true); setBusy(false); }
  }, [state.model.configured, notify, environment]);
  useEffect(() => {
    if (!state.demoAvailable || !admin) return;
    const onKey = (e: KeyboardEvent) => { if ((e.key === "d" || e.key === "D") && !(e.target as HTMLElement).closest("input, textarea, select") && !busy) go({ demo: true }); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.demoAvailable, admin, busy, go]);
  if (!admin) return (
    <div className="connect"><h1>No databases yet</h1><p className="lead">An admin adds databases to this workspace. Ask one to connect yours.</p></div>
  );
  return (
    <div className="connect">
      <h1>Connect a database. We’ll find the metrics; you decide what’s true.</h1>
      <form className="palette" onSubmit={(e) => { e.preventDefault(); if (url) go({ url }); }}>
        <div className="palette-input">
          <span className="prompt" aria-hidden>›</span>
          <input placeholder="postgresql://readonly@host:5432/db" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus spellCheck={false} aria-label="Postgres connection string" />
        </div>
        <div className="palette-env" role="group" aria-label="What is this database? (optional)">
          <span className="muted">This database is</span>
          {([["", "not labelled"], ["production", "production"], ["staging", "staging"], ["development", "development"]] as const).map(([v, label]) => (
            <button key={v} type="button" aria-pressed={environment === v} className={environment === v ? "on" : ""} onClick={() => setEnvironment(v)}>{label}</button>
          ))}
        </div>
        <div className="palette-opts">
          <button type="submit" className={url || !state.demoAvailable ? "on" : ""} disabled={busy || !url}>
            <span>connect &amp; scan<span className="muted">read-only · schema + statistics, no rows</span></span>
            <span className="muted">{busy && url ? <span className="spin" /> : "↵"}</span>
          </button>
          {state.demoAvailable && (
            <button type="button" className={!url ? "on" : ""} disabled={busy} onClick={() => go({ demo: true })}>
              <span>open demo<span className="muted">a messy demo SaaS database</span></span>
              <span className="muted">{busy && !url ? <span className="spin" /> : "D"}</span>
            </button>
          )}
        </div>
      </form>
      {(state.servers.length > 0 || state.suggestedServer) && <p className="connect-alt">No database yet? <a href="/#databases">Create one</a> for your app; Crema can analyse it too.</p>}
      <div className="trust-row">
        <span>Never writes to your database</span>
        <span title={`Model: ${state.model.name}`}>No rows sent to the AI</span>
        <span>A person certifies every metric</span>
      </div>
    </div>
  );
}

type Payload = { table: string; rows: number }[];
const STEPS = 5; // schema · model · checking · comparing · found

function Discovery({ runId, onDone }: { runId: number; onDone: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [tables, setTables] = useState<Payload | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api<Run>(`/api/runs/${runId}`);
        if (!alive) return;
        setRun(r);
        if (r.status !== "running") { if (r.status === "done") setTimeout(() => alive && onDone(), 4000); return; }
      } catch { /* keep polling */ }
      if (alive) setTimeout(tick, 700);
    };
    tick();
    return () => { alive = false; };
  }, [runId, onDone]);

  const steps = run?.steps ?? [];
  const nSteps = steps.filter((s) => s.kind === "step").length;
  useEffect(() => {
    if (tables || nSteps < 2) return;
    api<Payload>(`/api/runs/${runId}/payload`).then((p) => Array.isArray(p) && p.length && setTables(p)).catch(() => {});
  }, [nSteps, runId, tables]);

  // Group the log: each step carries its detail lines; "found" lines are their own items.
  const items: { kind: "step" | "found" | "error"; text: string; details: string[] }[] = [];
  for (const s of steps) {
    if (s.kind === "detail" && items.length) items[items.length - 1].details.push(s.text);
    else if (s.kind !== "detail") items.push({ kind: s.kind, text: s.text, details: [] });
  }
  const lastStep = items.map((i) => i.kind).lastIndexOf("step");
  const running = run?.status === "running" || !run;
  const found = steps.filter((s) => s.kind === "found");
  const contested = found.filter((s) => /disagree/.test(s.text)).length;
  const entities = run?.entities ?? [];
  const meaning = new Map(entities.map((e) => [e.table, e.meaning]));
  const rows = tables ?? entities.map((e) => ({ table: e.table, rows: NaN }));
  const secs = run?.finishedAt ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000) : null;
  const pct = run?.status === "done" ? 100 : Math.min(95, (Math.max(0, nSteps - 1) / STEPS) * 100 + 6);

  return (
    <div className="scan">
      <aside className="scan-log">
        <div className="eyebrow">What we’re learning</div>
        <ul className="learn">
          {items.map((it, i) => (
            <li key={i} className={it.kind}>
              <span className={`mark ${it.kind === "error" || /disagree/.test(it.text) ? "warn" : ""}`}>
                {it.kind === "error" || (it.kind === "found" && /disagree/.test(it.text)) ? "!" : it.kind === "step" && i === lastStep && running ? <span className="spin" /> : "✓"}
              </span>
              <span>
                <div className="t">{it.kind === "found" ? `Found ${it.text}` : it.text}</div>
                {it.details.slice(0, it.kind === "step" && i === 0 ? 3 : 2).map((d, k) => <div key={k} className="d">{d}</div>)}
                {it.details.length > 3 && i === 0 && <div className="d">+ {it.details.length - 3} more tables</div>}
              </span>
            </li>
          ))}
        </ul>
        <div className="scan-stats">
          <div><b>{tables?.length ?? "—"}</b><span>tables</span></div>
          <div><b>{entities.length || "—"}</b><span>entities</span></div>
          <div><b>{found.length || "—"}</b><span>metrics</span></div>
          <div className="text-warn"><b>{run?.status === "done" ? contested : "—"}</b><span>for you</span></div>
        </div>
        <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)}><i style={{ width: `${pct}%` }} /></div>
      </aside>
      <main className="scan-main">
        <div className="eyebrow">Your tables → what they mean</div>
        {rows.length ? (
          <table className="plain">
            <thead><tr><th>table</th><th>we think it is</th><th>rows</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.table}>
                  <td className="mono">{t.table.replace(/^public\./, "")}</td>
                  <td>{meaning.get(t.table) ?? <span className="faint">{entities.length ? "not used" : "reading…"}</span>}</td>
                  <td className="mono num">{Number.isFinite(t.rows) ? t.rows.toLocaleString("en-US") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted mt-4">Looking at your tables… Every query runs in a read-only transaction.</p>}
        {run?.status === "done" && (
          <div className="done-banner">
            <p>Done{secs != null ? ` in ${secs}s` : ""}. {found.length} metric{found.length === 1 ? "" : "s"} proposed{contested ? `, ${contested} need your call` : ""}.</p>
            <button className="btn primary mono" autoFocus onClick={onDone}>see metrics ↵</button>
          </div>
        )}
        {run?.status === "failed" && (
          <div className="done-banner fail">
            <p>Discovery failed{run.error ? `: ${run.error}` : "."}</p>
            <button className="btn" onClick={onDone}>Back</button>
          </div>
        )}
      </main>
    </div>
  );
}

function FirstRun({ state, reload, notify }: { state: AppState; reload: () => void; notify: (t: string, e?: boolean) => void }) {
  return (
    <div className="center">
      <div className="hero">
        <div className="eyebrow">{state.source?.name}</div>
        <h1>{state.run?.status === "failed" ? "Discovery didn’t finish" : "Ready when you are"}</h1>
        <p className="lead">{state.run?.error ?? (state.model.configured ? "Let Crema propose the metrics your business runs on, or write one you already know." : "Set GEMINI_API_KEY in your environment and restart Crema so it can propose metrics. You can also create a metric by hand.")}</p>
        <div className="row wrap">
          <button className="btn primary lg" disabled={!state.model.configured} onClick={async () => { try { await api("/api/discover", { body: {} }); reload(); } catch (e) { notify((e as Error).message, true); } }}>Discover metrics</button>
          <a className="btn lg" href="#new">Create metric by hand</a>
          <a className="btn ghost" href="/#connect">Connect another database</a>
        </div>
      </div>
    </div>
  );
}
