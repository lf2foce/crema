"use client";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

// oauthProviderClient carries the signed OAuth query from the URL into sign-in and consent calls,
// so an MCP client's authorization continues after the person signs in.
export const authClient = createAuthClient({ plugins: [adminClient(), oauthProviderClient()] });

/** Better Auth answers some calls with where to go next (back to an MCP client, for example). */
export function nextUrl(data: unknown): string | null {
  const d = data as { url?: unknown; redirect_uri?: unknown; redirectURI?: unknown } | null;
  const u = d?.url ?? d?.redirect_uri ?? d?.redirectURI;
  return typeof u === "string" && u ? u : null;
}
