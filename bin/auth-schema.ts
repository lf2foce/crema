#!/usr/bin/env -S npx tsx
export {};
// Prints the SQL Better Auth needs on top of the given database (default: an empty one).
// Use it to write the next migration in core/migrations.ts after adding or upgrading a plugin:
//   createdb crema_authgen && DATABASE_URL=postgresql://localhost:5432/crema_authgen npx tsx bin/auth-schema.ts
process.env.BETTER_AUTH_SECRET ||= "schema-generation-only-" + "x".repeat(16);
const { getMigrations } = await import("better-auth/db/migration");
const { getAuthUnmigrated } = await import("../lib/auth");
const m = await getMigrations(getAuthUnmigrated().options);
process.stdout.write((await m.compileMigrations()) + "\n");
process.exit(0);
