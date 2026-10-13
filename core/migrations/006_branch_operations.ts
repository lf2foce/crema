// A copy operation is distinct from its branch. Completed/stale queue deliveries must not reset it.
export default `
ALTER TABLE sources ADD COLUMN branch_job_id uuid;
ALTER TABLE sources ADD COLUMN branch_completed_job_id uuid;
`;
