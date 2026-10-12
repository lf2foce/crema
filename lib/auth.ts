// Who is signed in, and the OAuth server MCP clients (Claude, ChatGPT, Cursor…) authorise against.
// People: email + password, or Google when configured. The first account becomes the admin;
// after that, accounts exist only when an admin invites them (Google signs in invited emails).
import { randomUUID, timingSafeEqual } from "node:crypto";
import { betterAuth, APIError } from "better-auth";
import { admin, jwt, organization } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { database } from "@/core/db";

export const APP_URL = (process.env.APP_URL ?? "http://localhost:3300").replace(/\/$/, "");
export const MCP_RESOURCE = `${APP_URL}/api/mcp`;
export const MCP_SCOPES = ["openid", "profile", "email", "offline_access", "metrics:read"];
export const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

/**
 * Who may create the first (admin) account. On a public address anyone could claim an
 * uninitialised instance, so setup needs CREAMA_SETUP_TOKEN there; on localhost it's open
 * unless a token is set anyway.
 */
export function setupPolicy(): { tokenRequired: boolean; blocked: string | null } {
  const token = process.env.CREAMA_SETUP_TOKEN;
  const local = ["localhost", "127.0.0.1", "::1"].includes(new URL(APP_URL).hostname);
  if (token) return { tokenRequired: true, blocked: null };
  return local ? { tokenRequired: false, blocked: null } : { tokenRequired: true, blocked: "Set CREAMA_SETUP_TOKEN on the server to create the first account on a public address." };
}

function tokenMatches(given: string | null | undefined): boolean {
  const token = process.env.CREAMA_SETUP_TOKEN;
  if (!token || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createAuth() {
  if (!process.env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is not set. Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"");
  const pool = database().pool;
  const local = new URL(APP_URL);
  const trustedOrigins = [APP_URL];
  if (["localhost", "127.0.0.1"].includes(local.hostname)) trustedOrigins.push(APP_URL.replace(local.hostname, local.hostname === "localhost" ? "127.0.0.1" : "localhost"));

  return betterAuth({
    appName: "Creama",
    baseURL: APP_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: pool,
    trustedOrigins,
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    socialProviders: googleEnabled ? { google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET!, disableImplicitSignUp: true } } : {},
    // an invited email signing in with Google joins the same account
    account: { accountLinking: { enabled: true, trustedProviders: ["google"] } },
    session: { expiresIn: 14 * 86_400 },
    advanced: { cookiePrefix: "creama" },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (ctx?.path === "/admin/create-user") return { data: user }; // an admin's invitation
            const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "user"`);
            if (rows[0].n > 0) throw new APIError("FORBIDDEN", { message: "Creama is invite-only. Ask an admin to add your email." });
            // first account: check the setup token, then claim admin atomically — of two
            // simultaneous sign-ups only the one whose INSERT lands becomes admin
            const policy = setupPolicy();
            if (policy.blocked) throw new APIError("FORBIDDEN", { message: policy.blocked });
            const given = ctx?.headers?.get("x-creama-setup-token") ?? ctx?.request?.headers.get("x-creama-setup-token");
            if (policy.tokenRequired && !tokenMatches(given)) throw new APIError("FORBIDDEN", { message: "Wrong or missing setup token." });
            const claim = await pool.query(
              `INSERT INTO settings (key, value) VALUES ('admin_claimed', $1)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value
                 -- a claim whose account never got created (it failed after this point) can be retaken
                 WHERE NOT EXISTS (SELECT 1 FROM "user") AND settings.value::timestamptz < now() - interval '2 minutes'
               RETURNING key`, [new Date().toISOString()]);
            if (!claim.rowCount) throw new APIError("FORBIDDEN", { message: "Someone else is setting up this instance. Ask them to invite you." });
            return { data: { ...user, role: "admin" } };
          },
          // everyone belongs to the default workspace: the first account owns it
          after: async (user) => {
            const role = (user as { role?: string }).role === "admin"
              ? ((await pool.query(`SELECT 1 FROM "member" WHERE "organizationId" = 'default' AND role = 'owner'`)).rowCount ? "admin" : "owner")
              : "member";
            await pool.query(`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ($1, 'default', $2, $3, now())`, [randomUUID(), user.id, role]);
          },
        },
      },
    },
    plugins: [
      admin(),
      // workspaces: one "default" workspace for now (created by the base migration); the schema and
      // membership roles are ready for several, the UI to create and switch them comes later
      organization({ allowUserToCreateOrganization: false }),
      jwt(),
      // MCP 2026-07-28 only: clients identify themselves with CIMD (an HTTPS client_id URL);
      // no dynamic client registration.
      mcp({ loginPage: "/sign-in", consentPage: "/consent", resource: MCP_RESOURCE, scopes: MCP_SCOPES }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      nextCookies(),
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
const g = globalThis as unknown as { __creamaAuth?: Auth };

/** The auth instance without waiting for the schema: for tooling (bin/auth-schema.ts). */
export function getAuthUnmigrated(): Auth {
  return (g.__creamaAuth ??= createAuth());
}

/** The auth instance once Creama's migrations (which include Better Auth's tables) are applied. */
export async function authReady(): Promise<Auth> {
  await database().ready;
  return getAuthUnmigrated();
}
export const getAuth = getAuthUnmigrated;

export type SessionUser = { id: string; name: string; email: string; role?: string | null };

/** The signed-in person behind a request, or null. */
export async function sessionUser(headers: Headers): Promise<SessionUser | null> {
  const auth = await authReady();
  const s = await auth.api.getSession({ headers });
  return s ? { id: s.user.id, name: s.user.name, email: s.user.email, role: (s.user as { role?: string | null }).role ?? null } : null;
}

/** Has anyone set this instance up yet? Before that, the sign-in page offers to create the admin. */
export async function hasUsers(): Promise<boolean> {
  await authReady();
  const { rows } = await database().pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "user"`);
  return rows[0].n > 0;
}
