export default `
ALTER TABLE runs ADD COLUMN queue_job_id uuid UNIQUE;
CREATE INDEX runs_active ON runs (source_id) WHERE status = 'running';
`;
