// Hosted databases: Postgres databases Crema creates for apps elsewhere, on a server an admin
// added (see `servers` in the registry). Each database gets
//   - an owner role the app connects with (read/write, nothing beyond its own database)
//   - a read-only role Crema uses to analyse it
// Crema administers a server through its own provisioner login: CREATEDB + CREATEROLE, never a
// superuser. On PostgreSQL 16+ such a role can only alter or drop roles it created itself, so a
// bug here can't touch anything else on the server. Passwords are generated here; the service
// stores them sealed (core/secret.ts).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { quoteIdent } from "./warehouse";
import { dbNameProblem } from "../lib/dbName";

export class HostingError extends Error {}

const NAME = /^[a-z][a-z0-9_]{1,38}$/; // what we interpolate into DDL: nothing else ever is
export const password = () => randomBytes(24).toString("base64url"); // 32 chars, URL-safe, no quoting needed
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
const MIN_VERSION = 160000; // CREATEROLE scoped to the roles it created

export type HostedInfo = { dbName: string; owner: string; reader: string; sizeBytes: number | null; connections: number };
export type Address = { host: string; port: number; ssl: boolean };
/** What a login can do on a server, checked before Crema keeps it. */
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

  /** Why Crema won't administer a server through this login, or null when it will. */
  static refusal(c: LoginCheck): string | null {
    if (c.versionNum < MIN_VERSION) return `PostgreSQL ${c.version} is too old: hosting needs 16 or newer, where a role that creates roles can only manage its own.`;
    if (c.superuser) return `“${c.user}” is a superuser. Crema administers servers through a limited login (CREATEDB, CREATEROLE).`;
    if (!c.canProvision) return `“${c.user}” can't create databases and roles (needs CREATEDB and CREATEROLE).`;
    return null;
  }

  /**
   * Given a superuser login once, create Crema's own provisioner (CREATEDB CREATEROLE, nothing
   * more) and return its URL. The superuser's credentials are used for this one statement and
   * never stored.
   */
  static async createProvisioner(superUrl: string): Promise<{ url: string; role: string }> {
    const role = `crema_provisioner_${randomBytes(3).toString("hex")}`, pw = password();
    await connect(superUrl, (c) => c.query(`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${literal(pw)} CREATEDB CREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10`));
    const u = new URL(superUrl);
    u.username = role; u.password = pw; u.pathname = "/postgres";
    return { url: u.toString(), role };
  }

  /** Undo createProvisioner when the server couldn't be recorded. */
  static async dropRole(superUrl: string, role: string) {
    if (!/^crema_provisioner_[0-9a-f]{6}$/.test(role)) throw new HostingError("Not a provisioner role.");
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

  /** How Crema itself reaches a hosted database: through the admin host, not the public address. */
  internalUrl(dbName: string, role: string, pw: string) {
    const u = new URL(this.adminUrl);
    u.username = role; u.password = pw; u.pathname = `/${dbName}`;
    return u.toString();
  }

  /** Host, port and flags for showing a connection in parts, the way database consoles do. */
  connectionParts(dbName: string, role: string, pw: string) {
    return { host: this.publicAddress.host, port: this.publicAddress.port, database: dbName, user: role, password: pw, ssl: this.publicAddress.ssl, connectionString: this.connectionString(dbName, role, pw) };
  }

  /** What on this server already uses the name: the database, or either role it would need. */
  async taken(dbName: string): Promise<string[]> {
    const r = await this.admin((c) => c.query<{ name: string }>(
      "SELECT datname AS name FROM pg_database WHERE datname = $1 UNION ALL SELECT rolname FROM pg_roles WHERE rolname = ANY($2)",
      [dbName, [dbName, `${dbName}_owner`, `${dbName}_crema`]]));
    return r.rows.map((x) => x.name);
  }

  connectionString(dbName: string, role: string, pw: string) {
    const { host, port, ssl } = this.publicAddress;
    return `postgresql://${role}:${pw}@${host}:${port}/${dbName}${ssl ? "?sslmode=require" : ""}`;
  }

  private admin<T>(fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> {
    return connect(this.adminUrl, fn, database);
  }

  /**
   * Is each name free, or Crema's from an earlier attempt with this token? Ours means: the
   * provisioner created the role (PostgreSQL 16+ records an ADMIN OPTION grant to its creator) and
   * the role's (or database's) comment is this source's token. Anything else is somebody else's.
   */
  private async ownership(c: pg.Client, dbName: string, token: string) {
    const q = await c.query<{ name: string; kind: string; exists: boolean; ours: boolean }>(`
      WITH me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
      roles AS (
        SELECT n AS name, 'role' AS kind, r.oid IS NOT NULL AS exists,
               COALESCE(shobj_description(r.oid, 'pg_authid') = $3
                 AND EXISTS (SELECT 1 FROM pg_auth_members m, me WHERE m.roleid = r.oid AND m.member = me.oid AND m.admin_option), false) AS ours
        FROM unnest($2::text[]) AS n LEFT JOIN pg_roles r ON r.rolname = n)
      SELECT * FROM roles
      UNION ALL
      SELECT $1, 'database', d.oid IS NOT NULL,
             COALESCE(shobj_description(d.oid, 'pg_database') = $3 AND pg_get_userbyid(d.datdba) = $4, false)
      FROM (SELECT 1) one LEFT JOIN pg_database d ON d.datname = $1`,
      [dbName, [`${dbName}_owner`, `${dbName}_crema`], token, `${dbName}_owner`]);
    const by = (name: string) => q.rows.find((r) => r.name === name)!;
    return { owner: by(`${dbName}_owner`), reader: by(`${dbName}_crema`), database: by(dbName) };
  }

  /**
   * Creates the database and both roles with the given passwords, or finishes an earlier attempt
   * that carried the same token (a crash part-way can be retried). Never adopts anything else.
   */
  async create(dbName: string, p: { token: string; ownerPassword: string; readerPassword: string; limits?: { owner: number; reader: number } }): Promise<{ owner: string; reader: string }> {
    if (!NAME.test(dbName) || dbNameProblem(dbName)) throw new HostingError(`Invalid database name “${dbName}”.`);
    if (!/^[0-9a-f-]{36}$/.test(p.token)) throw new HostingError("Invalid provisioning token.");
    const owner = `${dbName}_owner`, reader = `${dbName}_crema`, mark = literal(p.token);
    await this.admin(async (c) => {
      // Serialize Crema provisioning for this name: a retry waits for (or follows) a running attempt.
      await c.query("SELECT pg_advisory_lock(hashtext($1))", [`crema.hosting:${dbName}`]);
      // PostgreSQL 16+: be able to act as the roles we create (own the database, set default privileges)
      await c.query("SET createrole_self_grant = 'set, inherit'");
      let madeOwner = false, madeReader = false, madeDatabase = false;
      try {
        const own = await this.ownership(c, dbName, p.token);
        if ([own.owner, own.reader, own.database].some((x) => x.exists && !x.ours)) throw new HostingError(`A database or role named “${dbName}” already exists.`);
        // roles: no superuser, can't make roles or databases, capped connections; marked as this source's
        const role = async (name: string, pw: string, limit: number, exists: boolean) => {
          // resuming: set the stored password again (the rest was fixed at creation; a non-superuser
          // can't raise those attributes and may not even restate them)
          await c.query(exists
            ? `ALTER ROLE ${quoteIdent(name)} LOGIN PASSWORD ${literal(pw)} CONNECTION LIMIT ${limit}`
            : `CREATE ROLE ${quoteIdent(name)} LOGIN PASSWORD ${literal(pw)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${limit}`);
          if (!exists) await c.query(`COMMENT ON ROLE ${quoteIdent(name)} IS ${mark}`);
        };
        const limits = p.limits ?? { owner: 20, reader: 5 };
        await role(owner, p.ownerPassword, limits.owner, own.owner.exists); madeOwner = !own.owner.exists;
        await role(reader, p.readerPassword, limits.reader, own.reader.exists); madeReader = !own.reader.exists;
        await c.query(`ALTER ROLE ${quoteIdent(reader)} SET default_transaction_read_only = on`);
        await c.query(`ALTER ROLE ${quoteIdent(owner)} SET idle_in_transaction_session_timeout = '10min'`);
        // CREATE DATABASE can't run inside a transaction; a failure past this point is cleaned up below
        if (!own.database.exists) {
          await c.query(`CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(owner)}`);
          madeDatabase = true;
          await c.query(`COMMENT ON DATABASE ${quoteIdent(dbName)} IS ${mark}`);
        }
        // only its own roles may connect: hosted databases can't see each other
        await c.query(`REVOKE ALL ON DATABASE ${quoteIdent(dbName)} FROM PUBLIC`);
        await c.query(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(reader)}`);
        // inside the new database, over a second admin connection
        await this.admin(async (d) => {
          await d.query(`ALTER SCHEMA public OWNER TO ${quoteIdent(owner)}`);
          await d.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
          await d.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(reader)}`);
          // whatever the app creates later is readable by Crema, and only readable
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
        if (cleanupErrors.length) throw new HostingError(`${(e as Error).message}; cleanup incomplete: ${cleanupErrors.join("; ")}. Retrying resumes it.`);
        throw e;
      } finally {
        await c.query("SELECT pg_advisory_unlock(hashtext($1))", [`crema.hosting:${dbName}`]).catch(() => {});
      }
    });
    return { owner, reader };
  }

  /** New password for one of this source's roles; the old one stops working immediately. */
  async resetPassword(dbName: string, which: "owner" | "crema", token: string): Promise<string> {
    if (!NAME.test(dbName)) throw new HostingError(`Invalid database name “${dbName}”.`);
    const role = `${dbName}_${which}`, pw = password();
    await this.admin(async (c) => {
      const own = await this.ownership(c, dbName, token);
      if (!(which === "owner" ? own.owner : own.reader).ours) throw new HostingError(`${role} isn’t one Crema created for this database.`);
      await c.query(`ALTER ROLE ${quoteIdent(role)} PASSWORD ${literal(pw)}`);
    });
    return pw;
  }

  /** Drops this source's database and roles: only those carrying its token, nothing else of that name. */
  async drop(dbName: string, token: string): Promise<{ dropped: string[]; left: string[] }> {
    if (!NAME.test(dbName)) throw new HostingError(`Invalid database name “${dbName}”.`);
    return this.admin(async (c) => {
      await c.query("SELECT pg_advisory_lock(hashtext($1))", [`crema.hosting:${dbName}`]);
      try {
        const own = await this.ownership(c, dbName, token);
        const dropped: string[] = [], left: string[] = [];
        for (const x of [own.database, own.reader, own.owner]) {
          if (!x.exists) continue;
          if (!x.ours) { left.push(x.name); continue; }
          await c.query(x.kind === "database" ? `DROP DATABASE IF EXISTS ${quoteIdent(x.name)} WITH (FORCE)` : `DROP ROLE IF EXISTS ${quoteIdent(x.name)}`);
          dropped.push(x.name);
        }
        return { dropped, left };
      } finally {
        await c.query("SELECT pg_advisory_unlock(hashtext($1))", [`crema.hosting:${dbName}`]).catch(() => {});
      }
    });
  }

  /** Drops only this source's database (its roles stay), e.g. before copying a branch again. */
  async dropDatabase(dbName: string, token: string): Promise<boolean> {
    if (!NAME.test(dbName)) throw new HostingError(`Invalid database name “${dbName}”.`);
    return this.admin(async (c) => {
      await c.query("SELECT pg_advisory_lock(hashtext($1))", [`crema.hosting:${dbName}`]);
      try {
        const own = await this.ownership(c, dbName, token);
        if (own.database.exists && !own.database.ours) throw new HostingError(`${dbName} isn’t one Crema created for this database.`);
        if (!own.database.exists) return false;
        await c.query(`DROP DATABASE ${quoteIdent(dbName)} WITH (FORCE)`);
        return true;
      } finally {
        await c.query("SELECT pg_advisory_unlock(hashtext($1))", [`crema.hosting:${dbName}`]).catch(() => {});
      }
    });
  }

  /** Size and open connections for the databases Crema created. */
  async info(dbNames: string[]): Promise<Record<string, HostedInfo>> {
    if (!dbNames.length) return {};
    const rows = await this.admin((c) => c.query<{ datname: string; size: string | null; conns: number }>(
      `SELECT d.datname, pg_database_size(d.datname)::text AS size, (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS conns
       FROM pg_database d WHERE d.datname = ANY($1)`, [dbNames]));
    return Object.fromEntries(rows.rows.map((r) => [r.datname, { dbName: r.datname, owner: `${r.datname}_owner`, reader: `${r.datname}_crema`, sizeBytes: r.size == null ? null : Number(r.size), connections: r.conns }]));
  }
}
