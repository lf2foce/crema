// Hosted databases: Postgres databases Creama creates for apps elsewhere, on a server an admin
// added (see `servers` in the registry). Each database gets
//   - an owner role the app connects with (read/write, nothing beyond its own database)
//   - a read-only role Creama uses to analyse it
// Creama administers a server through its own provisioner login: CREATEDB + CREATEROLE, never a
// superuser. On PostgreSQL 16+ such a role can only alter or drop roles it created itself, so a
// bug here can't touch anything else on the server. Passwords are generated here; the service
// stores them sealed (core/secret.ts).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { quoteIdent } from "./warehouse";

export class HostingError extends Error {}

const NAME = /^[a-z][a-z0-9_]{1,38}$/; // what we interpolate into DDL: nothing else ever is
const password = () => randomBytes(24).toString("base64url"); // 32 chars, URL-safe, no quoting needed
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
const MIN_VERSION = 160000; // CREATEROLE scoped to the roles it created

export type HostedInfo = { dbName: string; owner: string; reader: string; sizeBytes: number | null; connections: number };
export type Address = { host: string; port: number; ssl: boolean };
/** What a login can do on a server, checked before Creama keeps it. */
export type LoginCheck = { user: string; version: string; versionNum: number; superuser: boolean; canProvision: boolean };

async function connect<T>(url: string, fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> {
  const u = new URL(url);
  if (database) u.pathname = `/${database}`;
  const c = new pg.Client({ connectionString: u.toString(), connectionTimeoutMillis: 8_000, statement_timeout: 60_000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

export class Hosting {
  constructor(readonly adminUrl: string, readonly publicAddress: Address) {}

  /** Who this login is and whether it can create databases and roles. */
  static async check(url: string): Promise<LoginCheck> {
    const r = await connect(url, (c) => c.query<{ who: string; version: string; num: string; su: boolean; db: boolean; role: boolean }>(
      `SELECT rolname AS who, current_setting('server_version') AS version, current_setting('server_version_num') AS num,
              rolsuper AS su, rolcreatedb AS db, rolcreaterole AS role FROM pg_roles WHERE rolname = current_user`));
    const row = r.rows[0];
    return { user: row.who, version: row.version, versionNum: Number(row.num), superuser: row.su, canProvision: !row.su && row.db && row.role };
  }

  /** Why Creama won't administer a server through this login, or null when it will. */
  static refusal(c: LoginCheck): string | null {
    if (c.versionNum < MIN_VERSION) return `PostgreSQL ${c.version} is too old: hosting needs 16 or newer, where a role that creates roles can only manage its own.`;
    if (c.superuser) return `“${c.user}” is a superuser. Creama administers servers through a limited login (CREATEDB, CREATEROLE).`;
    if (!c.canProvision) return `“${c.user}” can't create databases and roles (needs CREATEDB and CREATEROLE).`;
    return null;
  }

  /**
   * Given a superuser login once, create Creama's own provisioner (CREATEDB CREATEROLE, nothing
   * more) and return its URL. The superuser's credentials are used for this one statement and
   * never stored.
   */
  static async createProvisioner(superUrl: string): Promise<{ url: string; role: string }> {
    const role = `creama_provisioner_${randomBytes(3).toString("hex")}`, pw = password();
    await connect(superUrl, (c) => c.query(`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${literal(pw)} CREATEDB CREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10`));
    const u = new URL(superUrl);
    u.username = role; u.password = pw; u.pathname = "/postgres";
    return { url: u.toString(), role };
  }

  /** Undo createProvisioner when the server couldn't be recorded. */
  static async dropRole(superUrl: string, role: string) {
    if (!/^creama_provisioner_[0-9a-f]{6}$/.test(role)) throw new HostingError("Not a provisioner role.");
    await connect(superUrl, (c) => c.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`));
  }

  /** host:port apps should use: what the admin typed, else the admin URL's own address. */
  static address(adminUrl: string, publicHost?: string | null, ssl?: boolean | null): Address {
    const u = new URL(adminUrl);
    const [host, port] = (publicHost?.trim() || `${u.hostname}:${u.port || 5432}`).split(":");
    if (!host || !/^[A-Za-z0-9.\-]+$/.test(host) || (port && !/^\d{1,5}$/.test(port))) throw new HostingError("Public address must look like db.example.com:5432.");
    const local = /^(localhost|127\.0\.0\.1|::1)$/.test(host);
    return { host, port: Number(port || 5432), ssl: ssl ?? !local };
  }

  /** How Creama itself reaches a hosted database: through the admin host, not the public address. */
  internalUrl(dbName: string, role: string, pw: string) {
    const u = new URL(this.adminUrl);
    u.username = role; u.password = pw; u.pathname = `/${dbName}`;
    return u.toString();
  }

  /** Host, port and flags for showing a connection in parts, the way database consoles do. */
  connectionParts(dbName: string, role: string, pw: string) {
    return { host: this.publicAddress.host, port: this.publicAddress.port, database: dbName, user: role, password: pw, ssl: this.publicAddress.ssl, connectionString: this.connectionString(dbName, role, pw) };
  }

  /** `app_` + a slug of the name people typed. */
  static dbNameFor(name: string): string {
    const slug = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
    if (!slug) throw new HostingError("Give the database a name with letters or digits.");
    return `app_${slug}`;
  }

  connectionString(dbName: string, role: string, pw: string) {
    const { host, port, ssl } = this.publicAddress;
    return `postgresql://${role}:${pw}@${host}:${port}/${dbName}${ssl ? "?sslmode=require" : ""}`;
  }

  private admin<T>(fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> {
    return connect(this.adminUrl, fn, database);
  }

  /** Creates the database and both roles. Returns the owner's password, the only time it exists in plain text. */
  async create(dbName: string): Promise<{ owner: string; reader: string; ownerPassword: string; readerPassword: string }> {
    if (!NAME.test(dbName)) throw new HostingError(`Invalid database name “${dbName}”.`);
    const owner = `${dbName}_owner`, reader = `${dbName}_creama`;
    const ownerPw = password(), readerPw = password();
    await this.admin(async (c) => {
      // Serialize Creama provisioning for this name. A name collision is not ownership.
      await c.query("SELECT pg_advisory_lock(hashtext($1))", [`creama.hosting:${dbName}`]);
      // PostgreSQL 16+: be able to act as the roles we create (own the database, set default privileges)
      await c.query("SET createrole_self_grant = 'set, inherit'");
      let madeOwner = false, madeReader = false, madeDatabase = false;
      try {
        const exists = await c.query("SELECT 1 FROM pg_database WHERE datname = $1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname = ANY($2)", [dbName, [owner, reader]]);
        if (exists.rowCount) throw new HostingError(`A database or role named “${dbName}” already exists.`);
        // roles: no superuser, can't make roles or databases, capped connections
        await c.query(`CREATE ROLE ${quoteIdent(owner)} LOGIN PASSWORD ${literal(ownerPw)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20`);
        madeOwner = true;
        await c.query(`CREATE ROLE ${quoteIdent(reader)} LOGIN PASSWORD ${literal(readerPw)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5`);
        madeReader = true;
        await c.query(`ALTER ROLE ${quoteIdent(reader)} SET default_transaction_read_only = on`);
        await c.query(`ALTER ROLE ${quoteIdent(owner)} SET idle_in_transaction_session_timeout = '10min'`);
        // CREATE DATABASE can't run inside a transaction; a failure past this point is cleaned up below
        await c.query(`CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(owner)}`);
        madeDatabase = true;
        // only its own roles may connect: hosted databases can't see each other
        await c.query(`REVOKE ALL ON DATABASE ${quoteIdent(dbName)} FROM PUBLIC`);
        await c.query(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(reader)}`);
        // inside the new database, over a second admin connection
        await this.admin(async (d) => {
          await d.query(`ALTER SCHEMA public OWNER TO ${quoteIdent(owner)}`);
          await d.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
          await d.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(reader)}`);
          // whatever the app creates later is readable by Creama, and only readable
          await d.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(owner)} IN SCHEMA public GRANT SELECT ON TABLES TO ${quoteIdent(reader)}`);
          await d.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(owner)} IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${quoteIdent(reader)}`);
        }, dbName);
      } catch (e) {
        // clean up only what this attempt created
        const cleanupErrors: string[] = [];
        const cleanup = async (sql: string) => {
          try { await c.query(sql); } catch (error) { cleanupErrors.push((error as Error).message); }
        };
        if (madeDatabase) await cleanup(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
        if (madeReader) await cleanup(`DROP ROLE IF EXISTS ${quoteIdent(reader)}`);
        if (madeOwner) await cleanup(`DROP ROLE IF EXISTS ${quoteIdent(owner)}`);
        if (cleanupErrors.length) throw new HostingError(`${(e as Error).message}; cleanup incomplete: ${cleanupErrors.join("; ")}. Inspect leftovers before retrying.`);
        throw e;
      } finally {
        await c.query("SELECT pg_advisory_unlock(hashtext($1))", [`creama.hosting:${dbName}`]).catch(() => {});
      }
    });
    return { owner, reader, ownerPassword: ownerPw, readerPassword: readerPw };
  }

  /** New password for one of a hosted database's roles; the old one stops working immediately. */
  async resetPassword(role: string): Promise<string> {
    if (!NAME.test(role.replace(/_(owner|creama)$/, "")) || !/_(owner|creama)$/.test(role)) throw new HostingError("Not a hosted database role.");
    const pw = password();
    await this.admin((c) => c.query(`ALTER ROLE ${quoteIdent(role)} PASSWORD ${literal(pw)}`));
    return pw;
  }

  async drop(dbName: string) {
    if (!NAME.test(dbName)) throw new HostingError(`Invalid database name “${dbName}”.`);
    await this.admin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${quoteIdent(`${dbName}_owner`)}`);
      await c.query(`DROP ROLE IF EXISTS ${quoteIdent(`${dbName}_creama`)}`);
    });
  }

  /** Size and open connections for the databases Creama created. */
  async info(dbNames: string[]): Promise<Record<string, HostedInfo>> {
    if (!dbNames.length) return {};
    const rows = await this.admin((c) => c.query<{ datname: string; size: string | null; conns: number }>(
      `SELECT d.datname, pg_database_size(d.datname)::text AS size, (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS conns
       FROM pg_database d WHERE d.datname = ANY($1)`, [dbNames]));
    return Object.fromEntries(rows.rows.map((r) => [r.datname, { dbName: r.datname, owner: `${r.datname}_owner`, reader: `${r.datname}_creama`, sizeBytes: r.size == null ? null : Number(r.size), connections: r.conns }]));
  }
}
