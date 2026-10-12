"use client";
import { useEffect, useMemo, useState } from "react";
import { display } from "@/core/format";
import { actorLabel, ago, api, contested, spreadOf, type AppState, type Concept, type Metric } from "@/lib/client";

type Filter = "all" | "needs" | "looks" | "certified";
type Row =
  | { kind: "proposal"; id: string; href: string; c: Concept }
  | { kind: "metric"; id: string; href: string; m: Metric };

const CONF = { high: { w: "100%", c: "var(--ok)", t: "very sure" }, medium: { w: "62%", c: "var(--warn)", t: "fairly sure" }, low: { w: "28%", c: "var(--fail)", t: "unsure" } } as const;

export function Registry({ state, proposals, reload, notify }: { state: AppState; proposals: Concept[]; reload: () => void; notify: (t: string, e?: boolean) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [ask, setAsk] = useState("");

  const rows: Row[] = useMemo(() => [
    ...proposals.map((c) => ({ kind: "proposal" as const, id: `p${c.id}`, href: `#p/${c.id}`, c })),
    ...state.metrics.map((m) => ({ kind: "metric" as const, id: `m${m.key}`, href: `#m/${encodeURIComponent(m.key)}`, m })),
  ], [proposals, state.metrics]);

  const needs = proposals.filter(contested);
  const shown = rows.filter((r) => {
    if (filter === "needs" && !(r.kind === "proposal" && contested(r.c))) return false;
    if (filter === "looks" && !(r.kind === "proposal" && !contested(r.c))) return false;
    if (filter === "certified" && r.kind !== "metric") return false;
    const text = r.kind === "proposal" ? `${r.c.name} ${r.c.key} ${r.c.question}` : `${r.m.name} ${r.m.key} ${r.m.current.question} ${r.m.current.description}`;
    return !q.trim() || text.toLowerCase().includes(q.trim().toLowerCase());
  });

  useEffect(() => setSel(0), [filter, q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "j") setSel((i) => Math.min(shown.length - 1, i + 1));
      else if (e.key === "k") setSel((i) => Math.max(0, i - 1));
      else if (e.key === "Enter" && shown[sel] && document.activeElement === document.body) window.location.hash = shown[sel].href;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, sel]);

  const n = proposals.length;
  const tabs: [Filter, string, number][] = [["all", "All", rows.length], ["needs", "Needs you", needs.length], ["looks", "Looks right", n - needs.length], ["certified", "Certified", state.metrics.length]];
  const first = needs[0] ?? proposals[0];

  return (
    <div className="registry">
      <div className="reg-top">
        <h1>{n && !state.metrics.length ? `We found ${n} metric${n === 1 ? "" : "s"} in your business` : `${rows.length} metric${rows.length === 1 ? "" : "s"}`}</h1>
        <div className="pills" role="tablist">
          {tabs.map(([id, label, count]) => (count > 0 || id === "all") && (
            <button key={id} role="tab" aria-selected={filter === id} className={`pill ${filter === id ? "on" : ""}`} onClick={() => setFilter(id)}>{label} · {count}</button>
          ))}
        </div>
        <span className="grow" />
        <span className="hints">j/k move · ↵ open</span>
        <input className="input search" placeholder="Find a definition…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search metrics" autoComplete="off" />
      </div>

      <div className="reg-head" aria-hidden>
        <span>Metric</span><span>What it means</span><span className="r">Value</span><span>How sure we are</span><span>Status</span>
      </div>
      {shown.map((r, i) => (r.kind === "proposal" ? <ProposalRow key={r.id} r={r} selected={i === sel} /> : <MetricRow key={r.id} r={r} selected={i === sel} />))}
      {!shown.length && <div className="empty-row">{q ? "No definition matches that search." : "Nothing here yet."}</div>}

      <form className="reg-more" onSubmit={async (e) => {
        e.preventDefault();
        if (!ask.trim()) return;
        try { await api("/api/discover", { body: { focus: ask.trim() } }); setAsk(""); reload(); } catch (err) { notify((err as Error).message, true); }
      }}>
        <span><b>Missing a metric?</b> Ask the model to define it by name, or <a href="#new">write it yourself</a>.</span>
        <input className="input" placeholder="e.g. net revenue retention" value={ask} onChange={(e) => setAsk(e.target.value)} aria-label="Metric to propose" />
        <button className="btn sm" disabled={!ask.trim() || !state.model.configured}>Propose</button>
      </form>
      <p className="reg-note">“How sure we are” describes how well the evidence supports a definition. It is not approval: only a person can certify.</p>

      <div className="bottombar">
        <p>{n
          ? needs.length
            ? `Start with the ${needs.length} that need${needs.length === 1 ? "s" : ""} you${n - needs.length ? ` — the other ${n - needs.length} take a minute.` : "."}`
            : `${n} definition${n === 1 ? "" : "s"} to review. Each takes a minute.`
          : "Everything proposed has been decided."}</p>
        {first && <a className="btn primary lg" href={`#p/${first.id}`}>Review first one</a>}
      </div>
    </div>
  );
}

function ProposalRow({ r, selected }: { r: Extract<Row, { kind: "proposal" }>; selected: boolean }) {
  const c = r.c;
  const c0 = c.candidates[0];
  const split = contested(c);
  const conf = CONF[c0?.confidence ?? "medium"];
  return (
    <a className={`reg-row ${selected ? "sel" : ""}`} href={r.href} data-state="proposal">
      <div className="reg-name"><h2>{c.name}</h2><code>{c.key}</code></div>
      <div className="reg-meaning" title={c0?.description}>{c.question}</div>
      <div className="reg-value">
        {split
          ? c.candidates.slice(0, 2).map((x, i) => <span key={x.id}>{i > 0 && <span className="sep">|</span>}{display(x.verification?.value, x.unit)}</span>)
          : display(c0?.verification?.value, c0?.unit ?? "number")}
      </div>
      <div>
        {split
          ? <span className="conf" style={{ ["--w" as string]: "50%", ["--c" as string]: "var(--warn)" }}><i />pick one · {Math.round(spreadOf(c) * 100)}% apart</span>
          : <span className="conf" style={{ ["--w" as string]: conf.w, ["--c" as string]: conf.c }}><i />{conf.t}</span>}
      </div>
      <div className={`reg-status ${split ? "needs" : ""}`}>{split ? "Needs you →" : "Looks right"}</div>
    </a>
  );
}

function MetricRow({ r, selected }: { r: Extract<Row, { kind: "metric" }>; selected: boolean }) {
  const m = r.m;
  const cur = m.current;
  return (
    <a className={`reg-row ${selected ? "sel" : ""}`} href={r.href} data-state="certified">
      <div className="reg-name"><h2>{m.name}</h2><code>{m.key}</code></div>
      <div className="reg-meaning" title={cur.description}>{cur.question}</div>
      <div className="reg-value">{display(cur.verification.value, cur.unit)}</div>
      <div><span className="conf" style={{ ["--w" as string]: "100%", ["--c" as string]: "var(--ok)" }}><i />a person decided</span></div>
      <div className={`reg-status ${m.status === "needs_attention" ? "needs" : "ok"}`} title={m.attention ?? undefined}>{m.status === "needs_attention" ? "Needs attention" : `✓ Certified v${m.currentVersion}`}<small>{actorLabel(cur.certifiedBy)} · {ago(cur.certifiedAt)}{cur.origin === "human" ? " · by hand" : ""}</small></div>
    </a>
  );
}
