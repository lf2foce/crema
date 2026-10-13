#!/usr/bin/env -S npx tsx
// Applies pending migrations to DATABASE_URL (Crema's state, Better Auth's tables included).
// Run on every deploy before starting the app; `pnpm dev` runs it too.
import { loadLocalEnv } from "./env";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);
const { closeDatabases, migrate } = await import("../core/db");
const pg = (await import("pg")).default;
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set."); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied ${applied.join(", ")}` : "Schema is up to date.");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
  await closeDatabases();
}
