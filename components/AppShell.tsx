"use client";
// The signed-in app's frame: loads what every page needs (the workspace, and the database named in the
// URL), keeps it fresh, and draws the status bar. Pages are real routes under app/(app)/ and read this
// through useApp().
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { setCurrency } from "@/core/format";
import { api, contested, session, setCurrentSource, type AppState } from "@/lib/client";
import { authClient } from "@/lib/authClient";
import { routes, sameSectionIn, sectionOf } from "@/lib/routes";
import { EnvBadge } from "./ui";
import { NewVersion } from "./NewVersion";

type AppCtx = {
  /** the database in the URL (/projects/<slug>/…), or null on workspace pages */
  slug: string | null;
  /** the workspace: projects, servers, who you are. Present as soon as it's loaded, whatever the page */
  workspace: AppState | null;
  /** scoped to the database in the URL: its run, proposals, metrics. Null until loaded (or on workspace pages) */
  state: AppState | null;
  /** reload both; resolves with the one the page is about */
  reload: () => Promise<AppState | null>;
  notify: (text: string, isError?: boolean) => void;
};
const Ctx = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp() outside the app frame");
  return c;
}

/** The database slug, for components that only ever render inside one (/projects/<slug>/…). */
export function useSlug(): string {
  const { slug } = useApp();
  if (!slug) throw new Error("useSlug() outside a database page");
  return slug;
}

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export function AppShell({ children }: { children: React.ReactNode }) {
  const params = useParams<{ slug?: string }>();
  const slug = params.slug ? safeDecode(params.slug) : null;
  setCurrentSource(slug); // api() calls from pages inside a database carry it
  const [workspace, setWorkspace] = useState<AppState | null>(null);
  const [scoped, setScoped] = useState<{ slug: string; state: AppState } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  const fetchWorkspace = useCallback(async () => {
    const s = await api<AppState>("/api/state", { source: null });
    setCurrency(s.currency); session.set(s.me); setWorkspace(s); setError(null);
    return s;
  }, []);
  const fetchScoped = useCallback(async (forSlug: string) => {
    const s = await api<AppState>("/api/state", { source: forSlug });
    setScoped({ slug: forSlug, state: s }); setError(null);
    return s;
  }, []);
  const reload = useCallback(async (): Promise<AppState | null> => {
    try {
      const [w, s] = await Promise.all([fetchWorkspace(), slug ? fetchScoped(slug) : Promise.resolve(null)]);
      return s ?? w;
    } catch (e) { setError((e as Error).message); return null; }
  }, [slug, fetchWorkspace, fetchScoped]);

  useEffect(() => { fetchWorkspace().catch((e) => setError((e as Error).message)); }, [fetchWorkspace]);
  useEffect(() => { if (slug) fetchScoped(slug).catch((e) => setError((e as Error).message)); }, [slug, fetchScoped]);

  const notify = useCallback((text: string, isError = false) => {
    setToast({ text, error: isError });
    setTimeout(() => setToast(null), isError ? 6000 : 3500);
  }, []);
  const state = slug ? (scoped?.slug === slug ? scoped.state : null) : workspace;
  const value = useMemo<AppCtx>(() => ({ slug, workspace, state, reload, notify }), [slug, workspace, state, reload, notify]);

  return (
    <Ctx.Provider value={value}>
      <NewVersion />
      {/* usePathname() inside a dynamic route needs a Suspense boundary */}
      <Suspense fallback={<header className="statusbar" />}><StatusBar /></Suspense>
      {!workspace && error
        ? <div className="center"><div className="hero"><h1>Can’t reach Crema</h1><p className="lead">{error}</p><button className="btn" onClick={reload}>Retry</button></div></div>
        : !workspace ? <div className="center"><span className="spin" /></div>
        : children}
      {toast && <div className={`toast ${toast.error ? "error" : ""}`} role="status">{toast.text}</div>}
    </Ctx.Provider>
  );
}

/** The proposal to review next: one that needs a decision first, in the registry's order. */
export function nextUp(state: AppState) {
  return state.proposals.find(contested) ?? state.proposals[0] ?? null;
}

const DATABASE_PAGES = ["schema", "tables", "sql"];

function StatusBar() {
  const { slug, workspace, state } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ key?: string; id?: string }>();
  const section = sectionOf(pathname); // which page of a database; null elsewhere
  const inDatabase = !!slug && !!section;
  const src = inDatabase ? state?.source ?? null : null;
  const busy = inDatabase && state?.run?.status === "running";
  const onMetric = section === "metrics" && !!params.key;
  const onProposal = section === "proposals";
  const inner = onMetric || onProposal || section === "business" || section === "new" || DATABASE_PAGES.includes(section ?? "");
  const n = state?.proposals.length ?? 0, m = state?.metrics.length ?? 0;
  const me = workspace?.me ?? null;
  return (
    <header className="statusbar">
      <span className="sb-left">
        {src && inner ? <Link href={routes.metrics(src.slug)} className="on">← all metrics</Link> : <Link href={routes.projects}>crema</Link>}
        <span>—</span>
        {workspace && workspace.sources.length > 0 ? (
          <select className="sb-select" aria-label="Database" value={inDatabase ? slug ?? "" : ""} onChange={(e) => router.push(e.target.value ? routes.metrics(e.target.value) : routes.projects)}>
            {!inDatabase && <option value="">all databases</option>}
            {workspace.sources.map((x) => <option key={x.id} value={x.slug}>{x.name}{x.status !== "ready" ? ` (${x.status})` : ""}</option>)}
          </select>
        ) : <span>no database yet</span>}
        {src && !src.readOnly && <span className="warn" title={`This login can write to ${src.writableTables} tables. Crema only runs read-only transactions, but a read-only login is safer.`}>(login can write)</span>}
        {onMetric && <span className="ellipsis">/ {safeDecode(params.key!)}</span>}
        {onProposal && <span className="ellipsis">/ {state?.proposals.find((p) => p.id === Number(params.id))?.key ?? "proposal"}</span>}
      </span>
      <span className="grow" />
      {src && !busy && onMetric && state && (() => {
        const next = nextUp(state);
        return (
          <nav className="sb-right" aria-label="Main">
            <span>{m} of {n + m} certified</span>
            {next && <><span>·</span><Link href={routes.proposal(src.slug, next.id)}>next: {next.name} (j)</Link></>}
          </nav>
        );
      })()}
      {src && !busy && !onMetric && (
        <nav className="sb-right" aria-label="Main">
          <span className="hide-sm">{n} proposed · {m} certified ·</span>
          <Link href={routes.schema(src.slug)} className={DATABASE_PAGES.includes(section ?? "") ? "on" : ""}>database</Link>
          <span>·</span>
          <Link href={routes.business(src.slug)} className={section === "business" ? "on" : ""}>business &amp; API</Link>
          <span>·</span>
          <Link href={routes.newMetric(src.slug)} className={section === "new" ? "on" : ""}>+ new metric</Link>
        </nav>
      )}
      {busy && <span>scanning…</span>}
      {me && (
        <span className="sb-user">
          {<span>·</span>}
          <Link href={routes.projects} className={pathname === routes.projects || pathname.startsWith("/projects/") && !inDatabase || pathname.startsWith("/servers/") ? "on" : ""}>databases</Link>
          <span>·</span>
          {me.role === "admin" ? <Link href={routes.people} className={pathname === routes.people ? "on" : ""} title="People who can sign in">{me.name}</Link> : <span>{me.name}</span>}
          <span>·</span>
          <button className="sb-btn" onClick={async () => { await authClient.signOut(); window.location.href = "/sign-in"; }}>sign out</button>
        </span>
      )}
    </header>
  );
}

/** One place for looking at the raw database: its shape, its rows, and ad-hoc queries. */
export function DatabaseTabs() {
  const { state } = useApp();
  const pathname = usePathname();
  const router = useRouter();
  const section = sectionOf(pathname);
  const src = state?.source;
  if (!state || !src) return null;
  const siblings = state.sources.filter((d) => d.projectId === src.projectId && d.status === "ready");
  const tabs: [string, string, string][] = [["schema", "Schema", routes.schema(src.slug)], ["tables", "Tables", routes.tables(src.slug)], ["sql", "SQL editor", routes.sql(src.slug)]];
  return (
    <nav className="dbtabs" aria-label="Database">
      <Link href={routes.project(src.slug)}>Connect</Link>
      {tabs.map(([t, label, href]) => <Link key={t} href={href} className={section === t ? "on" : ""} aria-current={section === t ? "page" : undefined}>{label}</Link>)}
      <span className="grow" />
      <span className="dbtabs-env">
        <EnvBadge environment={src.environment} />
        {siblings.length > 1
          ? <select aria-label="Branch" value={src.slug} onChange={(e) => router.push(sameSectionIn(pathname, e.target.value))}>
              {siblings.map((d) => <option key={d.id} value={d.slug}>{d.projectName} · {d.branch}</option>)}
            </select>
          : <span className="dbtabs-note">{src.name}</span>}
        <span className="dbtabs-note">{src.kind === "hosted" ? "hosted" : "connected"} · read-only{!src.readOnly ? " transactions (this login can write)" : ""}</span>
      </span>
    </nav>
  );
}
