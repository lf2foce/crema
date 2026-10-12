// Who is signed in, and the OAuth server MCP clients (Claude, ChatGPT, Cursor…) authorise against.
// People: email + password, or Google when configured. The first account becomes the admin;
// after that, accounts exist only when an admin invites them (Google signs in invited emails).
import { betterAuth, APIError } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, jwt } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { database } from "@/core/db";

export const APP_URL = (process.env.APP_URL ?? "http://localhost:3300").replace(/\/$/, "");
export const MCP_RESOURCE = `${APP_URL}/api/mcp`;
export const MCP_SCOPES = ["openid", "profile", "email", "offline_access", "metrics:read"];
export const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

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
            const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "user"`);
            if (rows[0].n === 0) return { data: { ...user, role: "admin" } }; // the first account runs this instance
            if (ctx?.path === "/admin/create-user") return { data: user }; // an admin's invitation
            throw new APIError("FORBIDDEN", { message: "Creama is invite-only. Ask an admin to add your email." });
          },
        },
      },
    },
    plugins: [
      admin(),
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
const g = globalThis as unknown as { __creamaAuth?: { auth: Auth; ready: Promise<void> } };

/** The auth instance, with its tables created on first use (like the registry's migrations). */
export function getAuth(): Auth {
  return ensure().auth;
}
export async function authReady(): Promise<Auth> {
  const a = ensure();
  await a.ready;
  return a.auth;
}
function ensure() {
  if (!g.__creamaAuth) {
    const auth = createAuth();
    const ready = getMigrations(auth.options).then((m) => m.runMigrations());
    ready.catch(() => { g.__creamaAuth = undefined; });
    g.__creamaAuth = { auth, ready };
  }
  return g.__creamaAuth;
}

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
