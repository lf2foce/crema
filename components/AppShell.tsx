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
      {/* usePathname() inside a dynamic route needs a Suspense boundary */}
      <Suspense fallback={<header className="statusbar" />}>
        <Frame setSlot={setNavSlot}>
          {!workspace && error
            ? <div className="center"><div className="hero"><h1>Can’t reach Crema</h1><p className="lead">{error}</p><button className="btn" onClick={reload}>Retry</button></div></div>
            : !workspace ? <div className="center"><span className="spin" /></div>
            : children}
        </Frame>
      </Suspense>
      {toast && <div className={`toast ${toast.error ? "error" : ""}`} role="status">{toast.text}</div>}
    </Ctx.Provider>
  );
}

/** The proposal to review next: one that needs a decision first, in the registry's order. */
export function nextUp(state: AppState) {
  return state.proposals.find(contested) ?? state.proposals[0] ?? null;
}

const DATABASE_PAGES = ["schema", "tables", "sql"];

/**
 * Header on top; below it the sidebar (the metrics to settle: proposals, certified) and the page.
 * Only the proposal pages have the sidebar (it's for settling metrics: the queue, certified ones): the
 * list of metrics already is the metrics page. Everywhere else in a database the header carries who you are.
 */
function Frame({ setSlot, children }: { setSlot: (el: HTMLDivElement | null) => void; children: React.ReactNode }) {
  const { slug } = useApp();
  const section = sectionOf(usePathname());
  // the sidebar is for settling proposals; every other page of a database has the room (and the header holds the person)
  const wide = !!slug && !!section && section !== "proposals";
  return (
    <>
      <StatusBar account={wide} />
      <div className={`app ${wide ? "app-wide" : ""}`}>
        {!wide && <Sidebar setSlot={setSlot} />}
        <div className="app-main">{children}</div>
      </div>
    </>
  );
}

/** The slim header: where you are (crema, all metrics / this metric) and the two places to go from a database. */
function StatusBar({ account }: { account: boolean }) {
  const { slug, state, workspace } = useApp();
  const me = workspace?.me ?? null;
  const pathname = usePathname();
  const params = useParams<{ key?: string; id?: string }>();
  const section = sectionOf(pathname);              // which page of a database; null elsewhere
  const src = slug && section ? state?.source ?? null : null;
  const busy = !!src && state?.run?.status === "running";
  const onMetric = section === "metrics" && !!params.key;
  const onProposal = section === "proposals";
  const inner = !!section && section !== "metrics" || onMetric;   // a page inside a database other than its metrics list
  return (
    <header className="statusbar">
      <span className="sb-left">
        <Link href={routes.projects} className="sb-brand">crema</Link>
        {!src && workspace?.me?.role === "admin" && <Link href={routes.people} className={pathname === routes.people ? "on" : ""} title="People who can sign in">People</Link>}
        {src && <><span>—</span><Link href={routes.project(src.slug)} className="sb-project" title="How to connect, branches">{src.name}</Link><EnvBadge environment={src.environment} /><span>—</span><Link href={routes.metrics(src.slug)} className={inner ? "on" : ""}>{inner ? "← all metrics" : "all metrics"}</Link></>}
        {onMetric && <span className="ellipsis">/ {safeDecode(params.key!)}</span>}
        {onProposal && <span className="ellipsis">/ {state?.proposals.find((p) => p.id === Number(params.id))?.key ?? "proposal"}</span>}
      </span>
      <span className="grow" />
      {src && !busy && (
        <nav className="sb-right" aria-label="Main">
          <Link href={routes.business(src.slug)} className={section === "business" ? "on" : ""}>business &amp; API</Link>
          <span>·</span>
          <Link href={routes.schema(src.slug)} className={DATABASE_PAGES.includes(section ?? "") ? "on" : ""}>database</Link>
        </nav>
      )}
      {busy && <span>scanning…</span>}
      {account && me && (
        <span className="sb-user">
          <Link href={me.role === "admin" ? routes.people : routes.projects} title={me.email}>{me.name}</Link>
          <span>·</span>
          <button className="sb-btn" onClick={async () => { await authClient.signOut(); window.location.href = "/sign-in"; }}>sign out</button>
        </span>
      )}
    </header>
  );
}

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
  // the picker lists projects; a project's branches are chosen beside it
  const projects = useMemo(() => {
    const seen = new Map<number, { id: number; name: string }>();
    for (const x of workspace?.sources ?? []) if (!seen.has(x.projectId)) seen.set(x.projectId, { id: x.projectId, name: x.projectName });
    return [...seen.values()];
  }, [workspace]);
  const branches = src ? (workspace?.sources ?? []).filter((x) => x.projectId === src.projectId && x.status === "ready").sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId) || a.id - b.id) : [];
  const link = (href: string, label: string, on: boolean) => <Link key={href} href={href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>{label}</Link>;
  return (
    <aside className="nav" aria-label="Navigation">
      <div className="nav-top">
        {src && state && (
          <>
            <select className="sb-select" aria-label="Project" value={String(src.projectId)} onChange={(e) => {
              const main = workspace?.sources.find((x) => x.projectId === Number(e.target.value) && !x.parentId);
              if (main) router.push(routes.metrics(main.slug));
            }}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {branches.length > 1 && (
              <div className="nav-branches" role="group" aria-label="Branch">
                {branches.map((b) => <Link key={b.id} href={sameSectionIn(pathname, b.slug)} className={b.id === src.id ? "on" : ""} aria-current={b.id === src.id ? "true" : undefined}>{b.branch}<EnvBadge environment={b.environment} /></Link>)}
              </div>
            )}
          </>
        )}
        {src && !src.readOnly && <span className="nav-warn" title={`This login can write to ${src.writableTables} tables. Crema only runs read-only transactions, but a read-only login is safer.`}>(login can write)</span>}
      </div>

      {src ? (
        <>
          <div className="nav-scroll">
            {!scanning && <div className="nav-new"><Link href={routes.newMetric(src.slug)} className="btn sm">+ New metric</Link></div>}
            {needs.length > 0 && <h4>Needs you · {needs.length}</h4>}
            {needs.map((c) => <Link key={c.id} href={routes.proposal(src.slug, c.id)} className={`nav-item ${pathname === routes.proposal(src.slug, c.id) ? "on" : ""}`}><span>{c.name}</span></Link>)}
            {looks.length > 0 && <h4>Looks right · {looks.length}</h4>}
            {looks.map((c) => <Link key={c.id} href={routes.proposal(src.slug, c.id)} className={`nav-item ${pathname === routes.proposal(src.slug, c.id) ? "on" : ""}`}><span>{c.name}</span></Link>)}
            {metrics.length > 0 && <h4>Certified · {metrics.length}</h4>}
            {metrics.map((m) => <Link key={m.key} href={routes.metric(src.slug, m.key)} className={`nav-item ${pathname === routes.metric(src.slug, m.key) ? "on" : ""}`}><span>{m.name}</span></Link>)}
            {!queue.length && !metrics.length && <p className="nav-empty">{scanning ? "Scanning…" : "Nothing yet."}</p>}
          </div>
        </>
      ) : (
        <>
          <div className="nav-scroll" ref={setSlot} />
        </>
      )}

      {src && state && (
        <div className="nav-stats">
          <span>{state.proposals.length} proposed · {state.metrics.length} certified</span>
          {next && <Link href={routes.proposal(src.slug, next.id)}>next: {next.name} (j)</Link>}
        </div>
      )}
      <div className="nav-foot">
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
