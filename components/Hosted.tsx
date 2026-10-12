"use client";
import { useCallback, useEffect, useState } from "react";
import { ago, api } from "@/lib/client";
import { Copy, Modal } from "./ui";

type Hosted = { id: number; name: string; dbName: string; owner: string; createdBy: string; createdAt: string; sizeBytes: number | null; connections: number | null; missing: boolean; inCreama: boolean };
type List = { enabled: boolean; reason: string | null; shared: boolean; address: string | null; ssl: boolean; databases: Hosted[] };
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

/** Postgres databases for apps built elsewhere, Neon-style: pick a database, copy how to connect. Admin only. */
export function Hosted({ notify, reload }: { notify: (t: string, e?: boolean) => void; reload: () => void }) {
  const [list, setList] = useState<List | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (select?: number) => {
    try {
      const l = await api<List>("/api/hosting");
      setList(l);
      setSelected((cur) => select ?? (l.databases.some((d) => d.id === cur) ? cur : l.databases[0]?.id ?? null));
    } catch (e) { notify((e as Error).message, true); }
  }, [notify]);
  useEffect(() => { load(); }, [load]);

  if (!list) return <div className="center"><span className="spin" /></div>;
  const db = list.databases.find((d) => d.id === selected) ?? null;

  if (!list.enabled) return (
    <div className="page narrow">
      <h1 className="title">Hosted databases</h1>
      <div className="card pad stack">
        <div className="section-title m-0">Hosting isn’t available</div>
        <p className="m-0 muted">{list.reason}</p>
        <pre className="code">{`# a Postgres login that may create databases and roles\nCREAMA_HOSTING_ADMIN_URL=postgresql://admin:…@localhost:5432/postgres\n# the address apps connect to, and whether TLS is required\nCREAMA_HOSTING_PUBLIC_HOST=db.example.com:5432\nCREAMA_HOSTING_SSL=require`}</pre>
      </div>
    </div>
  );

  return (
    <div className="hostedpage">
      <aside className="sql-side">
        <button className="btn primary sm" onClick={() => setCreating(true)}>+ New database</button>
        <h4>{list.databases.length} database{list.databases.length === 1 ? "" : "s"}</h4>
        <ul className="sql-list">
          {list.databases.map((d) => (
            <li key={d.id} className={`saved ${d.id === selected ? "on" : ""}`}>
              <button className="sql-item" onClick={() => setSelected(d.id)}>
                <span className="ellipsis">{d.name}</span>
                <span className="faint">{d.dbName} · {size(d.sizeBytes)}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="use-note hosted-where">Apps connect to <span className="mono">{list.address}</span>{list.ssl ? " over TLS" : ""}.</p>
      </aside>

      <main className="hosted-main">
        {list.shared && (
          <div className="hosted-banner">Databases are created on the Postgres server that holds Creama’s own data. Fine for development; in production set <span className="mono">CREAMA_HOSTING_ADMIN_URL</span> to a separate cluster.</div>
        )}
        {db ? <Detail key={db.id} db={db} notify={notify} onChanged={(id) => { load(id); reload(); }} /> : (
          <div className="hosted-empty">
            <h1 className="title">Postgres for your apps</h1>
            <p className="meaning">Create a database, paste its connection string into any app, and let Creama analyse the same data read-only.</p>
            <button className="btn primary lg" onClick={() => setCreating(true)}>Create your first database</button>
          </div>
        )}
      </main>

      {creating && <NewDatabase notify={notify} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); load(id); }} />}
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
    try { const r = await api<{ id: number; dbName: string }>("/api/hosting", { body: { name } }); notify(`${r.dbName} is ready.`); onCreated(r.id); }
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

function Detail({ db, notify, onChanged }: { db: Hosted; notify: (t: string, e?: boolean) => void; onChanged: (id?: number) => void }) {
  const [role, setRole] = useState<Role>("owner");
  const [format, setFormat] = useState("url");
  const [reveal, setReveal] = useState(false);
  const [conn, setConn] = useState<Conn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchConn = useCallback(async () => {
    setConn(null); setError(null);
    try { setConn(await api<Conn>(`/api/hosting/${db.id}/connection?role=${role}`)); } catch (e) { setError((e as Error).message); }
  }, [db.id, role]);
  useEffect(() => { fetchConn(); }, [fetchConn]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { notify((e as Error).message, true); } finally { setBusy(null); }
  };
  const use = () => act("use", async () => { await api(`/api/hosting/${db.id}/use`, { body: {} }); notify(`Creama now analyses ${db.dbName}, read-only.`); onChanged(db.id); });
  const reset = () => {
    if (!window.confirm(`New password for the ${role === "owner" ? "app" : "Creama read-only"} login of ${db.dbName}? Anything using the old one loses access now.`)) return;
    act("reset", async () => { setConn(await api<Conn>(`/api/hosting/${db.id}/reset-password`, { body: { role } })); setReveal(true); notify("New password issued."); });
  };
  const remove = () => {
    const typed = window.prompt(`Delete ${db.dbName} and all its data? This can't be undone. Type the database name to confirm:`);
    if (typed !== db.dbName) { if (typed !== null) notify("The name didn't match; nothing was deleted.", true); return; }
    act("delete", async () => { await api(`/api/hosting/${db.id}/delete`, { body: {} }); notify(`Deleted ${db.dbName}.`); onChanged(); });
  };

  const fmt = FORMATS.find((f) => f.id === format)!;
  const actual = conn ? fmt.render(conn.connectionString) : "";
  const shown = conn ? (reveal ? actual : actual.split(conn.password).join(MASK)) : "";

  return (
    <div className="hosted-detail">
      <div className="eyebrow">Database</div>
      <h1 className="title">{db.name}</h1>
      <div className="hosted-stats">
        <div><span>Database</span><b className="mono">{db.dbName}</b></div>
        <div><span>Size</span><b>{size(db.sizeBytes)}</b></div>
        <div><span>Connections</span><b>{db.connections ?? "—"}</b></div>
        <div><span>Created</span><b>{ago(db.createdAt)}</b><small>by {db.createdBy}</small></div>
      </div>
      {db.missing && <div className="callout warn small mb-4">This database no longer exists on the hosting server.</div>}

      <section className="hosted-card">
        <div className="hosted-card-head">
          <h2>Connection details</h2>
          <span className="grow" />
          <select className="select sm" value={role} onChange={(e) => { setRole(e.target.value as Role); setReveal(false); }} aria-label="Login">
            <option value="owner">{db.owner} · app (read/write)</option>
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
      </section>

      <section className="hosted-card">
        <div className="hosted-card-head"><h2>Creama</h2></div>
        {db.inCreama
          ? <p className="m-0">Creama analyses this database. <a href="#schema">Schema</a> · <a href="#tables">Tables</a> · <a href="#sql">SQL editor</a> · <a href="#">Metrics</a></p>
          : <div className="row"><p className="m-0 grow muted">Find and certify this app’s metrics: Creama connects with the read-only login.</p><button className="btn" disabled={busy === "use" || db.missing} onClick={use}>Use in Creama</button></div>}
      </section>

      <section className="hosted-card danger">
        <div className="hosted-card-head"><h2>Danger zone</h2></div>
        <div className="row"><div className="grow"><b>Reset password</b><div className="small muted">Issues a new password for the selected login. The old one stops working at once.</div></div><button className="btn" disabled={busy === "reset" || db.missing} onClick={reset}>Reset password</button></div>
        <div className="row"><div className="grow"><b>Delete database</b><div className="small muted">Drops the database, its data and both logins. Not possible while Creama analyses it.</div></div><button className="btn text-fail" disabled={busy === "delete"} onClick={remove}>Delete</button></div>
      </section>
    </div>
  );
}
