"use client";
import { useState } from "react";
import { currentCurrency, display } from "@/core/format";
import type { MetricKind, MetricUnit } from "@/core/types";
import { actor, api, type Verification } from "@/lib/client";
import { Checks, LineChart } from "./ui";

const EXAMPLE: Record<MetricKind, string> = {
  flow: "SELECT count(*) AS value\nFROM public.orders\nWHERE created_at >= {{start}} AND created_at < {{end}}",
  snapshot: "SELECT count(*) AS value\nFROM public.customers\nWHERE created_at <= {{at}}",
};

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

export function NewMetric({ notify, back, onCreated }: { notify: (t: string, e?: boolean) => void; back: () => void; onCreated: (key: string) => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [question, setQuestion] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<MetricKind>("flow");
  const [unit, setUnit] = useState<MetricUnit>("count");
  const [sql, setSql] = useState(EXAMPLE.flow);
  const [preview, setPreview] = useState<Verification | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const who = actor.get();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const draft = `${kind}|${unit}|${sql}`;
  const fresh = preview && previewFor === draft;
  const finalKey = keyTouched ? key : slug(name);
  const blocked = !name.trim() ? "Give the metric a name."
    : !finalKey ? "The key needs letters or digits."
    : !fresh ? "Run the definition on your data first."
    : !preview.ok ? "This definition doesn’t run on your database."
    : preview.checks.some((c) => c.level === "fail") ? "Fix the failing check first."
    : null;

  const changeKind = (k: MetricKind) => {
    if (sql.trim() === EXAMPLE[kind]) setSql(EXAMPLE[k]);
    setKind(k);
  };

  const run = async () => {
    setRunning(true);
    try {
      setPreview(await api<Verification>("/api/preview", { body: { kind, unit, sql } }));
      setPreviewFor(draft);
    } catch (e) { notify((e as Error).message, true); } finally { setRunning(false); }
  };

  const create = async () => {
    if (blocked) return;
    setBusy(true);
    try {
      const r = await api<{ metricKey: string; version: number }>("/api/metrics", { body: { edits: { name, key: finalKey, question, description, kind, unit, sql }, note } });
      notify(`Certified ${name} (v${r.version}). It’s now available to the API and MCP.`);
      onCreated(r.metricKey);
    } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <div className="page narrow">
      <div className="eyebrow">Written by a person</div>
      <h1 className="title">Create a metric</h1>
      <p className="meaning">You already know the definition. Write it as one SQL query, run it on your data, then certify it. It gets the same checks and audit trail as an AI proposal.</p>

      <div className="card pad">
        <div className="form-grid">
          <label className="field">Name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Doanh thu thuần" autoFocus />
          </label>
          <label className="field">Key (used by the API and MCP)
            <input className="input mono" value={finalKey} onChange={(e) => { setKey(slug(e.target.value)); setKeyTouched(true); }} placeholder="net_revenue" />
          </label>
          <label className="field wide">What it means
            <input className="input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="The business question this number answers" />
          </label>
          <label className="field wide">Definition in words
            <textarea className="prose" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Which rows count, what is excluded, and why." />
          </label>
          <label className="field">Counted
            <select className="select" value={kind} onChange={(e) => changeKind(e.target.value as MetricKind)}>
              <option value="flow">Over a period (uses {"{{start}}"} and {"{{end}}"})</option>
              <option value="snapshot">As of a moment (uses {"{{at}}"})</option>
            </select>
          </label>
          <label className="field">Unit
            <select className="select" value={unit} onChange={(e) => setUnit(e.target.value as MetricUnit)}>
              <option value="count">Count</option>
              <option value="currency">Money ({currentCurrency() === "VND" ? "₫" : currentCurrency()})</option>
              <option value="percent">Percent (0–1)</option>
              <option value="number">Number</option>
            </select>
          </label>
          <label className="field wide"><span>SQL — one SELECT returning a single column named <span className="mono">value</span></span>
            <textarea rows={Math.min(16, sql.split("\n").length + 2)} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
          </label>
        </div>
        <p className="faint small mt-3">
          {kind === "flow" ? <>Use <span className="mono">{"{{start}}"}</span> and <span className="mono">{"{{end}}"}</span> for the period. Crema runs it over the last 30 days and over each month to draw the history.</>
            : <>Use <span className="mono">{"{{at}}"}</span> for the moment being measured. Crema runs it now and at each month end to draw the history.</>}
          {" "}Every query runs in a read-only transaction.
        </p>
        <div className="row mt-4 wrap">
          <button className="btn" onClick={run} disabled={running || !sql.trim()}>{running ? <span className="spin" /> : "Run on my data"}</button>
          {fresh && (preview.ok
            ? <span>Value <b className="num mono">{display(preview.value, unit, { compact: false })}</b> <span className="muted small">· {preview.ms} ms</span></span>
            : <span className="small text-fail">{preview.error}</span>)}
        </div>
      </div>

      {fresh && preview.ok && (
        <div className="section">
          <div className="section-title">Last 12 months</div>
          <div className="card pad"><LineChart lines={[{ label: name || "New metric", series: preview.series, color: "var(--s0)" }]} unit={unit} /></div>
          <div className="section-title mt-5">Checked by Crema</div>
          <div className="card pad"><Checks checks={preview.checks} /></div>
        </div>
      )}

      <div className="section card pad">
        <div className="form-grid">
          <div className="field">Certified by<span className="mono" style={{ paddingTop: 8 }}>{who}</span></div>
          <label className="field">Note for the audit log (optional)
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <div className="row mt-4">
          <span className="grow small muted">{blocked ?? "Ready. Certifying makes it available to the API and MCP."}</span>
          <button className="btn ghost" onClick={back}>Cancel</button>
          <button className="btn ok" disabled={Boolean(blocked) || busy} onClick={create}>{busy ? <span className="spin" /> : "Certify metric"}</button>
        </div>
      </div>
    </div>
  );
}
