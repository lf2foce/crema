"use client";
import { useCallback, useEffect, useState } from "react";
import { ago, api, sourceHref, type AppState, type ServerInfo, type SourceInfo } from "@/lib/client";
import { Copy, EnvBadge, Modal, useConfirm } from "./ui";
import { DB_NAME_MAX, dbNameProblem, naturalDbName } from "@/lib/dbName";

type Conn = { host: string; port: number; database: string; user: string; password: string; ssl: boolean; connectionString: string };
type Role = "owner" | "reader";

const size = (b: number | null) => (b == null ? "—" : b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} kB` : b < 1e9 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e9).toFixed(2)} GB`);
const MASK = "••••••••••••";

// node-postgres reads sslmode=require as verify-full (unlike libpq); the hosting server's certificate
// is self-signed, so Node snippets ask for libpq's meaning: encrypted, not verified
const nodeUrl = (u: string) => u.replace("sslmode=require", "sslmode=require&uselibpqcompat=true");

const FORMATS: { id: string; label: string; render: (url: string) => string }[] = [
  { id: "url", label: "Connection string", render: (u) => u },
  { id: "env", label: ".env", render: (u) => `DATABASE_URL="${u}"` },
  { id: "psql", label: "psql", render: (u) => `psql "${u}"` },
  { id: "node", label: "Node.js", render: (u) => `import pg from "pg";\n\n// DATABASE_URL="${nodeUrl(u)}"\nconst pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });` },
  { id: "drizzle", label: "Drizzle", render: (u) => `// .env\nDATABASE_URL="${nodeUrl(u)}"\n\n// db.ts\nimport { drizzle } from "drizzle-orm/node-postgres";\nexport const db = drizzle(process.env.DATABASE_URL!);\n\n// drizzle.config.ts\nimport { defineConfig } from "drizzle-kit";\nexport default defineConfig({ dialect: "postgresql", schema: "./src/schema.ts", dbCredentials: { url: process.env.DATABASE_URL! } });` },
  { id: "python", label: "Python", render: (u) => `import psycopg\n\n# DATABASE_URL="${u}"\nconn = psycopg.connect(os.environ["DATABASE_URL"])` },
];

/**
 * Projects, Neon-style. A project is what you name (ComicAI); its branches are databases: production,
 * development, staging. Connected databases are projects of one branch. Pick a branch to see how to
 * connect, browse its tables, open it in Crema, or manage it; hosting servers are listed below.
 */
export function Databases({ state, selected, server, notify, reload }: { state: AppState; selected: string | null; server: number | null; notify: (t: string, e?: boolean) => void; reload: () => Promise<AppState | null> }) {
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const admin = state.me?.role === "admin";
  const projects = groupProjects(state.sources);
  const servers = state.servers;
  const srv = server ? servers.find((v) => v.id === server) ?? null : null;
  // a database is addressed by its slug (comic, comic_development); a bare id still works
  const db = srv ? null : state.sources.find((d) => d.slug === selected || String(d.id) === selected) ?? projects[0]?.branches[0] ?? null;
  const go = (slug: string) => { window.location.hash = `databases/${encodeURIComponent(slug)}`; };
  const goServer = (id: number) => { window.location.hash = `databases/server-${id}`; };
  // after a change: reload, then show that database (by id: it may be new), or the list
  const changed = async (id?: number) => {
    const fresh = await reload();
    const target = id ? (fresh?.sources ?? state.sources).find((d) => d.id === id) : null;
    if (target) go(target.slug); else window.location.hash = "databases";
  };
  // Creating needs a server: the installation's own one is used without asking; only without one
  // does the admin add a server first
  const create = () => (servers.length || state.suggestedServer ? setCreating(true) : setAdding(true));

  return (
    <div className="hostedpage">
      <aside className="sql-side">
        {admin && <div className="row gap-2">
          <button className="btn primary sm grow" onClick={create}>+ New project</button>
          <a className="btn sm grow" href="/#connect">Connect existing</a>
        </div>}
        <h4>{projects.length} project{projects.length === 1 ? "" : "s"}</h4>
        <ul className="sql-list">
          {projects.map((pr) => (
            <li key={pr.id} className="proj">
              <div className="proj-name ellipsis">{pr.name}</div>
              {pr.branches.map((d) => (
                <button key={d.id} className={`sql-item ${d.id === db?.id ? "on" : ""}`} onClick={() => go(d.slug)}>
                  <span className="row"><span className="ellipsis">{d.branch}</span><EnvBadge environment={d.environment} /></span>
                  <span className="faint">{d.kind === "hosted" ? "hosted" : "connected"}{d.kind === "hosted" ? ` · ${size(d.sizeBytes)}` : ""}{d.status !== "ready" ? ` · ${d.status === "provisioning" && d.parentId ? "copying" : d.status}` : ""}{d.metrics ? ` · ${d.metrics} metric${d.metrics > 1 ? "s" : ""}` : ""}</span>
                </button>
              ))}
            </li>
          ))}
        </ul>
        {admin && (
          // collapsed while there's just the one the installation came with: it's plumbing until you need a second
          <details className="side-servers" open={!!srv || servers.length !== 1}>
            <summary>Servers · {servers.length}</summary>
            <p className="use-note side-note">Postgres servers where new projects are created. Not your own databases: those you connect.</p>
            <ul className="sql-list">
              {servers.map((v) => (
                <li key={v.id} className={`saved ${v.id === srv?.id ? "on" : ""}`}>
                  <button className="sql-item" onClick={() => goServer(v.id)}>
                    <span className="ellipsis">{v.name}</span>
                    <span className="faint mono">{v.publicHost} · {v.databases} db{v.databases === 1 ? "" : "s"}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button className="btn ghost sm" onClick={() => setAdding(true)}>+ Add a server</button>
          </details>
        )}
      </aside>

      <main className="hosted-main">
        {srv ? <ServerDetail key={srv.id} server={srv} notify={notify} onChanged={() => changed()} />
          : db ? <ProjectView key={db.id} db={db} all={state.sources} server={servers.find((v) => v.id === db.serverId) ?? null} admin={admin} notify={notify} onChanged={changed} /> : (
          <div className="hosted-empty">
            <h1 className="title">Your projects</h1>
            <p className="meaning">Connect a database you already have, or create a new project for an app — and let Crema find and certify its metrics.</p>
            <div className="row gap-3"><a className="btn primary lg" href="/#connect">Connect a database</a>{admin && <button className="btn lg" onClick={create}>New project</button>}</div>
          </div>
        )}
      </main>

      {creating && <NewProject servers={servers} notify={notify} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); changed(id); }} />}
      {adding && <AddServer notify={notify} onClose={() => setAdding(false)} onAdded={async (id) => { setAdding(false); await reload(); goServer(id); }} />}
    </div>
  );
}

/** Projects with their branches: production first, then the rest in the order they were made. */
function groupProjects(sources: SourceInfo[]) {
  const by = new Map<number, { id: number; name: string; branches: SourceInfo[] }>();
  for (const d of sources) {
    const p = by.get(d.projectId) ?? { id: d.projectId, name: d.projectName, branches: [] };
    p.branches.push(d); by.set(d.projectId, p);
  }
  for (const p of by.values()) p.branches.sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId) || a.id - b.id);
  return [...by.values()];
}

function NewProject({ servers, notify, onClose, onCreated }: { servers: ServerInfo[]; notify: (t: string, e?: boolean) => void; onClose: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState("");
  const [generated, setGenerated] = useState(naturalDbName); // Neon-style: young_art_a7k2
  const [custom, setCustom] = useState<string | null>(null); // the database name, once someone edits it
  const [withDev, setWithDev] = useState(true);
  const [serverId, setServerId] = useState(servers[0]?.id ?? 0);
  const [check, setCheck] = useState<{ db: string; ok: boolean; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const dbName = custom ?? generated;
  const problem = dbName ? dbNameProblem(dbName) : null;

  // is it free on the server? (only once a server exists: the first one is added on create)
  useEffect(() => {
    if (!dbName || problem || !serverId) { setCheck(null); return; }
    const t = setTimeout(() => {
      api<{ ok: boolean; reason: string | null }>(`/api/servers/${serverId}/name?db=${encodeURIComponent(dbName)}`, { source: null })
        .then((r) => setCheck({ db: dbName, ...r })).catch(() => setCheck(null));
    }, 300);
    return () => clearTimeout(t);
  }, [dbName, problem, serverId]);
  const status = !dbName ? null : problem ? problem : check?.db === dbName && !check.ok ? check.reason : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ source: { id: number } }>("/api/sources", { body: { kind: "hosted", name, dbName, serverId: serverId || null, withDevelopment: withDev }, source: null });
      notify(`${name.trim()} is ready${withDev ? ", with a development branch" : ""}.`); onCreated(r.source.id);
    } catch (err) { notify((err as Error).message, true); setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <h2 className="schema-h m-0">New project</h2>
        <label className="field">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ComicAI" maxLength={80} required /></label>
        {custom === null ? (
          <p className="use-note m-0 row gap-2">Production database <span className="mono">{dbName}</span>
            <button type="button" className="btn ghost sm" title="Another random name" aria-label="Shuffle" onClick={() => setGenerated(naturalDbName())}>↻</button>
            <button type="button" className="btn ghost sm" onClick={() => setCustom(dbName)}>Edit</button></p>
        ) : (
          <label className="field">Production database name<input className="input mono" value={custom} onChange={(e) => setCustom(e.target.value.toLowerCase())} maxLength={DB_NAME_MAX} spellCheck={false} aria-invalid={!!status} /></label>
        )}
        {status ? <p className="small text-warn m-0">{status}</p> : dbName && <p className="use-note m-0">Logins <span className="mono">{dbName}_owner</span> for your app and <span className="mono">{dbName}_crema</span> (read-only) for Crema. The database name can’t change later; the project name can.</p>}
        <label className="row gap-2 small"><input type="checkbox" checked={withDev} onChange={(e) => setWithDev(e.target.checked)} /> Also create a development branch <span className="faint">(starts empty, like production)</span></label>
        {servers.length > 1 && <label className="field">Server<select className="select" value={serverId} onChange={(e) => setServerId(Number(e.target.value))}>
          {servers.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.publicHost}</option>)}
        </select></label>}
        <div className="row"><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !name.trim() || !dbName || !!status}>{busy ? <span className="spin" /> : "Create project"}</button></div>
      </form>
    </Modal>
  );
}

/** Add a Postgres server: an admin login, and the address apps will use. */
function AddServer({ notify, onClose, onAdded }: { notify: (t: string, e?: boolean) => void; onClose: () => void; onAdded: (id: number) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [publicHost, setPublicHost] = useState("");
  const [sslChoice, setSslChoice] = useState<boolean | null>(null); // null: follow the address
  const host = (publicHost.trim() || url).replace(/^[a-z]+:\/\/([^@/]*@)?/i, "").split(/[:/?]/)[0];
  const ssl = sslChoice ?? !/^(localhost|127\.0\.0\.1|::1|)$/.test(host); // TLS unless it's this machine
  const [busy, setBusy] = useState(false);
  const done = (r: { server: { id: number; name: string }; createdProvisioner: string | null }) => {
    notify(r.createdProvisioner ? `${r.server.name} added. Crema created its own login ${r.createdProvisioner}; the superuser password wasn’t kept.` : `${r.server.name} added.`);
    onAdded(r.server.id);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { done(await api("/api/servers", { body: { url, name, publicHost, ssl }, source: null })); }
    catch (err) { notify((err as Error).message, true); setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <h2 className="schema-h m-0">Add a hosting server</h2>
        <p className="use-note m-0">New databases need a Postgres server to live on (PostgreSQL 16 or newer). Use one of its own, not the one that holds Crema’s data.</p>
        <label className="field">Admin connection string<input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="postgresql://postgres:…@db.example.com:5432/postgres" required /></label>
        <p className="use-note m-0">A superuser is used once, to create Crema’s own login with only CREATEDB and CREATEROLE; its password isn’t kept. Or give such a login yourself.</p>
        <div className="row gap-3">
          <label className="field grow">Address apps use<input className="input mono" value={publicHost} onChange={(e) => setPublicHost(e.target.value)} placeholder="same as above" /></label>
          <label className="field grow">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="the host" maxLength={60} /></label>
        </div>
        <label className="row gap-2 small"><input type="checkbox" checked={ssl} onChange={(e) => setSslChoice(e.target.checked)} /> Apps must connect over TLS (sslmode=require)</label>
        <div className="row"><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !url.trim()}>{busy ? <span className="spin" /> : "Add server"}</button></div>
      </form>
    </Modal>
  );
}

function ServerDetail({ server, notify, onChanged }: { server: ServerInfo; notify: (t: string, e?: boolean) => void; onChanged: () => void }) {
  const [check, setCheck] = useState<{ ok: boolean; reason: string | null; version: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/api/servers/${server.id}/check`, { source: null }).then(setCheck).catch((e) => setCheck({ ok: false, reason: (e as Error).message, version: null })); }, [server.id]);
  const [ask, confirmDialog] = useConfirm();
  const remove = async () => {
    if (!(await ask({ title: `Remove ${server.name}?`, body: "Only possible once it holds no databases. Nothing on the server itself is deleted.", confirmLabel: "Remove server", danger: true })).ok) return;
    setBusy(true);
    try {
      const r = await api<{ provisioner: string }>(`/api/servers/${server.id}/delete`, { body: {}, source: null });
      notify(`Removed ${server.name}. Its login ${r.provisioner} is still on the server; drop it there if you no longer need it.`);
      onChanged();
    } catch (e) { notify((e as Error).message, true); setBusy(false); }
  };
  return (
    <div className="hosted-detail">
      <div className="eyebrow">Server · where new projects are created</div>
      <h1 className="title">{server.name}</h1>
      {check && !check.ok && <div className="callout warn small">{check.reason}</div>}
      <div className="hosted-stats">
        <div><span>Apps connect to</span><b className="mono">{server.publicHost}</b><small>{server.ssl ? "TLS required" : "TLS optional"}</small></div>
        <div><span>PostgreSQL</span><b>{check?.version ?? server.version}</b><small>{!check ? "checking…" : check.ok ? "reachable" : "needs attention"}</small></div>
        <div><span>Databases</span><b>{server.databases}</b></div>
        <div><span>Added</span><b>{ago(server.createdAt)}</b><small>by {server.createdBy}</small></div>
      </div>
      <section className="hosted-card">
        <div className="hosted-card-head"><h2>Crema’s login</h2></div>
        <p className="m-0 muted">Crema manages this server as <span className="mono">{server.provisioner}</span>: it can create databases and roles, and change only the ones it created. It isn’t a superuser and can’t touch other databases here.</p>
      </section>
      <section className="hosted-card danger">
        <div className="hosted-card-head"><h2>Danger zone</h2></div>
        <div className="row"><div className="grow"><b>Remove server</b><div className="small muted">Forgets the server. Delete its databases first; nothing on the server itself is deleted.</div></div><button className="btn text-fail" disabled={busy || server.databases > 0} onClick={remove}>Remove</button></div>
      </section>
      {confirmDialog}
    </div>
  );
}

function ProjectView({ db, all, server, admin, notify, onChanged }: { db: SourceInfo; all: SourceInfo[]; server: ServerInfo | null; admin: boolean; notify: (t: string, e?: boolean) => void; onChanged: (id?: number) => void }) {
  const [role, setRole] = useState<Role>("owner");
  const [format, setFormat] = useState("url");
  const [reveal, setReveal] = useState(false);
  const [conn, setConn] = useState<Conn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [branching, setBranching] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const hosted = db.kind === "hosted";
  const siblings = all.filter((d) => d.projectId === db.projectId).sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId) || a.id - b.id);
  const main = siblings.find((d) => !d.parentId) ?? db;
  const parent = db.parentId ? all.find((d) => d.id === db.parentId) ?? null : null;
  const children = all.filter((d) => d.parentId === db.id);
  // a branch being copied (by the worker) finishes on its own: look again until it does
  const copying = siblings.some((b) => b.status === "provisioning");
  useEffect(() => {
    if (!copying) return;
    const t = setInterval(() => onChanged(db.id), 3000);
    return () => clearInterval(t);
  }, [copying, db.id, onChanged]);
  const ready = db.status === "ready" && !db.missing;
  const prod = db.environment === "production";

  const fetchConn = useCallback(async () => {
    if (!hosted || !ready || !admin) return;
    setConn(null); setError(null);
    try { setConn(await api<Conn>(`/api/sources/${db.id}/connection?role=${role}`, { source: null })); } catch (e) { setError((e as Error).message); }
  }, [db.id, role, hosted, ready, admin]);
  useEffect(() => { fetchConn(); }, [fetchConn]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { notify((e as Error).message, true); } finally { setBusy(null); }
  };
  const [ask, confirmDialog] = useConfirm();
  const where = prod ? "production" : db.branch;
  const reset = async () => {
    const who = role === "owner" ? "app" : "Crema read-only";
    if (!(await ask({ title: `New password for the ${who} login of ${where}?`, body: <>Login <span className="mono">{db.dbName}_{role === "owner" ? "owner" : "crema"}</span>. Anything using the old password loses access now.</>, confirmLabel: "Issue new password", danger: true })).ok) return;
    act("reset", async () => { setConn(await api<Conn>(`/api/sources/${db.id}/reset-password`, { body: { role }, source: null })); setReveal(true); notify("New password issued."); });
  };
  const resetBranch = async () => {
    if (!(await ask({ title: `Reset ${db.branch} from ${parent?.branch}?`, body: `Everything changed in ${db.branch} is lost, and ${parent?.branch} is copied again. Its logins stay the same. ${parent?.branch === "production" ? "Production itself isn’t touched." : ""}`, type: db.branch, confirmLabel: "Reset branch", danger: true })).ok) return;
    act("resetb", async () => { await api(`/api/sources/${db.id}/reset`, { body: {}, source: null }); notify(`Copying ${parent?.branch} into ${db.branch}…`); onChanged(db.id); });
  };
  const retry = () => act("retry", async () => { await api(`/api/sources/${db.id}/retry`, { body: {}, source: null }); notify(`${db.dbName} is ready.`); onChanged(db.id); });
  const setEnv = (environment: string) => act("env", async () => { await api(`/api/sources/${db.id}/environment`, { body: { environment: environment || null }, source: null }); onChanged(db.id); });
  const remove = async () => {
    const name = hosted ? db.dbName! : db.slug;
    const last = siblings.length === 1;
    const ok = (await ask(hosted
      ? { title: parent ? `Delete the ${db.branch} branch?` : `Delete ${last ? `the project ${db.projectName}` : "production"}?`, body: <>{prod ? <b>This is the production database. </b> : null}Drops <span className="mono">{name}</span> with all its data and both logins. This can’t be undone.</>, type: name, confirmLabel: parent ? "Delete branch" : last ? "Delete project" : "Delete production", danger: true }
      : { title: `Remove ${db.name} from Crema?`, body: "Its certified metrics stop being served. The database itself isn't touched.", type: name, confirmLabel: "Remove", danger: true })).ok;
    if (!ok) return;
    act("delete", async () => { await api(`/api/sources/${db.id}/delete`, { body: {}, source: null }); notify(hosted ? `Deleted ${name}.` : `Removed ${db.name}.`); onChanged(siblings.find((x) => x.id !== db.id)?.id); });
  };

  const header = (
    <>
      <div className="eyebrow">{hosted ? "Hosted project" : "Connected database"}</div>
      <div className="project-head"><h1 className="title">{db.projectName}</h1>{admin && <button className="btn ghost sm" onClick={() => setRenaming(true)} title="Rename the project (database names never change)">Rename</button>}</div>
      <nav className="branch-tabs" aria-label="Branches">
        {siblings.map((d) => <a key={d.id} href={`#databases/${encodeURIComponent(d.slug)}`} className={d.id === db.id ? "on" : ""} aria-current={d.id === db.id ? "page" : undefined}>{d.branch}<EnvBadge environment={d.environment} /></a>)}
        {admin && hosted && main.status === "ready" && <button type="button" onClick={() => setBranching(true)}>+ Branch</button>}
      </nav>
      {ready && <nav className="section-links" aria-label="Section">
        <a href={`#databases/${encodeURIComponent(db.slug)}`} className="on" aria-current="page">Connect</a>
        <a href={sourceHref(db.slug, "tables")}>Tables</a>
        <a href={sourceHref(db.slug, "sql")}>SQL editor</a>
        <a href={sourceHref(db.slug, "schema")}>Schema</a>
        <a href={sourceHref(db.slug)}>Metrics</a>
      </nav>}
    </>
  );
  const modals = (
    <>
      {confirmDialog}
      {renaming && <RenameProject db={db} notify={notify} onClose={() => setRenaming(false)} onDone={() => { setRenaming(false); onChanged(db.id); }} />}
      {branching && <NewBranch main={main} taken={siblings.map((b) => b.branch)} notify={notify} onClose={() => setBranching(false)} onCreated={(id) => { setBranching(false); onChanged(id); }} />}
    </>
  );
  const cremaNote = db.environment === "development"
    ? "Crema doesn’t analyse development on its own (no automatic discovery or drift checks) and consumers read production by default. Open it to look around or analyse on demand."
    : `Crema analyses it with the read-only login${db.metrics ? `: ${db.metrics} certified metric${db.metrics > 1 ? "s" : ""}` : ""}.`;

  if (!hosted) return (
    <div className="hosted-detail">
      {header}
      <div className="hosted-stats">
        <div><span>In Crema</span><b className="mono">{db.slug}</b></div>
        <div><span>Metrics</span><b>{db.metrics}{db.attention ? ` · ${db.attention} need attention` : ""}</b></div>
        <div><span>Login</span><b>{db.readOnly ? "read-only" : `can write (${db.writableTables} tables)`}</b></div>
        <div><span>Added</span><b>{ago(db.createdAt)}</b><small>by {db.createdBy}</small></div>
      </div>
      <section className="hosted-card">
        <div className="hosted-card-head"><h2>Environment</h2><span className="grow" />
          {admin ? <select className="select sm" value={db.environment ?? ""} disabled={busy === "env"} onChange={(e) => setEnv(e.target.value)} aria-label="Environment">
            <option value="">Not set</option><option value="production">Production</option><option value="staging">Staging</option><option value="development">Development</option>
          </select> : <EnvBadge environment={db.environment} />}
        </div>
        <p className="m-0 muted">A label for people; Crema reads it the same way whatever you choose. Development isn’t checked on a schedule and isn’t offered to consumers by default.</p>
      </section>
      <section className="hosted-card">
        <div className="row"><p className="m-0 grow muted">Crema reads it in read-only transactions with the connection string you gave; it’s stored encrypted.</p><a className="btn primary" href={sourceHref(db.slug)}>Open</a></div>
      </section>
      {admin && <section className="hosted-card danger">
        <div className="hosted-card-head"><h2>Danger zone</h2></div>
        <div className="row"><div className="grow"><b>Remove from Crema</b><div className="small muted">Forgets the connection. Its metrics stop being served; history stays in the audit log. The database isn’t touched.</div></div><button className="btn text-fail" disabled={busy === "delete"} onClick={remove}>Remove</button></div>
      </section>}
      {modals}
    </div>
  );

  const fmt = FORMATS.find((f) => f.id === format)!;
  const actual = conn ? fmt.render(conn.connectionString) : "";
  const shown = conn ? (reveal ? actual : actual.split(conn.password).join(MASK)) : "";

  return (
    <div className="hosted-detail">
      {header}
      {db.status === "provisioning" && <div className="callout small row"><span className="grow">{parent ? `Copying ${db.branchCopy === "schema" ? "the schema" : "schema and data"} from ${parent.branch}… this takes as long as the copy does.` : "Being created…"}</span>{admin && Date.now() - Date.parse(db.createdAt) > 120_000 && <button className="btn sm" disabled={busy === "retry"} onClick={retry}>Taking long? Retry</button>}</div>}
      {db.status === "failed" && <div className="callout warn small row"><span className="grow">{parent ? "Copying it failed" : "Creating it failed"}: {db.error}</span>{admin && <button className="btn sm" disabled={busy === "retry"} onClick={retry}>Retry</button>}</div>}
      <div className="hosted-stats">
        <div><span>Database</span><b className="mono">{db.dbName}</b><small>on {server?.name ?? "a removed server"}</small></div>
        <div><span>Size</span><b>{size(db.sizeBytes)}</b></div>
        <div><span>Connections</span><b>{db.connections ?? "—"}</b></div>
        <div><span>Created</span><b>{ago(db.createdAt)}</b><small>by {db.createdBy}</small></div>
      </div>
      {db.missing && <div className="callout warn small">This database no longer exists on {server?.name ?? "its server"}.</div>}

      {ready && admin && <section className="hosted-card">
        <div className="hosted-card-head">
          <h2>Connection details</h2>
          <span className="grow" />
          <select className="select sm" value={role} onChange={(e) => { setRole(e.target.value as Role); setReveal(false); }} aria-label="Login">
            <option value="owner">{db.dbName}_owner · app (read/write)</option>
            <option value="reader">{db.dbName}_crema · read-only</option>
          </select>
        </div>
        <div className="round-pills hosted-formats" role="tablist">
          {FORMATS.map((f) => <button key={f.id} role="tab" aria-selected={format === f.id} className={format === f.id ? "on" : ""} onClick={() => setFormat(f.id)}>{f.label}</button>)}
        </div>
        {error ? <p className="small text-warn m-0">{error}</p> : !conn ? <span className="spin" /> : (
          <>
            <pre className="code conn-code">{shown}<Copy text={actual} /></pre>
            <div className="row conn-meta">
              <label className="row gap-2 small"><input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Show password</label>
              <span className="grow" />
              <span className="faint small mono">{conn.host}:{conn.port}{conn.ssl ? " · sslmode=require" : ""}</span>
            </div>
          </>
        )}
        {conn?.ssl && (format === "url" || format === "env") && <p className="use-note m-0">Node.js (pg, Drizzle): add <span className="mono">&amp;uselibpqcompat=true</span>, as in the Node.js tab. The server’s certificate is self-signed: the connection is encrypted, not verified.</p>}
        {role === "reader" && <p className="use-note m-0">Read-only: this login can’t change anything, including tables your app creates later.</p>}
      </section>}

      {parent && <section className="hosted-card">
        <div className="hosted-card-head"><h2>Copied from {parent.branch}</h2></div>
        <p className="m-0 muted">{db.branchCopy === "schema" ? "Schema only" : "Schema and data"}{db.branchedAt ? `, ${ago(db.branchedAt)}` : ""}. Changes here never reach {parent.branch}. Point your app’s {db.environment === "staging" ? "staging" : "development"} setup at this branch, and turn off what reaches real people there (messages, webhooks, payments, scheduled jobs): a separate database doesn’t stop the app from contacting real customers.</p>
        {admin && <div className="row"><div className="grow"><b>Reset from {parent.branch}</b><div className="small muted">Throws away everything in this branch and copies {parent.branch} again. Its logins stay the same.</div></div><button className="btn" disabled={busy === "resetb" || db.status === "provisioning"} onClick={resetBranch}>Reset</button></div>}
      </section>}

      {ready && <section className="hosted-card">
        <div className="hosted-card-head"><h2>Crema</h2></div>
        <div className="row"><p className="m-0 grow muted">{cremaNote}</p><a className="btn primary" href={sourceHref(db.slug)}>Open</a></div>
      </section>}

      {admin && <section className="hosted-card danger">
        <div className="hosted-card-head"><h2>Danger zone</h2></div>
        {ready && <div className="row"><div className="grow"><b>Reset password</b><div className="small muted">Issues a new password for the selected login. The old one stops working at once.</div></div><button className="btn" disabled={busy === "reset"} onClick={reset}>Reset password</button></div>}
        <div className="row"><div className="grow"><b>{parent ? "Delete branch" : siblings.length === 1 ? "Delete project" : "Delete production"}</b><div className="small muted">{children.length || siblings.length > 1 && !parent ? `Delete its branches first (${siblings.filter((b) => b.parentId).map((b) => b.branch).join(", ")}).` : "Drops the database, its data and both logins. Its metrics stop being served."}</div></div><button className="btn text-fail" disabled={busy === "delete" || (!parent && siblings.length > 1)} onClick={remove}>Delete</button></div>
      </section>}
      {modals}
    </div>
  );
}

function RenameProject({ db, notify, onClose, onDone }: { db: SourceInfo; notify: (t: string, e?: boolean) => void; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(db.projectName);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await api(`/api/sources/${db.id}/rename`, { body: { name }, source: null }); notify("Renamed."); onDone(); }
    catch (err) { notify((err as Error).message, true); setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <h2 className="schema-h m-0">Rename project</h2>
        <label className="field">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></label>
        <p className="use-note m-0">Only what people see changes. Database names, logins and connection strings stay exactly as they are.</p>
        <div className="row"><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !name.trim() || name.trim() === db.projectName}>{busy ? <span className="spin" /> : "Rename"}</button></div>
      </form>
    </Modal>
  );
}

function NewBranch({ main, taken, notify, onClose, onCreated }: { main: SourceInfo; taken: string[]; notify: (t: string, e?: boolean) => void; onClose: () => void; onCreated: (id: number) => void }) {
  const [environment, setEnvironment] = useState<"development" | "staging">("development");
  const [branch, setBranch] = useState(taken.includes("development") ? "" : "development");
  const [copy, setCopy] = useState<"data" | "schema">("schema");
  const [busy, setBusy] = useState(false);
  const pick = (e: "development" | "staging") => { if (!branch || branch === environment) setBranch(taken.includes(e) ? "" : e); setEnvironment(e); };
  const problem = !branch ? null : !/^[a-z][a-z0-9_]{0,15}$/.test(branch) || branch === "main" || branch === "production" ? "A short word: lowercase letters, digits, underscores (not “production”)." : taken.includes(branch) ? `There is already a “${branch}” branch.` : null;
  const dbName = branch ? `${main.dbName!.slice(0, DB_NAME_MAX - 1 - branch.length).replace(/_+$/, "")}_${branch}` : "";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { const r = await api<{ id: number }>(`/api/sources/${main.id}/branch`, { body: { branch, environment, copy }, source: null }); notify(`Copying production into ${branch}…`); onCreated(r.id); }
    catch (err) { notify((err as Error).message, true); setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <h2 className="schema-h m-0">New branch of {main.projectName}</h2>
        <div className="round-pills" role="tablist" aria-label="Environment">
          <button type="button" role="tab" aria-selected={environment === "development"} className={environment === "development" ? "on" : ""} onClick={() => pick("development")}>Development</button>
          <button type="button" role="tab" aria-selected={environment === "staging"} className={environment === "staging" ? "on" : ""} onClick={() => pick("staging")}>Staging</button>
        </div>
        <label className="field">Branch name<input className="input mono" autoFocus value={branch} onChange={(e) => setBranch(e.target.value.toLowerCase())} maxLength={16} spellCheck={false} /></label>
        {problem ? <p className="small text-warn m-0">{problem}</p> : branch && <p className="use-note m-0">Database <span className="mono">{dbName}</span>, logins <span className="mono">{dbName}_owner</span> and <span className="mono">{dbName}_crema</span>.</p>}
        <div className="round-pills" role="tablist" aria-label="What to copy">
          <button type="button" role="tab" aria-selected={copy === "schema"} className={copy === "schema" ? "on" : ""} onClick={() => setCopy("schema")}>Schema only</button>
          <button type="button" role="tab" aria-selected={copy === "data"} className={copy === "data" ? "on" : ""} onClick={() => setCopy("data")}>Schema + data</button>
        </div>
        <p className="use-note m-0">{copy === "data" ? `A consistent snapshot of production as it is when the copy starts; production keeps serving meanwhile. It's a real copy: it takes time and disk in proportion to production's size, and it puts customer data in ${environment}.` : "The tables, views and functions of production, without its rows: quick, and no customer data in development."}</p>
        <div className="row"><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !branch || !!problem}>{busy ? <span className="spin" /> : "Create branch"}</button></div>
      </form>
    </Modal>
  );
}
