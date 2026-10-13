"use client";
// The signed-in app's frame: loads what every page needs (the workspace, and the database named in the
// URL), keeps it fresh, and draws the status bar. Pages are real routes under app/(app)/ and read this
// through useApp().
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { setCurrency } from "@/core/format";
import { api, contested, session, setCurrentSource, spreadOf, type AppState } from "@/lib/client";
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
  /** the sidebar's middle, for a page whose navigation is a list of its own (the projects) */
  navSlot: HTMLDivElement | null;
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
  // a database in the URL that the workspace doesn't list yet (just made, or made by someone else): ask once more
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    if (!slug || !workspace || asked === slug || workspace.sources.some((x) => x.slug === slug)) return;
    setAsked(slug);
    fetchWorkspace().catch(() => {});
  }, [slug, workspace, asked, fetchWorkspace]);

  const notify = useCallback((text: string, isError = false) => {
    setToast({ text, error: isError });
    setTimeout(() => setToast(null), isError ? 6000 : 3500);
  }, []);
  const state = slug ? (scoped?.slug === slug ? scoped.state : null) : workspace;
  const [navSlot, setNavSlot] = useState<HTMLDivElement | null>(null);
  const value = useMemo<AppCtx>(() => ({ slug, workspace, state, reload, notify, navSlot }), [slug, workspace, state, reload, notify, navSlot]);

  return (
    <Ctx.Provider value={value}>
      <NewVersion />
      <div className="app">
        {/* usePathname() inside a dynamic route needs a Suspense boundary */}
        <Suspense fallback={<aside className="nav" />}><Sidebar setSlot={setNavSlot} /></Suspense>
        <div className="app-main">
          {!workspace && error
            ? <div className="center"><div className="hero"><h1>Can’t reach Crema</h1><p className="lead">{error}</p><button className="btn" onClick={reload}>Retry</button></div></div>
            : !workspace ? <div className="center"><span className="spin" /></div>
            : children}
        </div>
      </div>
      {toast && <div className={`toast ${toast.error ? "error" : ""}`} role="status">{toast.text}</div>}
    </Ctx.Provider>
  );
}

/** The proposal to review next: one that needs a decision first, in the registry's order. */
export function nextUp(state: AppState) {
  return state.proposals.find(contested) ?? state.proposals[0] ?? null;
}

const DATABASE_PAGES = ["schema", "tables", "sql"];

/** Renders a page's own navigation list into the sidebar (the projects list of the Databases page). */
export function SidebarPortal({ children }: { children: React.ReactNode }) {
  const { navSlot } = useApp();
  return navSlot ? createPortal(children, navSlot) : null;
}

/** The app's navigation: which database, what's in it, and who you are. */
function Sidebar({ setSlot }: { setSlot: (el: HTMLDivElement | null) => void }) {
  const { slug, workspace, state } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ key?: string }>();
  const section = sectionOf(pathname);              // which page of a database; null elsewhere
  const inDatabase = !!slug && !!section;
  const src = inDatabase ? state?.source ?? null : null;
  const me = workspace?.me ?? null;
  const queue = useMemo(() => (src && state ? [...state.proposals].sort((a, b) => Number(contested(b)) - Number(contested(a)) || spreadOf(b) - spreadOf(a)) : []), [src, state]);
  const needs = queue.filter(contested), looks = queue.filter((c) => !contested(c));
  const metrics = src && state ? state.metrics : [];
  const onMetric = section === "metrics" && !!params.key;
  const next = src && state && onMetric ? nextUp(state) : null;
  const scanning = !!src && state?.run?.status === "running";
  const link = (href: string, label: string, on: boolean) => <Link key={href} href={href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>{label}</Link>;
  return (
    <aside className="nav" aria-label="Navigation">
      <div className="nav-top">
        <Link href={routes.projects} className="nav-brand">crema</Link>
        {workspace && workspace.sources.length > 0 ? (
          <select className="sb-select" aria-label="Database" value={inDatabase ? slug ?? "" : ""} onChange={(e) => router.push(e.target.value ? routes.metrics(e.target.value) : routes.projects)}>
            {!inDatabase && <option value="">all databases</option>}
            {inDatabase && slug && !workspace.sources.some((x) => x.slug === slug) && <option value={slug}>{slug}</option>}
            {workspace.sources.map((x) => <option key={x.id} value={x.slug}>{x.name}{x.status !== "ready" ? ` (${x.status})` : ""}</option>)}
          </select>
        ) : <span className="nav-empty">no database yet</span>}
        {src && !src.readOnly && <span className="nav-warn" title={`This login can write to ${src.writableTables} tables. Crema only runs read-only transactions, but a read-only login is safer.`}>(login can write)</span>}
      </div>

      {src ? (
        <>
          <nav className="nav-links" aria-label="Sections">
            {link(routes.metrics(src.slug), "Metrics", section === "metrics" || section === "proposals")}
            {link(routes.schema(src.slug), "Database", DATABASE_PAGES.includes(section ?? ""))}
            {link(routes.business(src.slug), "Business & API", section === "business")}
          </nav>
          <div className="nav-scroll">
            {!scanning && <Link href={routes.newMetric(src.slug)} className="btn sm nav-new">+ New metric</Link>}
            {needs.length > 0 && <h4>Needs you · {needs.length}</h4>}
            {needs.map((c) => <Link key={c.id} href={routes.proposal(src.slug, c.id)} className={`nav-item ${pathname === routes.proposal(src.slug, c.id) ? "on" : ""}`}><span>{c.name}</span><i className="dot warn" /></Link>)}
            {looks.length > 0 && <h4>Looks right · {looks.length}</h4>}
            {looks.map((c) => <Link key={c.id} href={routes.proposal(src.slug, c.id)} className={`nav-item ${pathname === routes.proposal(src.slug, c.id) ? "on" : ""}`}><span>{c.name}</span><i className="dot" /></Link>)}
            {metrics.length > 0 && <h4>Certified · {metrics.length}</h4>}
            {metrics.map((m) => <Link key={m.key} href={routes.metric(src.slug, m.key)} className={`nav-item ${pathname === routes.metric(src.slug, m.key) ? "on" : ""}`}><span>{m.name}</span><i className="dot ok" /></Link>)}
            {!queue.length && !metrics.length && <p className="nav-empty">{scanning ? "Scanning…" : "Nothing yet."}</p>}
          </div>
        </>
      ) : (
        <>
          <nav className="nav-links" aria-label="Workspace">
            {link(routes.projects, "Projects", pathname === routes.projects || pathname.startsWith("/projects/") || pathname.startsWith("/servers/") || pathname === routes.connect)}
            {me?.role === "admin" && link(routes.people, "People", pathname === routes.people)}
          </nav>
          <div className="nav-scroll" ref={setSlot} />
        </>
      )}

      <div className="nav-foot">
        {src && state && <span>{state.proposals.length} proposed · {state.metrics.length} certified</span>}
        {next && <Link href={routes.proposal(src!.slug, next.id)}>next: {next.name} (j)</Link>}
        {me && (
          <div className="nav-user">
            <Link href={me.role === "admin" ? routes.people : routes.projects} title={me.email}>{me.name}</Link>
            <button className="sb-btn" onClick={async () => { await authClient.signOut(); window.location.href = "/sign-in"; }}>sign out</button>
          </div>
        )}
      </div>
    </aside>
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
