// Projects: what a person names ("ComicAI"). A project has branches, each one a source (a database):
// production (the project's main), development, staging. Connected databases are projects of one
// branch too. A branch's environment says what it is for (a label people see and policies key off);
// what you may do to it (clone, reset, delete) depends on the kind of database, never on its name.
export default `
CREATE TABLE projects (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  name text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

ALTER TABLE sources ADD COLUMN project_id integer REFERENCES projects (id);
ALTER TABLE sources ADD COLUMN environment text CHECK (environment IN ('production', 'staging', 'development'));

-- every database that isn't a branch becomes a project with one branch: a hosted database is its
-- production; a connected one is "main", unlabelled (nobody said what it is); branches join their parent's
DO $$
DECLARE r record; pid integer;
BEGIN
  -- an earlier version only reserved the name "main": a branch called "production" would collide
  -- with the production branch every database now has. Rename it (its database name is unchanged).
  UPDATE sources SET branch = 'production_' || id WHERE parent_id IS NOT NULL AND branch = 'production';
  FOR r IN SELECT * FROM sources WHERE parent_id IS NULL ORDER BY id LOOP
    INSERT INTO projects (workspace_id, name, created_by, created_at, deleted_at)
      VALUES (r.workspace_id, r.name, r.created_by, r.created_at, r.deleted_at) RETURNING id INTO pid;
    UPDATE sources SET project_id = pid, branch = CASE WHEN r.kind = 'hosted' THEN 'production' ELSE 'main' END,
      environment = CASE WHEN r.kind = 'hosted' THEN 'production' END WHERE id = r.id;
  END LOOP;
  UPDATE sources b SET project_id = p.project_id, environment = 'development' FROM sources p WHERE b.parent_id = p.id;
END $$;

ALTER TABLE sources ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE sources ALTER COLUMN branch SET NOT NULL;
ALTER TABLE sources DROP COLUMN name;   -- the project's name is the one name
DROP INDEX sources_branch;
CREATE UNIQUE INDEX sources_project_branch ON sources (project_id, branch) WHERE deleted_at IS NULL;
`;
