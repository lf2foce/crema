"use client";
// The pages of app/(app)/, as client components: each reads what it needs from the app frame (useApp)
// and the URL, and renders the screen. The route files stay one line.
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { contested, spreadOf, type AppState } from "@/lib/client";
import { routes } from "@/lib/routes";
import { DatabaseTabs, nextUp, useApp } from "./AppShell";
import { Connect } from "./Connect";
import { Databases } from "./Databases";
import { Discovery } from "./Discovery";
import { FirstRun } from "./FirstRun";
import { MetricView } from "./MetricView";
import { NewMetric } from "./NewMetric";
import { Overview } from "./Overview";
import { People } from "./People";
import { ProposalView } from "./Proposal";
import { Registry } from "./Registry";
import { Schema } from "./Schema";
import { SqlEditor } from "./SqlEditor";
import { Tables } from "./Tables";

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

// ---------- workspace pages ----------

/** "/": the first database's metrics when there's one to look at, else connecting the first. */
export function RootScreen() {
  const { workspace } = useApp();
  const router = useRouter();
  useEffect(() => {
    if (!workspace) return;
    router.replace(workspace.sources.some((x) => x.status === "ready") ? routes.projects : routes.connect);
  }, [workspace, router]);
  return <div className="center"><span className="spin" /></div>;
}

export function ProjectsScreen({ server = null }: { server?: number | null }) {
  const { workspace, notify, reload } = useApp();
  const params = useParams<{ slug?: string }>();
  if (!workspace) return null;
  return <Databases state={workspace} selected={params.slug ? decode(params.slug) : null} server={server} notify={notify} reload={reload} />;
}

export function ServerScreen() {
  const params = useParams<{ id: string }>();
  return <ProjectsScreen server={Number(params.id)} />;
}

export function ConnectScreen() {
  const { workspace, notify } = useApp();
  return workspace ? <Connect state={workspace} notify={notify} /> : null;
}

export function PeopleScreen() {
  const { workspace, notify } = useApp();
  if (!workspace?.me) return null;
  return <People me={workspace.me} notify={notify} />;
}

// ---------- one database ----------

/** Gates every page of a database: loading, missing, not ready, or being scanned. Children can count on a ready source. */
export function SourceGate({ children }: { children: React.ReactNode }) {
  const { slug, state, reload } = useApp();
  const router = useRouter();
  const done = useCallback(() => { router.push(routes.metrics(slug!)); reload(); }, [router, slug, reload]);
  if (!state) return <div className="center"><span className="spin" /></div>;
  if (!state.source) return <div className="center"><div className="hero"><h1>No database “{slug}”</h1><p className="lead">It may have been removed, or it belongs to another workspace.</p><Link className="btn" href={routes.projects}>All databases</Link></div></div>;
  if (state.source.status !== "ready") return <div className="center"><div className="hero"><h1>{state.source.name} isn’t ready</h1><p className="lead">{state.source.status === "provisioning" ? "It’s being created." : state.source.error ?? "It failed to provision."}</p><Link className="btn" href={routes.project(state.source.slug)}>Open in Databases</Link></div></div>;
  if (state.run?.status === "running") return <Discovery runId={state.run.id} onDone={done} />;
  return <>{children}</>;
}

/** state of a database that passed the gate */
function useSource(): { state: AppState & { source: NonNullable<AppState["source"]> }; slug: string } {
  const { state, slug } = useApp();
  return { state: state as AppState & { source: NonNullable<AppState["source"]> }, slug: slug! };
}

function useProposals(state: AppState) {
  return useMemo(() => [...state.proposals].sort((a, b) => Number(contested(b)) - Number(contested(a)) || spreadOf(b) - spreadOf(a)), [state]);
}

export function MetricsScreen() {
  const { state } = useSource();
  const { reload, notify } = useApp();
  const proposals = useProposals(state);
  const empty = !state.proposals.length && !state.metrics.length;
  return empty ? <FirstRun state={state} reload={reload} notify={notify} /> : <Registry state={state} proposals={proposals} reload={reload} notify={notify} />;
}

export function MetricScreen() {
  const { state, slug } = useSource();
  const { reload, notify } = useApp();
  const router = useRouter();
  const params = useParams<{ key: string }>();
  const key = decode(params.key);
  // j on a certified metric: on to the next proposal that needs a person
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "j" || (e.target as HTMLElement).closest("input, textarea, select")) return;
      const next = nextUp(state);
      if (next) router.push(routes.proposal(slug, next.id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, slug, router]);
  return <MetricView key={key} source={state.source} metricKey={key} back={() => router.push(routes.metrics(slug))} notify={notify} reload={reload} cwd={state.cwd} tokenRequired={state.tokenRequired} />;
}

export function ProposalScreen() {
  const { state, slug } = useSource();
  const { reload, notify } = useApp();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const proposals = useProposals(state);
  const selected = state.proposals.find((p) => p.id === id) ?? state.rejected.find((p) => p.id === id);
  const toList = () => router.push(routes.metrics(slug));
  if (!selected) return <div className="page"><button className="btn sm ghost" onClick={toList}>← Metrics</button><p className="muted">This proposal is no longer open.</p></div>;
  return (
    <ProposalView key={selected.id} concept={selected} queue={proposals} runId={selected.runId} model={state.understanding?.model ?? state.model.name}
      back={toList} notify={notify}
      onCertified={async (key) => { await reload(); router.push(routes.metric(slug, key)); }}
      onChanged={async () => { await reload(); const next = proposals.find((p) => p.id !== selected.id); router.push(next ? routes.proposal(slug, next.id) : routes.metrics(slug)); }} />
  );
}

export function BusinessScreen() {
  const { state, slug } = useSource();
  const { reload, notify } = useApp();
  const router = useRouter();
  return <Overview state={state} reload={reload} notify={notify} back={() => router.push(routes.metrics(slug))} />;
}

export function NewMetricScreen() {
  const { slug } = useSource();
  const { reload, notify } = useApp();
  const router = useRouter();
  return <NewMetric notify={notify} back={() => router.push(routes.metrics(slug))} onCreated={async (key) => { await reload(); router.push(routes.metric(slug, key)); }} />;
}

/** The raw-database pages share the Schema / Tables / SQL editor tab bar. */
function DatabasePage({ children }: { children: React.ReactNode }) {
  return <><Suspense fallback={null}><DatabaseTabs /></Suspense>{children}</>;
}

export function SchemaScreen() {
  const { notify } = useApp();
  return <DatabasePage><Schema notify={notify} /></DatabasePage>;
}

export function SqlScreen() {
  const { state } = useSource();
  const { notify } = useApp();
  return <DatabasePage><SqlEditor state={state} notify={notify} /></DatabasePage>;
}

export function TablesScreen() {
  const { notify } = useApp();
  const params = useParams<{ table?: string }>();
  return <DatabasePage><Tables table={params.table ? decode(params.table) : null} notify={notify} /></DatabasePage>;
}
