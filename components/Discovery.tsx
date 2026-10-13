"use client";
import { useEffect, useState } from "react";
import { api, type Run } from "@/lib/client";

type Payload = { table: string; rows: number }[];
const STEPS = 5; // schema · model · checking · comparing · found

export function Discovery({ runId, onDone }: { runId: number; onDone: () => void }) {
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

