// Hosted databases: Postgres databases Creama creates on a cluster it administers
// (CREAMA_HOSTING_ADMIN_URL), for apps elsewhere to use. Each one gets
//   - an owner role the app connects with (read/write, nothing beyond its own database)
//   - a read-only role Creama uses to analyse it
// Passwords are generated here; the service stores them sealed (core/secret.ts).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { quoteIdent } from "./warehouse";

export class HostingError extends Error {}

const NAME = /^[a-z][a-z0-9_]{1,38}$/; // what we interpolate into DDL: nothing else ever is
const password = () => randomBytes(24).toString("base64url"); // 32 chars, URL-safe, no quoting needed
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export type HostedInfo = { dbName: string; owner: string; reader: string; sizeBytes: number | null; connections: number };

export class Hosting {
  constructor(
    readonly adminUrl: string,
    readonly publicAddress: { host: string; port: number; ssl: boolean },
    /** true when no cluster was configured and Creama uses the server that holds its own state */
    readonly shared = false,
  ) {}

  /**
   * CREAMA_HOSTING_ADMIN_URL when set (a separate cluster: the right setup for production);
   * otherwise the Postgres server in DATABASE_URL, so hosting works out of the box in development.
   */
  static fromEnv(): Hosting | null {
    const explicit = process.env.CREAMA_HOSTING_ADMIN_URL;
    let admin = explicit;
    if (!admin && process.env.DATABASE_URL) {
      const u = new URL(process.env.DATABASE_URL);
      u.pathname = "/postgres";
      admin = u.toString();
    }
    if (!admin) return null;
    const u = new URL(admin);
    const [host, port] = (process.env.CREAMA_HOSTING_PUBLIC_HOST ?? `${u.hostname}:${u.port || 5432}`).split(":");
    return new Hosting(admin, { host, port: Number(port || 5432), ssl: process.env.CREAMA_HOSTING_SSL === "require" }, !explicit);
  }

  /** Can this login create databases and roles? Checked before offering the feature. */
  async canAdminister(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const r = await this.admin((c) => c.query<{ ok: boolean; who: string }>("SELECT (rolsuper OR (rolcreatedb AND rolcreaterole)) AS ok, rolname AS who FROM pg_roles WHERE rolname = current_user"));
      return r.rows[0]?.ok ? { ok: true } : { ok: false, reason: `The role “${r.rows[0]?.who}” can't create databases and roles (needs CREATEDB and CREATEROLE).` };
    } catch (e) {
      return { ok: false, reason: `Can't reach the hosting server: ${(e as Error).message}` };
    }
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

  private async admin<T>(fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> {
    const url = new URL(this.adminUrl);
    if (database) url.pathname = `/${database}`;
    const c = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 8_000, statement_timeout: 60_000 });
    await c.connect();
    try { return await fn(c); } finally { await c.end().catch(() => {}); }
  }

  /** Creates the database and both roles. Returns the owner's password, the only time it exists in plain text. */
  async create(dbName: string): Promise<{ owner: string; reader: string; ownerPassword: string; readerPassword: string }> {
    if (!NAME.test(dbName)) throw new HostingError(`Invalid database name “${dbName}”.`);
    const owner = `${dbName}_owner`, reader = `${dbName}_creama`;
    const ownerPw = password(), readerPw = password();
    await this.admin(async (c) => {
      const exists = await c.query("SELECT 1 FROM pg_database WHERE datname = $1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname = ANY($2)", [dbName, [owner, reader]]);
      if (exists.rowCount) throw new HostingError(`A database or role named “${dbName}” already exists.`);
      // roles: no superuser, can't make roles or databases, capped connections
      await c.query(`CREATE ROLE ${quoteIdent(owner)} LOGIN PASSWORD ${literal(ownerPw)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20`);
      await c.query(`CREATE ROLE ${quoteIdent(reader)} LOGIN PASSWORD ${literal(readerPw)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5`);
      await c.query(`ALTER ROLE ${quoteIdent(reader)} SET default_transaction_read_only = on`);
      await c.query(`ALTER ROLE ${quoteIdent(owner)} SET idle_in_transaction_session_timeout = '10min'`);
      // CREATE DATABASE can't run inside a transaction; a failure past this point is cleaned up below
      try {
        await c.query(`CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(owner)}`);
        // only its own roles may connect: hosted databases can't see each other
        await c.query(`REVOKE ALL ON DATABASE ${quoteIdent(dbName)} FROM PUBLIC`);
        await c.query(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(reader)}`);
      } catch (e) {
        await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`).catch(() => {});
        await c.query(`DROP ROLE IF EXISTS ${quoteIdent(owner)}`).catch(() => {});
        await c.query(`DROP ROLE IF EXISTS ${quoteIdent(reader)}`).catch(() => {});
        throw e;
      }
    });
    await this.admin(async (c) => {
      await c.query(`ALTER SCHEMA public OWNER TO ${quoteIdent(owner)}`);
      await c.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
      await c.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(reader)}`);
      // whatever the app creates later is readable by Creama, and only readable
      await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(owner)} IN SCHEMA public GRANT SELECT ON TABLES TO ${quoteIdent(reader)}`);
      await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(owner)} IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${quoteIdent(reader)}`);
    }, dbName);
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
