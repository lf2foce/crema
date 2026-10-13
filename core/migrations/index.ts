// Append-only: never edit a migration that has run anywhere; add the next number instead.
// Expand, then contract: a migration runs while the previous version still serves, so it may only
// add. Dropping, renaming or tightening what that version uses waits for a later release and is
// marked `-- contract: <why>` (see compat.ts; the unit tests enforce it from 008 on).
// After adding or upgrading a Better Auth plugin, generate its SQL with bin/auth-schema.ts
// (against a database migrated to the previous step) and add it as the next migration.
import m001 from "./001_init";
import m002 from "./002_jobs";
import m003 from "./003_servers";
import m004 from "./004_provision_token";
import m005 from "./005_branches";
import m006 from "./006_branch_operations";
import m007 from "./007_projects";

export const MIGRATIONS: { id: string; sql: string }[] = [
  { id: "001_init", sql: m001 },
  { id: "002_jobs", sql: m002 },
  { id: "003_servers", sql: m003 },
  { id: "004_provision_token", sql: m004 },
  { id: "005_branches", sql: m005 },
  { id: "006_branch_operations", sql: m006 },
  { id: "007_projects", sql: m007 },
];
