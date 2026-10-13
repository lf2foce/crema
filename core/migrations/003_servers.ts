// Postgres servers Crema administers. Hosted databases live on one of these, never on the server
// that holds Crema's own state by accident: a server is something an admin adds, on purpose.
export default `
CREATE TABLE servers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  name text NOT NULL,
  admin_url text NOT NULL,          -- sealed: Crema's own provisioner login (CREATEDB CREATEROLE, never a superuser)
  provisioner text NOT NULL,        -- that login's role name, shown to admins
  public_host text NOT NULL,        -- host:port apps connect to
  ssl boolean NOT NULL,             -- apps must use TLS (sslmode=require in their connection strings)
  version text NOT NULL,            -- server_version when added
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX servers_name ON servers (workspace_id, name) WHERE deleted_at IS NULL;

ALTER TABLE sources ADD COLUMN server_id integer REFERENCES servers (id);
ALTER TABLE sources ADD CONSTRAINT sources_hosted_server CHECK (kind <> 'hosted' OR server_id IS NOT NULL);
DROP INDEX sources_hosted_db;
CREATE UNIQUE INDEX sources_hosted_db ON sources (server_id, db_name) WHERE deleted_at IS NULL AND kind = 'hosted';
`;
