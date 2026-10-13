// Append-only: never edit a migration that has run anywhere; add the next number instead.
// After adding or upgrading a Better Auth plugin, generate its SQL with bin/auth-schema.ts
// (against a database migrated to the previous step) and add it as the next migration.
import m001 from "./001_init";
import m002 from "./002_jobs";
import m003 from "./003_servers";
import m004 from "./004_provision_token";
import m005 from "./005_branches";

export const MIGRATIONS: { id: string; sql: string }[] = [
  { id: "001_init", sql: m001 },
  { id: "002_jobs", sql: m002 },
  { id: "003_servers", sql: m003 },
  { id: "004_provision_token", sql: m004 },
  { id: "005_branches", sql: m005 },
];
