"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { api, type AppState } from "@/lib/client";
import { routes } from "@/lib/routes";

/** The first screen of a new workspace, and "Connect existing": a connection string. What it is (production, staging…) is set on its page afterwards. */
export function Connect({ state, notify }: { state: AppState; notify: (t: string, e?: boolean) => void }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const admin = state.me?.role === "admin";
  const canCreate = state.servers.length > 0 || !!state.suggestedServer; // somewhere to create a database of your own
  const go = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await api<{ source: { slug: string }; writableTables: number; readOnlyRole: boolean }>("/api/sources", { body, source: null });
      if (state.model.configured) await api("/api/discover", { body: {}, source: r.source.slug });
      router.push(routes.metrics(r.source.slug));
    } catch (e) { notify((e as Error).message, true); setBusy(false); }
  }, [state.model.configured, notify, router]);
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
        <div className="palette-opts">
          <button type="submit" className="on" disabled={busy || !url}>
            <span>connect &amp; scan<span className="muted">read-only · schema + statistics, no rows</span></span>
            <span className="muted">{busy ? <span className="spin" /> : "↵"}</span>
          </button>
        </div>
      </form>
      {(canCreate || state.demoAvailable) && (
        <p className="connect-alt">
          No database yet?{" "}
          {canCreate && <><Link href={routes.projects}>Create one</Link> for your app</>}
          {canCreate && state.demoAvailable && ", or "}
          {state.demoAvailable && <button type="button" className="linkish" disabled={busy} onClick={() => go({ demo: true })}>{busy && !url ? "opening the demo…" : canCreate ? "try the demo database" : "Try the demo database"}</button>}
          {canCreate && state.demoAvailable ? "; Crema can analyse either." : canCreate ? "; Crema can analyse it too." : ", a messy sample SaaS; Crema finds its metrics."}
        </p>
      )}
      <div className="trust-row">
        <span>Never writes to your database</span>
        <span title={`Model: ${state.model.name}`}>No rows sent to the AI</span>
        <span>A person certifies every metric</span>
      </div>
    </div>
  );
}

