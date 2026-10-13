"use client";
import { useEffect, useState } from "react";
import { actor, ago, api, type AppState, type AuditEvent } from "@/lib/client";
import { Code, ConfidenceChip, Modal } from "./ui";

export function Overview({ state, reload, notify, back }: { state: AppState; reload: () => void; notify: (t: string, e?: boolean) => void; back: () => void }) {
  const u = state.understanding;
  const [payload, setPayload] = useState<unknown | null>(null);
  const [hint, setHint] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  useEffect(() => { api<AuditEvent[]>("/api/audit?limit=30").then(setEvents).catch(() => {}); }, [state]);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="page narrow">
      <div className="eyebrow"><span className="chip accent">Inferred by {u?.model ?? state.model.name}</span>{u && <span>{ago(u.at)}</span>}</div>
      <h1 className="title">How we read your business</h1>
      <p className="meaning">{u?.summary ?? "Run discovery to see how Crema reads your schema."}</p>

      {u && (
        <div className="section">
          <div className="section-title">What each table means</div>
          <div className="card">
            {u.entities.map((e, i) => (
              <div key={e.table} className="row pad list-row top">
                <span className="mono small entity-name">{e.table.replace(/^public\./, "")}</span>
                <span className="grow">{e.meaning}</span>
                <ConfidenceChip c={e.confidence} />
              </div>
            ))}
          </div>
          <div className="row mt-3">
            <button className="btn sm" onClick={async () => setPayload(await api(`/api/runs/${u.runId}/payload`))}>See exactly what the model was sent</button>
            <span className="faint small">Schema and statistics only. No rows.</span>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title">Something wrong?</div>
        <form className="card pad stack" onSubmit={async (e) => {
          e.preventDefault();
          try { await api("/api/discover", { body: { hint: hint.trim() || null } }); reload(); } catch (err) { notify((err as Error).message, true); }
        }}>
          <textarea rows={3} className="prose" placeholder="Tell Crema what it got wrong, e.g. “accounts on the enterprise plan are billed offline” or “a customer is an account with at least one paid invoice”."
            value={hint} onChange={(e) => setHint(e.target.value)} />
          <div className="row"><span className="grow faint small">Open proposals are replaced. Certified metrics are never touched.</span><button className="btn">{hint.trim() ? "Re-discover with this context" : "Re-discover"}</button></div>
        </form>
      </div>

      <div className="section">
        <div className="section-title">For software and AI</div>
        <div className="card pad small">
          <p className="mt-0">Everything certified is served over a versioned API and an MCP server. Proposals are never visible there: consumers only ever see what a person vouched for.</p>
          <Code>{`GET ${origin}/api/v1/metrics                      # certified metrics + definitions
GET ${origin}/api/v1/metrics/:database/:key           # one contract, history, audit trail
GET ${origin}/api/v1/metrics/:database/:key/values?grain=month&from=2026-01-01&version=1`}</Code>
          <p className="muted mb-0">Set <span className="mono">CREMA_API_TOKEN</span> to require a bearer token. MCP: <span className="mono">npx tsx bin/crema.ts mcp</span>.</p>
        </div>
      </div>

      {state.rejected.length > 0 && (
        <div className="section">
          <div className="section-title">Rejected</div>
          <div className="card">
            {state.rejected.map((d) => (
              <div key={d.id} className="row pad list-row">
                <span className="grow">{d.name}</span>
                <button className="btn sm ghost" onClick={async () => {
                  try { await api(`/api/proposals/${d.id}/reopen`, { body: {} }); reload(); } catch (e) { notify((e as Error).message, true); }
                }}>Reopen</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="section">
          <div className="section-title">Audit log</div>
          <div className="card pad">
            <ul className="checks timeline">
              {events.map((e) => (
                <li key={e.id}>
                  <span className="faint small">{ago(e.at)}</span>
                  <span className="small"><b>{e.actor}</b> <span className="mono">{e.action}</span> <span className="muted">{e.subject}</span></span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="section row">
        <span className="grow faint small"><span className="mono">{state.source?.name}</span> · {state.source?.kind === "hosted" ? "hosted by Crema" : "connected"}</span>
        <a className="btn sm ghost" href={`/#databases/${state.source?.slug}`}>Manage in Databases</a>
      </div>

      {payload !== null && (
        <Modal onClose={() => setPayload(null)}>
          <div className="row mb-3"><b className="grow">Sent to {u?.model}</b><button className="btn sm" onClick={() => setPayload(null)}>Close</button></div>
          <p className="muted small mt-0">This is the complete model input apart from the instructions. Columns whose names suggest personal data are never value-profiled, and high-cardinality values are never included.</p>
          <Code>{JSON.stringify(payload, null, 2)}</Code>
        </Modal>
      )}
    </div>
  );
}
