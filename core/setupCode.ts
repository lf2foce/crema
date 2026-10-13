// The one-time setup link: how the first admin is created on a public address without a shared
// secret in the environment. While nobody has an account, the web server issues a random code at
// startup and logs a link with it (`crema setup-link` issues a fresh one). Only its SHA-256 is
// stored, so reading the database doesn't give the link away. It works once, for 24 hours, and a new one
// replaces the old. CREMA_SETUP_TOKEN, when set, keeps working as a fixed alternative.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";

const KEY = "setup_code";
const TTL_MS = 24 * 3600_000;
type Q = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;
const hash = (code: string) => createHash("sha256").update(code).digest("hex");

async function hasUsers(db: Q) {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "user"`)).rows[0].n > 0;
}

/** A new code (replacing any earlier one), or null once someone has an account. */
export async function issueSetupCode(db: Q): Promise<string | null> {
  if (await hasUsers(db)) return null;
  const code = randomBytes(24).toString("base64url");
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify({ hash: hash(code), at: new Date().toISOString() })]);
  return code;
}

/** Is this the current, unexpired code? */
export async function setupCodeMatches(db: Q, given: string | null | undefined): Promise<boolean> {
  if (!given) return false;
  const row = (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [KEY])).rows[0];
  if (!row) return false;
  const stored = JSON.parse(row.value) as { hash: string; at: string };
  if (Date.now() - Date.parse(stored.at) > TTL_MS) return false;
  const a = Buffer.from(hash(given)), b = Buffer.from(stored.hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Used: gone for good (the first admin exists now). */
export async function spendSetupCode(db: Q) {
  await db.query("DELETE FROM settings WHERE key = $1", [KEY]);
}

/**
 * In the fragment, not the query: a fragment never leaves the browser, so the code doesn't reach
 * proxies or access logs. The page moves it into memory and off the address bar.
 */
export const setupLink = (appUrl: string, code: string) => `${appUrl.replace(/\/$/, "")}/sign-in#setup=${encodeURIComponent(code)}`;

/** What the server prints at startup: the link, framed so it stands out in a log. */
export function setupBanner(appUrl: string, code: string) {
  return [
    "",
    "┌─ Crema has no admin yet ─────────────────────────────────────────",
    `│ Open this link to create the admin account (works once, for 24 hours):`,
    `│ ${setupLink(appUrl, code)}`,
    "│ Lost it? Restart, or run `crema setup-link`, for a new one.",
    "└──────────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}
