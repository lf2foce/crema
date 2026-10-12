"use client";
import { useCallback, useEffect, useState } from "react";
import { ago, api, sourceHref, type AppState, type SourceInfo } from "@/lib/client";
import { Copy, Modal } from "./ui";

type Conn = { host: string; port: number; database: string; user: string; password: string; ssl: boolean; connectionString: string };
type Role = "owner" | "reader";

const size = (b: number | null) => (b == null ? "—" : b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} kB` : b < 1e9 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e9).toFixed(2)} GB`);
const MASK = "••••••••••••";

const FORMATS: { id: string; label: string; render: (url: string) => string }[] = [
  { id: "url", label: "Connection string", render: (u) => u },
  { id: "env", label: ".env", render: (u) => `DATABASE_URL="${u}"` },
  { id: "psql", label: "psql", render: (u) => `psql "${u}"` },
  { id: "node", label: "Node.js", render: (u) => `import pg from "pg";\n\n// DATABASE_URL="${u}"\nconst pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });` },
  { id: "drizzle", label: "Drizzle", render: (u) => `// .env\nDATABASE_URL="${u}"\n\n// db.ts\nimport { drizzle } from "drizzle-orm/node-postgres";\nexport const db = drizzle(process.env.DATABASE_URL!);\n\n// drizzle.config.ts\nimport { defineConfig } from "drizzle-kit";\nexport default defineConfig({ dialect: "postgresql", schema: "./src/schema.ts", dbCredentials: { url: process.env.DATABASE_URL! } });` },
  { id: "python", label: "Python", render: (u) => `import psycopg\n\n# DATABASE_URL="${u}"\nconn = psycopg.connect(os.environ["DATABASE_URL"])` },
];

/**
 * Every database in the workspace, Neon-style: the ones you connected and the ones Creama created
 * for your apps. Pick one to see how to connect, open it in Creama, or manage it.
 */
export function Databases({ state, selected, notify, reload }: { state: AppState; selected: number | null; notify: (t: string, e?: boolean) => void; reload: () => void }) {
  const [creating, setCreating] = useState(false);
  const admin = state.me?.role === "admin";
  const list = state.sources;
  const db = list.find((d) => d.id === selected) ?? list[0] ?? null;
  const go = (id: number) => { window.location.hash = `databases/${id}`; };
  const changed = async (id?: number) => { await reload(); if (id) go(id); else window.location.hash = "databases"; };

  return (
    <div className="hostedpage">
      <aside className="sql-side">
        {admin && <div className="row gap-2">
          {state.hosting.enabled && <button className="btn primary sm grow" onClick={() => setCreating(true)}>+ New database</button>}
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
        {state.hosting.enabled && <p className="use-note hosted-where">Hosted databases: apps connect to <span className="mono">{state.hosting.address}</span>{state.hosting.ssl ? " over TLS" : ""}.</p>}
      </aside>

      <main className="hosted-main">
        {state.hosting.enabled && state.hosting.shared && (
          <div className="hosted-banner">Hosted databases are created on the Postgres server that holds Creama’s own data. Fine for development; in production set <span className="mono">CREAMA_HOSTING_ADMIN_URL</span> to a separate cluster.</div>
        )}
        {db ? <Detail key={db.id} db={db} admin={admin} notify={notify} onChanged={changed} /> : (
          <div className="hosted-empty">
            <h1 className="title">Your databases</h1>
            <p className="meaning">Connect a database you already have, or create a new one for an app — and let Creama find and certify its metrics.</p>
            <div className="row gap-3"><a className="btn primary lg" href="/#connect">Connect a database</a>{state.hosting.enabled && admin && <button className="btn lg" onClick={() => setCreating(true)}>Create a new one</button>}</div>
          </div>
        )}
      </main>

      {creating && <NewDatabase notify={notify} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); changed(id); }} />}
    </div>
  );
}

function NewDatabase({ notify, onClose, onCreated }: { notify: (t: string, e?: boolean) => void; onClose: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const slug = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { const r = await api<{ source: { id: number; dbName: string } }>("/api/sources", { body: { kind: "hosted", name }, source: null }); notify(`${r.source.dbName} is ready.`); onCreated(r.source.id); }
    catch (err) { notify((err as Error).message, true); setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <h2 className="schema-h m-0">New database</h2>
        <label className="field">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Booking app" maxLength={60} required /></label>
        <p className="use-note m-0">Database <span className="mono">{slug ? `app_${slug}` : "app_…"}</span>, login <span className="mono">{slug ? `app_${slug}_owner` : "…_owner"}</span> for your app, and a read-only login for Creama.</p>
        <div className="row"><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !slug}>{busy ? <span className="spin" /> : "Create"}</button></div>
      </form>
    </Modal>
  );
}

function Detail({ db, admin, notify, onChanged }: { db: SourceInfo; admin: boolean; notify: (t: string, e?: boolean) => void; onChanged: (id?: number) => void }) {
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
    if (!window.confirm(`New password for the ${role === "owner" ? "app" : "Creama read-only"} login of ${db.dbName}? Anything using the old one loses access now.`)) return;
    act("reset", async () => { setConn(await api<Conn>(`/api/sources/${db.id}/reset-password`, { body: { role }, source: null })); setReveal(true); notify("New password issued."); });
  };
  const retry = () => act("retry", async () => { await api(`/api/sources/${db.id}/retry`, { body: {}, source: null }); notify(`${db.dbName} is ready.`); onChanged(db.id); });
  const remove = () => {
    const name = hosted ? db.dbName! : db.slug;
    const typed = window.prompt(hosted
      ? `Delete ${name} and all its data? This can't be undone. Type the database name to confirm:`
      : `Remove ${db.name} from Creama? Its certified metrics stop being served; the database itself isn't touched. Type “${name}” to confirm:`);
    if (typed !== name) { if (typed !== null) notify("The name didn't match; nothing was removed.", true); return; }
    act("delete", async () => { await api(`/api/sources/${db.id}/delete`, { body: {}, source: null }); notify(hosted ? `Deleted ${name}.` : `Removed ${db.name}.`); onChanged(); });
  };

  if (!hosted) return (
    <div className="hosted-detail">
      <div className="eyebrow">Connected database</div>
      <h1 className="title">{db.name}</h1>
      <div className="hosted-stats">
        <div><span>In Creama</span><b className="mono">{db.slug}</b></div>
        <div><span>Metrics</span><b>{db.metrics}{db.attention ? ` · ${db.attention} need attention` : ""}</b></div>
        <div><span>Login</span><b>{db.readOnly ? "read-only" : `can write (${db.writableTables} tables)`}</b></div>
        <div><span>Added</span><b>{ago(db.createdAt)}</b><small>by {db.createdBy}</small></div>
      </div>
      <section className="hosted-card">
        <div className="row"><p className="m-0 grow muted">Creama reads it in read-only transactions with the connection string you gave; it’s stored encrypted.</p><a className="btn primary" href={sourceHref(db.slug)}>Open</a></div>
      </section>
      {admin && <section className="hosted-card danger">
        <div className="hosted-card-head"><h2>Danger zone</h2></div>
        <div className="row"><div className="grow"><b>Remove from Creama</b><div className="small muted">Forgets the connection. Its metrics stop being served; history stays in the audit log. The database isn’t touched.</div></div><button className="btn text-fail" disabled={busy === "delete"} onClick={remove}>Remove</button></div>
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
      {db.status === "provisioning" && <div className="callout small">Being created…</div>}
      {db.status === "failed" && <div className="callout warn small row"><span className="grow">Creating it failed: {db.error}</span>{admin && <button className="btn sm" disabled={busy === "retry"} onClick={retry}>Retry</button>}</div>}
      <div className="hosted-stats">
        <div><span>Database</span><b className="mono">{db.dbName}</b></div>
        <div><span>Size</span><b>{size(db.sizeBytes)}</b></div>
        <div><span>Connections</span><b>{db.connections ?? "—"}</b></div>
        <div><span>Created</span><b>{ago(db.createdAt)}</b><small>by {db.createdBy}</small></div>
      </div>
      {db.missing && <div className="callout warn small">This database no longer exists on the hosting server.</div>}

      {ready && admin && <section className="hosted-card">
        <div className="hosted-card-head">
          <h2>Connection details</h2>
          <span className="grow" />
          <select className="select sm" value={role} onChange={(e) => { setRole(e.target.value as Role); setReveal(false); }} aria-label="Login">
            <option value="owner">{db.dbName}_owner · app (read/write)</option>
            <option value="reader">{db.dbName}_creama · read-only</option>
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
        {role === "reader" && <p className="use-note m-0">Read-only: this login can’t change anything, including tables your app creates later.</p>}
      </section>}

      {ready && <section className="hosted-card">
        <div className="hosted-card-head"><h2>Creama</h2></div>
        <div className="row"><p className="m-0 grow muted">Creama analyses it with the read-only login{db.metrics ? `: ${db.metrics} certified metric${db.metrics > 1 ? "s" : ""}` : ""}.</p><a className="btn primary" href={sourceHref(db.slug)}>Open</a></div>
      </section>}

      {admin && <section className="hosted-card danger">
        <div className="hosted-card-head"><h2>Danger zone</h2></div>
        {ready && <div className="row"><div className="grow"><b>Reset password</b><div className="small muted">Issues a new password for the selected login. The old one stops working at once.</div></div><button className="btn" disabled={busy === "reset"} onClick={reset}>Reset password</button></div>}
        <div className="row"><div className="grow"><b>Delete database</b><div className="small muted">Drops the database, its data and both logins. Its metrics stop being served.</div></div><button className="btn text-fail" disabled={busy === "delete"} onClick={remove}>Delete</button></div>
      </section>}
    </div>
  );
}
