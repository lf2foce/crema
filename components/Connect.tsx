"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, type AppState } from "@/lib/client";
import { routes } from "@/lib/routes";

/** The first screen of a new workspace, and "Connect existing": a connection string (and what it is), or the demo. */
export function Connect({ state, notify }: { state: AppState; notify: (t: string, e?: boolean) => void }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [environment, setEnvironment] = useState(""); // what this database is: chosen by the person, never assumed
  const [busy, setBusy] = useState(false);
  const admin = state.me?.role === "admin";
  const go = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await api<{ source: { slug: string }; writableTables: number; readOnlyRole: boolean }>("/api/sources", { body: { ...body, environment: environment || null }, source: null });
      if (state.model.configured) await api("/api/discover", { body: {}, source: r.source.slug });
      router.push(routes.metrics(r.source.slug));
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
          <span className="muted">Label it (optional)</span>
          {(["production", "staging", "development"] as const).map((v) => (
            // pick one, or click it again (or none) to leave it unlabelled
            <button key={v} type="button" aria-pressed={environment === v} className={environment === v ? "on" : ""} onClick={() => setEnvironment(environment === v ? "" : v)}>{v}</button>
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
      {(state.servers.length > 0 || state.suggestedServer) && <p className="connect-alt">No database yet? <Link href={routes.projects}>Create one</Link> for your app; Crema can analyse it too.</p>}
    </div>
  );
}

