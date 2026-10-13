"use client";
import { useCallback, useEffect, useState } from "react";
import { ago, api, sourceHref, type AppState, type ServerInfo, type SourceInfo } from "@/lib/client";
import { Copy, Modal } from "./ui";

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
 * Every database in the workspace, Neon-style: the ones you connected and the ones Crema created
 * for your apps, plus the Postgres servers it creates them on. Pick one to see how to connect,
 * open it in Crema, or manage it.
 */
export function Databases({ state, selected, server, notify, reload }: { state: AppState; selected: number | null; server: number | null; notify: (t: string, e?: boolean) => void; reload: () => void }) {
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const admin = state.me?.role === "admin";
  const list = state.sources;
  const servers = state.servers;
  const srv = server ? servers.find((v) => v.id === server) ?? null : null;
  const db = srv ? null : list.find((d) => d.id === selected) ?? list[0] ?? null;
  const go = (id: number) => { window.location.hash = `databases/${id}`; };
  const goServer = (id: number) => { window.location.hash = `databases/server-${id}`; };
  const changed = async (id?: number) => { await reload(); if (id) go(id); else window.location.hash = "databases"; };
  // Creating needs a server: the installation's own one is used without asking; only without one
  // does the admin add a server first
  const create = () => (servers.length || state.suggestedServer ? setCreating(true) : setAdding(true));

  return (
    <div className="hostedpage">
      <aside className="sql-side">
        {admin && <div className="row gap-2">
          <button className="btn primary sm grow" onClick={create}>+ New database</button>
          <a className="btn sm grow" href="/#connect">Connect existing</a>
        </div>}
        <h4>{list.length} database{list.length === 1 ? "" : "s"}</h4>
        <ul className="sql-list">
          {list.map((d) => (
            <li key={d.id} className={`saved ${d.id === db?.id ? "on" : ""}`}>
              <button className="sql-item" onClick={() => go(d.id)}>
                <span className="ellipsis">{d.name}</span>
                <span className="faint">{d.kind === "hosted" ? `hosted · ${size(d.sizeBytes)}` : "connected"}{d.status !== "ready" ? ` · ${d.status}` : ""}{d.metrics ? ` · ${d.metrics} metric${d.metrics > 1 ? "s" : ""}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
        {admin && <>
          <div className="row side-head"><h4 className="grow">Hosting servers</h4><button className="btn ghost sm" onClick={() => setAdding(true)}>+ Add</button></div>
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
        </>}
      </aside>

      <main className="hosted-main">
        {srv ? <ServerDetail key={srv.id} server={srv} notify={notify} onChanged={() => changed()} />
          : db ? <Detail key={db.id} db={db} server={servers.find((v) => v.id === db.serverId) ?? null} admin={admin} notify={notify} onChanged={changed} /> : (
          <div className="hosted-empty">
            <h1 className="title">Your databases</h1>
            <p className="meaning">Connect a database you already have, or create a new one for an app — and let Crema find and certify its metrics.</p>
            <div className="row gap-3"><a className="btn primary lg" href="/#connect">Connect a database</a>{admin && <button className="btn lg" onClick={create}>Create a new one</button>}</div>
          </div>
        )}
      </main>

      {creating && <NewDatabase servers={servers} notify={notify} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); changed(id); }} />}
      {adding && <AddServer notify={notify} onClose={() => setAdding(false)} onAdded={async (id) => { setAdding(false); await reload(); goServer(id); }} />}
    </div>
  );
}

function NewDatabase({ servers, notify, onClose, onCreated }: { servers: ServerInfo[]; notify: (t: string, e?: boolean) => void; onClose: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState(servers[0]?.id ?? 0);
  const [busy, setBusy] = useState(false);
  const slug = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { const r = await api<{ source: { id: number; dbName: string } }>("/api/sources", { body: { kind: "hosted", name, serverId }, source: null }); notify(`${r.source.dbName} is ready.`); onCreated(r.source.id); }
    catch (err) { notify((err as Error).message, true); setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <h2 className="schema-h m-0">New database</h2>
        <label className="field">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Booking app" maxLength={60} required /></label>
        {servers.length > 1 && <label className="field">Server<select className="select" value={serverId} onChange={(e) => setServerId(Number(e.target.value))}>
          {servers.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.publicHost}</option>)}
        </select></label>}
        <p className="use-note m-0">Database <span className="mono">{slug ? `app_${slug}` : "app_…"}</span>, login <span className="mono">{slug ? `app_${slug}_owner` : "…_owner"}</span> for your app, and a read-only login for Crema.</p>
        <div className="row"><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !slug}>{busy ? <span className="spin" /> : "Create"}</button></div>
      </form>
    </Modal>
  );
}

/** Add a Postgres server: an admin login, and the address apps will use. */
function AddServer({ notify, onClose, onAdded }: { notify: (t: string, e?: boolean) => void; onClose: () => void; onAdded: (id: number) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [publicHost, setPublicHost] = useState("");
  const [ssl, setSsl] = useState(true);
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
        <label className="row gap-2 small"><input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} /> Apps must connect over TLS (sslmode=require)</label>
        <div className="row"><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !url.trim()}>{busy ? <span className="spin" /> : "Add server"}</button></div>
      </form>
    </Modal>
  );
}

function ServerDetail({ server, notify, onChanged }: { server: ServerInfo; notify: (t: string, e?: boolean) => void; onChanged: () => void }) {
  const [check, setCheck] = useState<{ ok: boolean; reason: string | null; version: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/api/servers/${server.id}/check`, { source: null }).then(setCheck).catch((e) => setCheck({ ok: false, reason: (e as Error).message, version: null })); }, [server.id]);
  const remove = async () => {
    if (!window.confirm(`Remove ${server.name} from Crema? Only possible once it holds no databases. Nothing on the server is deleted.`)) return;
    setBusy(true);
    try {
      const r = await api<{ provisioner: string }>(`/api/servers/${server.id}/delete`, { body: {}, source: null });
      notify(`Removed ${server.name}. Its login ${r.provisioner} is still on the server; drop it there if you no longer need it.`);
      onChanged();
    } catch (e) { notify((e as Error).message, true); setBusy(false); }
  };
  return (
    <div className="hosted-detail">
      <div className="eyebrow">Postgres server</div>
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
    </div>
  );
}

function Detail({ db, server, admin, notify, onChanged }: { db: SourceInfo; server: ServerInfo | null; admin: boolean; notify: (t: string, e?: boolean) => void; onChanged: (id?: number) => void }) {
  const [role, setRole] = useState<Role>("owner");
  const [format, setFormat] = useState("url");
  const [reveal, setReveal] = useState(false);
  const [conn, setConn] = useState<Conn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const hosted = db.kind === "hosted";
  const ready = db.status === "ready" && !db.missing;

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
  const reset = () => {
    if (!window.confirm(`New password for the ${role === "owner" ? "app" : "Crema read-only"} login of ${db.dbName}? Anything using the old one loses access now.`)) return;
    act("reset", async () => { setConn(await api<Conn>(`/api/sources/${db.id}/reset-password`, { body: { role }, source: null })); setReveal(true); notify("New password issued."); });
  };
  const retry = () => act("retry", async () => { await api(`/api/sources/${db.id}/retry`, { body: {}, source: null }); notify(`${db.dbName} is ready.`); onChanged(db.id); });
  const remove = () => {
    const name = hosted ? db.dbName! : db.slug;
    const typed = window.prompt(hosted
      ? `Delete ${name} and all its data? This can't be undone. Type the database name to confirm:`
      : `Remove ${db.name} from Crema? Its certified metrics stop being served; the database itself isn't touched. Type “${name}” to confirm:`);
    if (typed !== name) { if (typed !== null) notify("The name didn't match; nothing was removed.", true); return; }
    act("delete", async () => { await api(`/api/sources/${db.id}/delete`, { body: {}, source: null }); notify(hosted ? `Deleted ${name}.` : `Removed ${db.name}.`); onChanged(); });
  };

  if (!hosted) return (
    <div className="hosted-detail">
      <div className="eyebrow">Connected database</div>
      <h1 className="title">{db.name}</h1>
      <div className="hosted-stats">
        <div><span>In Crema</span><b className="mono">{db.slug}</b></div>
        <div><span>Metrics</span><b>{db.metrics}{db.attention ? ` · ${db.attention} need attention` : ""}</b></div>
        <div><span>Login</span><b>{db.readOnly ? "read-only" : `can write (${db.writableTables} tables)`}</b></div>
        <div><span>Added</span><b>{ago(db.createdAt)}</b><small>by {db.createdBy}</small></div>
      </div>
      <section className="hosted-card">
        <div className="row"><p className="m-0 grow muted">Crema reads it in read-only transactions with the connection string you gave; it’s stored encrypted.</p><a className="btn primary" href={sourceHref(db.slug)}>Open</a></div>
      </section>
      {admin && <section className="hosted-card danger">
        <div className="hosted-card-head"><h2>Danger zone</h2></div>
        <div className="row"><div className="grow"><b>Remove from Crema</b><div className="small muted">Forgets the connection. Its metrics stop being served; history stays in the audit log. The database isn’t touched.</div></div><button className="btn text-fail" disabled={busy === "delete"} onClick={remove}>Remove</button></div>
      </section>}
    </div>
  );

  const fmt = FORMATS.find((f) => f.id === format)!;
  const actual = conn ? fmt.render(conn.connectionString) : "";
  const shown = conn ? (reveal ? actual : actual.split(conn.password).join(MASK)) : "";

  return (
    <div className="hosted-detail">
      <div className="eyebrow">Hosted database</div>
      <h1 className="title">{db.name}</h1>
      {db.status === "provisioning" && <div className="callout small row"><span className="grow">Being created…</span>{admin && Date.now() - Date.parse(db.createdAt) > 120_000 && <button className="btn sm" disabled={busy === "retry"} onClick={retry}>Taking long? Retry</button>}</div>}
      {db.status === "failed" && <div className="callout warn small row"><span className="grow">Creating it failed: {db.error}</span>{admin && <button className="btn sm" disabled={busy === "retry"} onClick={retry}>Retry</button>}</div>}
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

      {ready && <section className="hosted-card">
        <div className="hosted-card-head"><h2>Crema</h2></div>
        <div className="row"><p className="m-0 grow muted">Crema analyses it with the read-only login{db.metrics ? `: ${db.metrics} certified metric${db.metrics > 1 ? "s" : ""}` : ""}.</p><a className="btn primary" href={sourceHref(db.slug)}>Open</a></div>
      </section>}

      {admin && <section className="hosted-card danger">
        <div className="hosted-card-head"><h2>Danger zone</h2></div>
        {ready && <div className="row"><div className="grow"><b>Reset password</b><div className="small muted">Issues a new password for the selected login. The old one stops working at once.</div></div><button className="btn" disabled={busy === "reset"} onClick={reset}>Reset password</button></div>}
        <div className="row"><div className="grow"><b>Delete database</b><div className="small muted">Drops the database, its data and both logins. Its metrics stop being served.</div></div><button className="btn text-fail" disabled={busy === "delete"} onClick={remove}>Delete</button></div>
      </section>}
    </div>
  );
}
