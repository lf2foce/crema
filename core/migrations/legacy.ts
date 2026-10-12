// Bridge the released single-source schema into 001_init without deleting user data.
// Executed under the migration lock and in one transaction; the immutable payloads stay intact.
import type pg from "pg";
import init from "./001_init";
import { seal } from "../secret";

export async function upgradeLegacy(c: pg.PoolClient) {
  const [{ url }] = (await c.query<{ url: string | null }>("SELECT (SELECT value FROM settings WHERE key = 'database_url') AS url")).rows;
  const [{ n }] = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM metrics")).rows;
  if (n && !url) throw new Error("Legacy metrics have no saved database_url. Restore the original source URL in settings before migrating; never bind old metrics to an arbitrary new DB.");

  // Better Auth tables may already have been created by its old bootstrap command.
  const authSql = init.split("-- Creama. A workspace")[0]
    .replace(/create table /gi, "create table if not exists ")
    .replace(/create unique index /gi, "create unique index if not exists ")
    .replace(/create index /gi, "create index if not exists ");
  await c.query(authSql);
  await c.query(`ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "activeOrganizationId" text`);
  await c.query(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('default', 'Default workspace', 'default', now()) ON CONFLICT (id) DO NOTHING`);
  await c.query(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    SELECT 'legacy-' || id, 'default', id, CASE WHEN role = 'admin' THEN 'owner' ELSE 'member' END, now() FROM "user"
    WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."organizationId" = 'default' AND m."userId" = "user".id)`);
  const sourceSql = init.slice(init.indexOf("CREATE TABLE sources ("), init.indexOf("-- discovery runs"));
  await c.query(sourceSql);
  const source = (await c.query<{ id: number }>(`INSERT INTO sources (workspace_id, slug, name, kind, status, connection, created_by)
    VALUES ('default', 'legacy', 'Original database', 'external', $1, $2, 'migration') RETURNING id`,
    [url ? "ready" : "failed", url ? seal(url) : null])).rows[0].id;
  await c.query(`
    ALTER TABLE runs ADD COLUMN source_id integer REFERENCES sources(id);
    ALTER TABLE concepts ADD COLUMN source_id integer REFERENCES sources(id);
    ALTER TABLE saved_queries ADD COLUMN source_id integer REFERENCES sources(id);
    ALTER TABLE metrics ADD COLUMN source_id integer REFERENCES sources(id), ADD COLUMN id integer GENERATED ALWAYS AS IDENTITY, ADD COLUMN attention text;
    ALTER TABLE metric_versions DROP CONSTRAINT metric_versions_metric_key_fkey;
    ALTER TABLE metrics DROP CONSTRAINT metrics_pkey;
    ALTER TABLE metrics ADD PRIMARY KEY (id), ADD UNIQUE (source_id, key);
    ALTER TABLE metric_versions ADD COLUMN metric_id integer REFERENCES metrics(id);
    DROP TRIGGER metric_versions_immutable ON metric_versions;
    UPDATE metric_versions v SET metric_id = m.id FROM metrics m WHERE m.key = v.metric_key;
    ALTER TABLE metric_versions DROP CONSTRAINT metric_versions_pkey;
    ALTER TABLE metric_versions DROP COLUMN metric_key;
    ALTER TABLE metric_versions ALTER COLUMN metric_id SET NOT NULL;
    ALTER TABLE metric_versions ADD PRIMARY KEY (metric_id, version);
    CREATE TRIGGER metric_versions_immutable BEFORE UPDATE OR DELETE ON metric_versions
      FOR EACH ROW EXECUTE FUNCTION creama_refuse_change('certified versions are immutable');
    ALTER TABLE events ADD COLUMN workspace_id text REFERENCES "organization"(id), ADD COLUMN source_id integer REFERENCES sources(id);
    DROP TRIGGER events_append_only ON events;
    UPDATE events SET workspace_id = 'default';
    CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
      FOR EACH ROW EXECUTE FUNCTION creama_refuse_change('audit log is append-only');
    ALTER TABLE events ALTER COLUMN workspace_id SET NOT NULL;
    ALTER TABLE concepts DROP CONSTRAINT concepts_status_check;
    UPDATE concepts SET status = 'rejected' WHERE status = 'dismissed';
    ALTER TABLE concepts ADD CHECK (status IN ('open','certified','rejected','superseded'));
    ALTER TABLE metrics DROP CONSTRAINT metrics_status_check;
    UPDATE metrics SET status = 'deprecated' WHERE status = 'retired';
    ALTER TABLE metrics ADD CHECK (status IN ('certified','needs_attention','deprecated'));
  `);
  for (const table of ["runs", "concepts", "saved_queries", "metrics"]) {
    await c.query(`UPDATE ${table} SET source_id = $1`, [source]);
    await c.query(`ALTER TABLE ${table} ALTER COLUMN source_id SET NOT NULL`);
  }
  await c.query("DROP TRIGGER events_append_only ON events");
  await c.query("UPDATE events SET source_id = $1", [source]);
  await c.query("CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION creama_refuse_change('audit log is append-only')");
  // Preserve old hosted records and secrets, but don't invent the hosting cluster's address.
  const [{ hosted }] = (await c.query<{ hosted: string | null }>("SELECT to_regclass('hosted_databases')::text AS hosted")).rows;
  if (hosted) {
    await c.query(`ALTER TABLE hosted_databases ADD COLUMN IF NOT EXISTS owner_password text, ADD COLUMN IF NOT EXISTS reader_password text`);
    await c.query(`INSERT INTO sources (workspace_id, slug, name, kind, status, error, db_name, owner_password, reader_password, created_by, created_at, deleted_at)
      SELECT 'default', 'hosted_' || id, name, 'hosted', 'failed', 'Imported legacy hosting record: verify cluster and reconnect before use.',
        db_name, owner_password, reader_password, created_by, created_at, deleted_at FROM hosted_databases`);
  }
  await c.query("DELETE FROM settings WHERE key = 'database_url'"); // now sealed in sources
  await c.query("CREATE INDEX runs_source ON runs (source_id, id DESC)");
  await c.query("CREATE INDEX concepts_open ON concepts (source_id, key) WHERE status = 'open'");
}
