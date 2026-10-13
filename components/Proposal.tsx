"use client";
import { useEffect, useMemo, useState } from "react";
import { display, fmt } from "@/core/format";
import type { Candidate, MemberDiff } from "@/core/types";
import { actor, api, contested, windowLabel, type Concept, type Verification } from "@/lib/client";
import { CheckSummary, checkSummary, Code, ConfidenceChip, Distribution, LineChart, SERIES, useConfirm } from "./ui";

type Payload = { table: string; columns: { name: string; values?: Record<string, number> | string; null_pct?: number; distinct?: number; min?: string; max?: string }[]; rows: number }[];
const payloadCache = new Map<number, Promise<Payload>>();
function usePayload(runId: number) {
  const [p, setP] = useState<Payload | null>(null);
  useEffect(() => {
    if (!payloadCache.has(runId)) payloadCache.set(runId, api<Payload>(`/api/runs/${runId}/payload`).catch(() => []));
    payloadCache.get(runId)!.then(setP);
  }, [runId]);
  return p;
}

function columnEvidence(payload: Payload | null, ref: string | null) {
  if (!payload || !ref) return null;
  const parts = ref.replace(/"/g, "").split(".");
  const col = parts.pop()!;
  const table = parts.join(".");
  const t = payload.find((x) => x.table === table) ?? payload.find((x) => x.table.endsWith("." + table));
  const c = t?.columns.find((x) => x.name === col);
  return c ? { table: t!.table, rows: t!.rows, ...c } : null;
}

function bestIndex(cands: Candidate[]) {
  const score = (c: Candidate) => {
    const s = checkSummary(c.verification?.checks ?? []);
    return (c.confidence === "high" ? 3 : c.confidence === "medium" ? 2 : 1) * 10 - s.warn * 3 - s.fail * 20;
  };
  return cands.reduce((best, c, i) => (score(c) > score(cands[best]) ? i : best), 0);
}

export function ProposalView({ concept, queue, runId, model, back, notify, onCertified, onChanged }: {
  concept: Concept; queue: Concept[]; runId: number; model: string; back: () => void;
  notify: (t: string, e?: boolean) => void; onCertified: (key: string) => void; onChanged: () => void;
}) {
  const [ask, confirmDialog] = useConfirm();
  const cands = concept.candidates;
  const [idx, setIdx] = useState(() => bestIndex(cands));
  const cand = cands[idx];
  const payload = usePayload(runId);
  const open = concept.status === "open";

  // editing
  const [editing, setEditing] = useState(false);
  const [sql, setSql] = useState(cand.sql);
  const [membersSql, setMembersSql] = useState(cand.membersSql ?? "");
  const [preview, setPreview] = useState<Verification | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => { setSql(cand.sql); setMembersSql(cand.membersSql ?? ""); setPreview(null); setPreviewFor(null); setEditing(false); }, [idx, cand.sql, cand.membersSql]);
  const edited = sql.trim() !== cand.sql.trim() || (membersSql.trim() || null) !== (cand.membersSql?.trim() || null);
  const draftKey = sql + "\u0000" + membersSql;

  // decision
  const [name, setName] = useState(concept.name);
  const [key, setKey] = useState(concept.key);
  const [editingKey, setEditingKey] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const who = actor.get();

  const multi = cands.length > 1;
  const spread = concept.comparison?.spread ?? 0;
  const split = multi && spread > 0.005;
  // A contested metric is a business decision: nothing is pre-selected for the human to rubber-stamp.
  const [answered, setAnswered] = useState(!split);
  const pick = (i: number) => { setIdx(i); setAnswered(true); };

  const v: Verification | null = edited && preview && previewFor === draftKey ? preview : cand.verification;
  const blocked = !open ? `This proposal is ${concept.status}.`
    : !answered ? "Answer the question above: only you know which one is true."
    : edited && previewFor !== draftKey ? "Run the edited definition before certifying it."
    : !v?.ok ? "This definition doesn’t run on your database."
    : v.checks.some((c) => c.level === "fail") ? "Fix the failing check first."
    : !name.trim() ? "The metric needs a name: type it in the title."
    : null;

  const runPreview = async () => {
    setRunning(true);
    try {
      const r = await api<Verification>("/api/preview", { body: { kind: cand.kind, unit: cand.unit, sql, membersSql: membersSql || null, memberTable: cand.memberTable } });
      setPreview(r); setPreviewFor(draftKey);
    } catch (e) { notify((e as Error).message, true); } finally { setRunning(false); }
  };

  const doCertify = async () => {
    if (blocked) return;
    setBusy(true);
    try {
      const edits: Record<string, unknown> = { name, key };
      if (edited) { edits.sql = sql; edits.membersSql = membersSql || null; }
      const r = await api<{ metricKey: string; version: number }>(`/api/proposals/${concept.id}/certify`, { body: { candidateId: cand.id, edits, note } });
      notify(`Certified ${name} (v${r.version}). It’s now available to the API and MCP.`);
      onCertified(r.metricKey);
    } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
  };

  const doDismiss = async () => {
    const answer = await ask({ title: `Reject ${concept.name}?`, body: "It moves to rejected; you can reopen it later.", reason: { label: "Why isn’t this a metric you need? (optional, goes into the audit log)" }, confirmLabel: "Reject", danger: true });
    if (!answer.ok) return;
    const reason = answer.reason;
    try { await api(`/api/proposals/${concept.id}/reject`, { body: { reason } }); notify(`Rejected ${concept.name}.`); onChanged(); }
    catch (e) { notify((e as Error).message, true); }
  };

  const lines = cands.map((c, i) => ({ label: c.label, series: c.verification?.series ?? [], color: SERIES[i] }));
  // Observed = facts measured on the database. Inferred = what the model believes they mean.
  const observed: { text: string; col?: string; ev: ReturnType<typeof columnEvidence> }[] = cand.assumptions
    .map((a) => ({ text: a.text, col: a.column ?? undefined, ev: columnEvidence(payload, a.column) }))
    .filter((x) => x.ev);
  const checks = v?.checks ?? [];
  const sortedChecks = [...checks].sort((x, y) => ({ fail: 0, warn: 1, info: 2, pass: 3 })[x.level] - ({ fail: 0, warn: 1, info: 2, pass: 3 })[y.level]);

  const needs = queue.filter(contested), looks = queue.filter((c) => !contested(c));
  const series = (v?.series ?? []).slice(-9);

  return (
    <div className="review">
      <nav className="rail" aria-label="Review queue">
        <div className="rail-inner">
          {needs.length > 0 && <h4>Needs you · {needs.length}</h4>}
          {needs.map((c) => <a key={c.id} href={`#p/${c.id}`} className={c.id === concept.id ? "on" : ""}>{c.name}</a>)}
          {looks.length > 0 && <h4>Looks right · {looks.length}</h4>}
          {looks.map((c) => <a key={c.id} href={`#p/${c.id}`} className={c.id === concept.id ? "on" : ""}>{c.name}</a>)}
        </div>
      </nav>

      <main className="doc">
        <div className="doc-body">
          <div className="draft">
            <span>{open ? (split ? `Draft · needs your decision · ${cands.length} meanings` : "Draft · needs your decision") : concept.status}</span>
            <span className="by">proposed by {model}</span>
          </div>
          {open ? (
            <>
              <h1 className="title title-edit">
                <textarea rows={1} value={name} aria-label="Metric name" title="Click to rename" spellCheck={false}
                  onChange={(e) => setName(e.target.value.replace(/\n/g, " "))}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} />
              </h1>
              <div className="keyline">
                {editingKey
                  ? <input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} onBlur={() => setEditingKey(false)} aria-label="Metric key" autoFocus spellCheck={false} />
                  : <><span className="mono">{key}</span><button className="linkish" onClick={() => setEditingKey(true)}>change key</button></>}
                <span className="faint">stable id for the API and MCP</span>
              </div>
            </>
          ) : <h1 className="title">{concept.name}</h1>}
          <p className="sentence">{cand.description}</p>
          <p className="asks">Answers: {concept.question}</p>

          <div className="figure">
            <div>
              <div className="label">{windowLabel(cand.kind)}{multi ? (answered ? ` · answer ${String.fromCharCode(65 + idx)}` : " · depends on your answer") : ""}</div>
              <div className="big">{answered ? display(v?.value, cand.unit, { compact: false }) : cands.map((c) => display(c.verification?.value, c.unit, { compact: false })).join(" or ")}</div>
            </div>
            {series.length > 1 && <Bars series={series} />}
            <div className="caption">{trend(series)}{v?.members != null ? ` From ${fmt(v.members)} ${(cand.memberTable ?? "rows").split(".").pop()}.` : ""}</div>
          </div>

          {/* ---- the decision, in words: where the definitions part ways, traced to rows ---- */}
          {multi && <Decide concept={concept} idx={idx} answered={answered} pick={pick} open={open} />}

          {lines.some((l) => l.series.length) && (
            <div className="section">
              <div className="section-title">Last 12 months{multi ? ", each answer" : ""}</div>
              <LineChart lines={lines} unit={cand.unit} />
              {multi && <div className="legend mt-2">{lines.map((l) => <span key={l.label} className="row gap-1"><span className="dot" style={{ background: l.color }} />{l.label}</span>)}</div>}
            </div>
          )}

          <div className="section">
            {!editing ? (
              <details className="sqlbox">
                <summary>Show the SQL<span className="faint"> · {v?.relations.length ? `reads ${v.relations.map((r) => r.replace(/^public\./, "")).join(", ")}` : cand.kind === "flow" ? "evaluated over a period" : "evaluated at a point in time"}</span></summary>
                <div className="mt-3"><Code>{cand.sql}</Code></div>
                {cand.membersSql && <><div className="faint small mt-3 mb-1">Members (which {cand.memberTable} are counted)</div><Code>{cand.membersSql}</Code></>}
                {open && <button className="linkish mt-3" onClick={() => setEditing(true)}>Edit the SQL</button>}
              </details>
            ) : (
              <div className="stack">
                <div className="row"><div className="section-title grow m-0">Definition</div>
                  <button className="btn sm ghost" onClick={() => { setEditing(false); setSql(cand.sql); setMembersSql(cand.membersSql ?? ""); setPreview(null); setPreviewFor(null); }}>Discard edits</button></div>
                <textarea rows={Math.min(18, sql.split("\n").length + 2)} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
                {cand.membersSql !== null && (<><div className="faint small">Members SQL (returns the ids being counted)</div><textarea rows={5} value={membersSql} onChange={(e) => setMembersSql(e.target.value)} spellCheck={false} /></>)}
                <div className="row">
                  <button className="btn" onClick={runPreview} disabled={running}>{running ? <span className="spin" /> : "Run on my data"}</button>
                  {preview && previewFor === draftKey && (preview.ok
                    ? <span className="small">New value: <b className="num">{display(preview.value, cand.unit, { compact: false })}</b> <span className="muted">(was {display(cand.verification?.value, cand.unit, { compact: false })})</span></span>
                    : <span className="small text-fail">{preview.error}</span>)}
                </div>
              </div>
            )}
          </div>
        </div>

        {open && (
          <div className="decision">
            <div className="decision-inner">
              {noting && <div className="dform mb-3"><input className="input grow" autoFocus placeholder="Note for the audit log (optional)" value={note} onChange={(e) => setNote(e.target.value)} /></div>}
              <div className="dform">
                <button className="btn ok lg" disabled={Boolean(blocked) || busy} onClick={doCertify} title={multi ? cand.label : undefined}>
                  {busy ? <span className="spin" /> : !answered ? "Answer 1 question to certify" : <>Certify {multi ? `answer ${String.fromCharCode(65 + idx)}` : "this definition"}{edited ? " (edited)" : ""}</>}
                </button>
                <button className="btn lg" onClick={doDismiss}>Not a metric</button>
                <span className="grow" />
                <span className="signer">Signing as <b>{who || "you"}</b></span>
              </div>
              <div className="dmeta">
                <span className="grow">{blocked ?? (edited ? "You edited the SQL; your version will be certified." : multi ? `Certifies “${cand.label}”. The other answer${cands.length > 2 ? "s are" : " is"} kept as rejected alternatives.` : "Becomes v1, served over the API and MCP.")}</span>
                {!noting && <button className="linkish" onClick={() => setNoting(true)}>Add a note</button>}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ---- evidence: what was measured vs what is believed ---- */}
      <aside className="side" aria-label="Evidence">
        <div className="side-inner">
          <div className="eyebrow">Why we think this</div>
          <div className="ev-card">
            <h4>Observed in your database</h4>
            <ul className="ev-list">
              {sortedChecks.slice(0, 4).map((c, i) => (
                <li key={c.id + i}><span className={`ev-dot ${c.level === "fail" ? "fail" : c.level === "warn" ? "warn" : ""}`} /><span>{c.message}</span></li>
              ))}
              {!sortedChecks.length && <li><span className="ev-dot" /><span className="muted">Not verified yet.</span></li>}
            </ul>
            {sortedChecks.length > 4 && (
              <details className="ev-more">
                <summary>{sortedChecks.length - 4} more check{sortedChecks.length - 4 === 1 ? "" : "s"}</summary>
                <ul className="ev-list">{sortedChecks.slice(4).map((c, i) => <li key={c.id + i}><span className="ev-dot" /><span>{c.message}</span></li>)}</ul>
              </details>
            )}
            {observed.length > 0 && (
              <details className="ev-more">
                <summary>Columns behind it · {observed.length}</summary>
                <div className="ev-cols">
                  {observed.map((o, i) => (
                    <div key={i}>
                      <div className="mono">{o.col?.replace(/^"?public"?\./, "")}</div>
                      {typeof o.ev!.values === "object" && o.ev!.values ? <Distribution values={o.ev!.values} /> : (
                        <div className="ev-stat">{o.ev!.null_pct ? `${o.ev!.null_pct}% null` : "never null"}{o.ev!.distinct != null ? ` · ${fmt(o.ev!.distinct)} distinct` : ""}{o.ev!.min ? <> · <span className="nowrap">{o.ev!.min.slice(0, 10)} → {o.ev!.max?.slice(0, 10)}</span></> : ""}</div>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
            <p className="ev-foot">Checked by Crema against your data, not by the model.</p>
          </div>

          <div className="ev-card inferred">
            <h4>Inferred business meaning</h4>
            <ul className="ev-list">
              {cand.assumptions.map((a, i) => (
                <li key={i}>
                  <span className="ev-dot inferred" />
                  <span>{a.text}{a.confidence !== "high" && <> <span className={`chip ${a.confidence === "medium" ? "warn" : "fail"}`}>{a.confidence}</span></>}</span>
                </li>
              ))}
            </ul>
            <p className="reasoning"><b>Model’s reasoning.</b> {cand.why}</p>
            <p className="ev-foot row"><ConfidenceChip c={cand.confidence} /><span>AI confidence is not approval.</span></p>
          </div>
        </div>
      </aside>
      {confirmDialog}
    </div>
  );
}

function Bars({ series }: { series: { value: number | null; partial?: boolean }[] }) {
  const vals = series.map((p) => p.value ?? 0);
  const hi = Math.max(...vals.map(Math.abs), 1e-9);
  return (
    <div className="bars" aria-hidden>
      {series.map((p, i) => <span key={i} className={p.partial ? "partial" : ""} style={{ height: `${Math.max(6, (Math.abs(p.value ?? 0) / hi) * 100)}%` }} />)}
    </div>
  );
}

/** One plain sentence about the shape of the recent series, so the reviewer can sanity-check it against what they know. */
function trend(series: { value: number | null; partial?: boolean }[]) {
  const full = series.filter((p) => !p.partial && p.value != null).map((p) => p.value!);
  if (full.length < 3) return "Does that match what you see?";
  const first = full[0], last = full[full.length - 1];
  const change = first ? (last - first) / Math.abs(first) : 0;
  const ups = full.slice(1).filter((v, i) => v >= full[i]).length;
  const shape = Math.abs(change) < 0.03 ? `Roughly flat for ${full.length} months.`
    : change > 0 ? (ups >= full.length - 2 ? `Growing steadily for ${full.length} months.` : `Up ${Math.round(change * 100)}% over ${full.length} months.`)
    : `Down ${Math.round(-change * 100)}% over ${full.length} months.`;
  return `${shape} Does that match what you see?`;
}

const letter = (i: number) => String.fromCharCode(65 + i);

/**
 * The comparison engine's row-level explanation, asked as the question a person can actually answer:
 * "48 subscriptions are counted only by X; 100% have cancel_reason = 'trial_expired'. Do they count?"
 */
function Decide({ concept, idx, answered, pick, open }: { concept: Concept; idx: number; answered: boolean; pick: (i: number) => void; open: boolean }) {
  const cands = concept.candidates;
  const cmp = concept.comparison;
  const unit = cands[0].unit;
  const [show, setShow] = useState<string | null>(null);
  const val = (i: number) => display(cands[i].verification?.value, unit, { compact: false });
  const spread = cmp?.spread ?? 0;

  if (spread <= 0.005) {
    return (
      <div className="ask-card agree">
        <b>{cands.length} definitions, same number today.</b> On your data they return {val(0)}. Pick the wording that matches what you mean; they can diverge later.
        <div className="opts">{cands.map((c, i) => <Opt key={c.id} on={i === idx} onClick={() => pick(i)} head={`${letter(i)} · ${c.label}`} value={val(i)} />)}</div>
      </div>
    );
  }

  // Yes/no when one definition is the other plus a set of rows the engine can describe.
  const d = cmp?.diffs.find((x) => x.changed.rows === 0 && (x.onlyA.rows > 0) !== (x.onlyB.rows > 0));
  const simple = cands.length === 2 && cmp?.diffs.length === 1 && d;
  const extra = d && (d.onlyA.rows > 0 ? { part: d.onlyA, wide: d.a, narrow: d.b, k: "onlyA" as const } : { part: d.onlyB, wide: d.b, narrow: d.a, k: "onlyB" as const });
  const noun = d?.table.split(".").pop();
  const rows = show && d ? d[show as "onlyA" | "onlyB" | "changed"].sample : [];
  const cols = rows[0] ? Object.keys(rows[0]) : [];

  return (
    <div className="ask-card">
      {simple && extra ? (
        <>
          <p className="ask-q"><b>{open ? "Only you can decide:" : "The question:"}</b> {extra.part.explain} Do they count?</p>
          <div className="opts">
            <Opt on={answered && idx === extra.wide} onClick={() => pick(extra.wide)} head={`Yes, count them`} sub={`${letter(extra.wide)} · ${cands[extra.wide].label}`} value={val(extra.wide)} />
            <Opt on={answered && idx === extra.narrow} onClick={() => pick(extra.narrow)} head={`No, leave them out`} sub={`${letter(extra.narrow)} · ${cands[extra.narrow].label}`} value={val(extra.narrow)} />
          </div>
          {extra.part.sample.length > 0 && <button className="linkish mt-3" onClick={() => setShow(show ? null : extra.k)}>{show ? "Hide" : "See"} some of these {noun}</button>}
        </>
      ) : (
        <>
          <p className="ask-q"><b>{open ? "Only you can decide:" : "The question:"}</b> {cands.length} definitions disagree by {Math.round(spread * 100)}% on your data. Which one is true?</p>
          {cmp?.diffs.flatMap((x) => (["onlyA", "onlyB", "changed"] as const).filter((k) => x[k].rows > 0 && x[k].explain).map((k) => (
            <p key={`${x.a}${x.b}${k}`} className="ask-why">{x[k].explain}{x[k].sample.length > 0 && <> <button className="linkish" onClick={() => setShow(show === k ? null : k)}>{show === k ? "hide" : "see"} examples</button></>}</p>
          )))}
          {!cmp?.diffs.length && <p className="ask-why">{cands.some((c) => !c.membersSql) ? "At least one definition can’t list the rows behind its number (ratios and averages can’t), so the gap isn’t traced row by row." : "These definitions read different tables, so the gap can’t be traced row by row."}</p>}
          <div className="opts">{cands.map((c, i) => <Opt key={c.id} on={answered && i === idx} onClick={() => pick(i)} head={`${letter(i)} · ${c.label}`} sub={c.description} value={val(i)} />)}</div>
        </>
      )}
      {rows.length > 0 && (
        <div className="scroll-x mt-3">
          <table className="rows">
            <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className="mono">{r[c] === null ? <span className="faint">null</span> : String(r[c]).slice(0, 40)}</td>)}</tr>)}</tbody>
          </table>
          <div className="faint small mt-1">Shown only to you. Rows are never sent to the model.</div>
        </div>
      )}
    </div>
  );
}

function Opt({ on, onClick, head, sub, value }: { on: boolean; onClick: () => void; head: string; sub?: string; value: string }) {
  return (
    <button className={`opt-btn ${on ? "on" : ""}`} onClick={onClick} aria-pressed={on}>
      <span className="opt-head"><span className="grow">{head}</span><span className="opt-val num">{value}</span></span>
      {sub && <span className="opt-sub">{sub}</span>}
    </button>
  );
}
