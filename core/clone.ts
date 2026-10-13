// Copies one hosted database into another: pg_dump (one consistent snapshot, read inside a
// repeatable-read transaction, so the source keeps serving its app) piped into pg_restore, which
// runs as the target's owner so every object it creates belongs to that owner. Ownership and grants
// of the source aren't copied: the target's own (default) privileges apply.
import { spawn } from "node:child_process";

export class CloneError extends Error {}

/** libpq spelling of a node-postgres URL: `no-verify` is node-only; libpq's `require` means the same. */
export function libpqUrl(url: string): string {
  const u = new URL(url);
  if (u.searchParams.get("sslmode") === "no-verify") u.searchParams.set("sslmode", "require");
  u.searchParams.delete("uselibpqcompat");
  return u.toString();
}

const BIN = (name: "pg_dump" | "pg_restore") => process.env.CREMA_PG_BIN ? `${process.env.CREMA_PG_BIN}/${name}` : name;

export async function cloneDatabase(fromUrl: string, toUrl: string, opts: { timeoutMs?: number; schemaOnly?: boolean } = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? 30 * 60_000;
  const dump = spawn(BIN("pg_dump"), ["--format=custom", ...(opts.schemaOnly ? ["--schema-only"] : []), "--no-owner", "--no-privileges", "--no-publications", "--no-subscriptions", "--dbname", libpqUrl(fromUrl)], { stdio: ["ignore", "pipe", "pipe"] });
  const restore = spawn(BIN("pg_restore"), ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", "--dbname", libpqUrl(toUrl)], { stdio: ["pipe", "ignore", "pipe"] });
  dump.stdout.pipe(restore.stdin);
  const errors: string[] = [];
  // never echo connection strings: libpq messages can include host and user, not passwords
  const collect = (who: string) => (b: Buffer) => { for (const line of b.toString().split("\n")) if (line.trim()) errors.push(`${who}: ${line.trim()}`.slice(0, 300)); };
  dump.stderr.on("data", collect("pg_dump"));
  restore.stderr.on("data", collect("pg_restore"));
  const exit = (p: ReturnType<typeof spawn>) => new Promise<number>((resolve, reject) => {
    p.on("error", (e) => reject(new CloneError((e as NodeJS.ErrnoException).code === "ENOENT" ? "pg_dump/pg_restore aren't installed where Crema runs (PostgreSQL 18 client tools)." : e.message)));
    p.on("close", (code) => resolve(code ?? 1));
  });
  const timer = setTimeout(() => { dump.kill("SIGTERM"); restore.kill("SIGTERM"); errors.push(`timed out after ${Math.round(timeout / 60_000)} minutes`); }, timeout);
  try {
    const [d, r] = await Promise.all([exit(dump), exit(restore)]);
    if (d !== 0 || r !== 0) throw new CloneError(`Copying the data failed: ${errors.slice(-3).join(" · ") || `exit ${d}/${r}`}`);
  } finally {
    clearTimeout(timer);
  }
}
