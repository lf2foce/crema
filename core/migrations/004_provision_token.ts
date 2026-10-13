// What makes a hosted database (and its roles) Creama's to resume, rotate or drop: a token stored
// here before anything is created, and written as the COMMENT on the database and both roles.
// Its passwords are stored before anything is created too, so a crash mid-way can be resumed.
export default `
ALTER TABLE sources ADD COLUMN provision_token text;
CREATE UNIQUE INDEX sources_provision_token ON sources (provision_token) WHERE provision_token IS NOT NULL;
`;
