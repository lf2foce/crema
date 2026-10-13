"use client";
import { useCallback, useEffect, useState } from "react";
import { display } from "@/core/format";
import type { MetricKind, MetricUnit, SeriesPoint } from "@/core/types";
import { actor, ago, api, windowLabel, type AuditEvent, type Verification, sourceHref, type Source } from "@/lib/client";
import { Checks, Code, LineChart, useConfirm } from "./ui";

type Contract = {
  key: string; name: string; question: string; description: string; kind: MetricKind; unit: MetricUnit; version: number;
  certifiedBy: string; certifiedAt: string; owner: string; origin: string; sql: string; dependsOn: string[];
  status: "certified" | "needs_attention" | "deprecated"; attention: string | null;
  latest: { value: number | null; series: SeriesPoint[] };
  history: { version: number; certifiedBy: string; certifiedAt: string; note: string | null; origin: string; sql: string; description: string }[];
  events: AuditEvent[];
};
type Values = { version: number; points?: SeriesPoint[]; value?: number | null; unit: MetricUnit };

export function MetricView({ source, metricKey, back, notify, reload, cwd, tokenRequired }: { source: Source; metricKey: string; back: () => void; notify: (t: string, e?: boolean) => void; reload: () => void; cwd: string; tokenRequired: boolean }) {
  const [ask, confirmDialog] = useConfirm();
  const ref = `${encodeURIComponent(source.slug)}/${encodeURIComponent(metricKey)}`;
  const [m, setM] = useState<Contract | null>(null);
  const [grain, setGrain] = useState<"week" | "month" | "quarter">("month");
  const [series, setSeries] = useState<Values | null>(null);
  const [now, setNow] = useState<Values | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"link" | "sheet" | "api" | "sql" | "ai">("link");
  const [revising, setRevising] = useState(false);

  const load = useCallback(async () => {
    try { setM(await api<Contract>(`/api/v1/metrics/${ref}`)); } catch (e) { setErr((e as Error).message); }
  }, [ref]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!m) return;
    const to = new Date();
    const back = grain === "week" ? 26 * 7 : grain === "month" ? 365 : 730;
    const from = new Date(to.getTime() - back * 86_400_000).toISOString().slice(0, 10);
    // the server refuses to serve values while the metric needs attention, and says why
    const failed = (e: Error) => { setErr(e.message); if (/needs attention/.test(e.message)) load(); };
    api<Values>(`/api/v1/metrics/${ref}/values?grain=${grain}&from=${from}`).then(setSeries).catch(failed);
    const q = m.kind === "flow" ? `?from=${new Date(to.getTime() - 30 * 86_400_000).toISOString()}` : "";
    api<Values>(`/api/v1/metrics/${ref}/values${q}`).then(setNow).catch(failed);
  }, [m, grain, ref]);

  if (err && !m) return <div className="page"><a className="crumb" href="#">← Metrics</a><p className="muted">{err}</p></div>;
  if (!m) return <div className="page"><span className="spin" /></div>;

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3300";
  const rest = `curl -s "${origin}/api/v1/metrics/${ref}/values?grain=month&from=2026-01-01" \\\n  -H "Authorization: Bearer $CREMA_API_TOKEN"`;
  const mcpUrl = `${origin}/api/mcp`;
  const mcpLocal = JSON.stringify({ mcpServers: { crema: { command: "npx", args: ["tsx", `${cwd}/bin/crema.ts`, "mcp"] } } }, null, 2);
  const cli = `npx tsx bin/crema.ts query ${ref} --grain month --from 2026-01-01`;

  const link = `${origin}${sourceHref(source.slug, `m/${encodeURIComponent(m.key)}`)}`;
  const sheet = `=IMPORTDATA("${origin}/api/v1/metrics/${ref}/values?grain=month&format=csv&token=YOUR_API_TOKEN")`;
  const me = actor.get();
  const who = (name: string) => (me && name === me ? "you" : name);
  const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const period = m.kind === "flow" ? "last 30 days" : `as of ${date(new Date().toISOString())}`;
  const versions = [...m.history].sort((a, b) => b.version - a.version);
  const draftLine = m.origin === "human" ? "written by hand" : "proposed by AI from the scan";

  return (
    <div className="cert-grid">
      <main className="cert-doc">
        <span className="cert-pill">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Certified by {who(m.certifiedBy)} · v{m.version} · {date(m.certifiedAt)}
        </span>
        <h1 className="title">{m.name}</h1>
        <p className="sentence">{m.description}</p>

        {m.status === "needs_attention" && (
          <div className="callout warn attention mb-4">
            <div className="grow"><b>Needs attention — not served.</b> {m.attention} Every channel (API, MCP, spreadsheet) refuses it until a person checks the definition still holds and re-certifies it.</div>
            {!revising && <button className="btn sm" onClick={() => setRevising(true)}>Re-certify</button>}
          </div>
        )}

        <div className="value-line">
          <span className="value-hero num">{m.status === "needs_attention" ? "—" : now ? display(now.value ?? null, m.unit, { compact: false }) : <span className="spin" />}</span>
          <span className="muted">{period}</span>
        </div>

        <div className="trend">
          <div className="trend-head">
            <span className="eyebrow">Trend · computed live through the API</span>
            <span className="grow" />
            <div className="seg">{(["week", "month", "quarter"] as const).map((g) => <button key={g} className={grain === g ? "on" : ""} onClick={() => setGrain(g)}>{g}</button>)}</div>
          </div>
          {m.status === "needs_attention" ? <div className="chart-wait faint">Not served while it needs attention.</div> : series?.points ? <LineChart lines={[{ label: m.name, series: series.points, color: "var(--s0)" }]} unit={m.unit} height={160} /> : <div className="chart-wait"><span className="spin" /></div>}
        </div>

        <div className="history">
          <div className="eyebrow">History</div>
          {revising && <Revise m={m} notify={notify} done={async (changed) => { setRevising(false); if (changed) { await load(); reload(); } }} />}
          <ul className="hist">
            {versions.map((h) => (
              <li key={h.version}><b>v{h.version}</b> · {who(h.certifiedBy)} certified{h.note ? ` · ${h.note}` : ""} <span className="faint">· {ago(h.certifiedAt)}</span></li>
            ))}
            <li><b>draft</b> · {draftLine}</li>
          </ul>
          <p className="faint small m-0">If the tables behind this change, it stops being served (“needs attention”) until someone re-certifies it.</p>
          <div className="hist-actions">
            {!revising && <button className="linkish" onClick={() => setRevising(true)}>Revise definition</button>}
            <details>
              <summary>Audit log ({m.events.length})</summary>
              <ul className="checks timeline mt-2">
                {m.events.map((e) => <li key={e.id}><span className="faint small">{new Date(e.at).toLocaleString()}</span><span className="small"><b>{e.actor}</b> <span className="mono">{e.action}</span></span></li>)}
              </ul>
            </details>
            <button className="linkish danger" onClick={async () => {
              const answer = await ask({ title: `Deprecate ${m.name}?`, body: "Consumers (API, MCP) stop receiving it. Its history stays.", reason: { label: "Reason (goes into the audit log)" }, confirmLabel: "Deprecate", danger: true });
              if (!answer.ok) return;
              const reason = answer.reason;
              try { await api(`/api/metrics/${m.key}/deprecate`, { body: { reason } }); notify(`Deprecated ${m.name}.`); reload(); back(); } catch (e) { notify((e as Error).message, true); }
            }}>Deprecate</button>
          </div>
        </div>
      </main>

      <aside className="cert-side">
        <h2>Use it anywhere</h2>
        <div className="round-pills" role="tablist">
          {([["link", "Share link"], ["sheet", "Spreadsheet"], ["api", "API"], ["sql", "SQL"], ["ai", "AI agents"]] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        {tab === "link" && <>
          <p className="use-lead">Send this page to anyone on your team. They see the sentence, the number and who certified it.</p>
          <Code>{link}</Code>
          <p className="use-note">They see the current certified version and its history.</p>
        </>}
        {tab === "sheet" && <>
          <p className="use-lead">Paste into a Google Sheets cell. It refreshes with the certified number, one row per month.</p>
          <Code>{sheet}</Code>
          <p className="use-note">Google fetches this from its own servers, so the address must be reachable from the internet; <span className="mono">localhost</span> isn’t. Excel: Data → From Web with the same URL. {tokenRequired ? <>Use the server’s <span className="mono">CREMA_API_TOKEN</span>; anyone with the link and token can read this metric.</> : <>Set <span className="mono">CREMA_API_TOKEN</span> on the server first: spreadsheets can’t sign in.</>}</p>
        </>}
        {tab === "api" && <>
          <p className="use-lead">Every answer carries its provenance: version, who certified it, and <span className="mono">trust</span>.</p>
          <Code>{rest}</Code>
          <Code>{cli}</Code>
          <p className="use-note">Software reads with the server’s <span className="mono">CREMA_API_TOKEN</span>{tokenRequired ? "" : " (not set yet: set it to enable this)"}. Pin a version with <span className="mono">&version={m.version}</span>; add <span className="mono">&format=csv</span> for a spreadsheet.</p>
        </>}
        {tab === "sql" && <>
          <p className="use-lead">The certified definition, for a BI tool or a notebook. It reads {m.dependsOn.join(", ")}.</p>
          <Code>{m.sql}</Code>
          <p className="use-note"><span className="mono">{"{{start}}"}</span>, <span className="mono">{"{{end}}"}</span> and <span className="mono">{"{{at}}"}</span> are the period. {m.origin === "ai" ? "Proposed by AI, certified unchanged." : m.origin === "ai+human-edit" ? "Proposed by AI, edited by a person." : "Written by a person."}</p>
        </>}
        {tab === "ai" && <>
          <p className="use-lead">Add this URL as a connector in Claude, ChatGPT or Cursor. The assistant asks you to sign in and approve, then can read certified metrics only, so “what’s our {m.name.toLowerCase()}?” gets this number, not freshly invented SQL.</p>
          <Code>{mcpUrl}</Code>
          <p className="use-note">MCP 2026-07-28 with OAuth. The address must be reachable by the assistant; <span className="mono">localhost</span> only works for apps on this machine.</p>
          <details>
            <summary>Or run it locally over stdio</summary>
            <div className="mt-2"><Code>{mcpLocal}</Code></div>
          </details>
        </>}
        <div className="served-note">Only certified metrics are served. Drafts don’t exist to the API, MCP or CLI: consumers get this number or nothing, never a guess.</div>
      </aside>
      {confirmDialog}
    </div>
  );
}

function Revise({ m, notify, done }: { m: Contract; notify: (t: string, e?: boolean) => void; done: (changed: boolean) => void }) {
  const [sql, setSql] = useState(m.sql);
  const [description, setDescription] = useState(m.description);
  const [note, setNote] = useState("");
  const who = actor.get();
  const [preview, setPreview] = useState<Verification | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sqlChanged = sql.trim() !== m.sql.trim();
  const blocked = sqlChanged && previewFor !== sql ? "Run the new definition first." : preview && previewFor === sql && !preview.ok ? "It doesn’t run." : !note.trim() ? "Say why it changed." : !who.trim() ? "Add your name." : null;
  return (
    <div className="card pad mb-3">
      <div className="small muted mb-2">A revision creates v{m.version + 1}. v{m.version} stays readable for anyone who pinned it.</div>
      <div className="stack">
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        <textarea rows={Math.min(16, sql.split("\n").length + 2)} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
        <div className="row">
          <button className="btn sm" onClick={async () => {
            try { setPreview(await api<Verification>("/api/preview", { body: { kind: m.kind, unit: m.unit, sql } })); setPreviewFor(sql); } catch (e) { notify((e as Error).message, true); }
          }}>Run on my data</button>
          {preview && previewFor === sql && <span className="small">{preview.ok ? <>New value <b className="num">{display(preview.value, m.unit, { compact: false })}</b> <span className="muted">(was {display(m.latest.value, m.unit, { compact: false })})</span></> : <span className="text-fail">{preview.error}</span>}</span>}
        </div>
        {preview && previewFor === sql && <Checks checks={preview.checks} />}
        <div className="row wrap">
          <input className="input grow" placeholder="Why is it changing? (required)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn ghost" onClick={() => done(false)}>Cancel</button>
          <button className="btn ok" disabled={Boolean(blocked) || busy} title={blocked ?? ""} onClick={async () => {
            setBusy(true);
            try { const r = await api<{ version: number }>(`/api/metrics/${m.key}/revise`, { body: { edits: { sql, description }, note } }); notify(`Certified v${r.version}.`); done(true); }
            catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
          }}>Certify v{m.version + 1}</button>
        </div>
      </div>
    </div>
  );
}
