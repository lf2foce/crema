"use client";
import Link from "next/link";
import { api, type AppState } from "@/lib/client";
import { routes } from "@/lib/routes";

export function FirstRun({ state, reload, notify }: { state: AppState; reload: () => void; notify: (t: string, e?: boolean) => void }) {
  const slug = state.source!.slug;
  return (
    <div className="center">
      <div className="hero">
        <div className="eyebrow">{state.source?.name}</div>
        <h1>{state.run?.status === "failed" ? "Discovery didn’t finish" : "Ready when you are"}</h1>
        <p className="lead">{state.run?.error ?? (state.model.configured ? "Let Crema propose the metrics your business runs on, or write one you already know." : "Set GEMINI_API_KEY in your environment and restart Crema so it can propose metrics. You can also create a metric by hand.")}</p>
        <div className="row wrap">
          <button className="btn primary lg" disabled={!state.model.configured} onClick={async () => { try { await api("/api/discover", { body: {} }); reload(); } catch (e) { notify((e as Error).message, true); } }}>Discover metrics</button>
          <Link className="btn lg" href={routes.newMetric(slug)}>Create metric by hand</Link>
          <Link className="btn ghost" href={routes.connect}>Connect another database</Link>
        </div>
      </div>
    </div>
  );
}
