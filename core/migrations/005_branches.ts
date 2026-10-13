// Branches of a hosted database (Neon-style projects): a branch is its own hosted database on the
// same server, filled with a consistent snapshot of its parent (pg_dump | pg_restore). The parent is
// the project's main branch.
export default `
ALTER TABLE sources ADD COLUMN parent_id integer REFERENCES sources (id);
ALTER TABLE sources ADD COLUMN branch text;
ALTER TABLE sources ADD COLUMN branched_at timestamptz;   -- when its data was last copied from the parent
ALTER TABLE sources ADD COLUMN branch_copy text CHECK (branch_copy IN ('data', 'schema'));  -- what is copied
ALTER TABLE sources ADD CONSTRAINT sources_branch_hosted CHECK (parent_id IS NULL OR (kind = 'hosted' AND branch IS NOT NULL));
CREATE UNIQUE INDEX sources_branch ON sources (parent_id, branch) WHERE deleted_at IS NULL AND parent_id IS NOT NULL;
`;
