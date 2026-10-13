// End-to-end check of the remote MCP server against a running instance (not part of `pnpm test`):
// sign in → register a client → authorize + consent in a browser → token (PKCE, resource-bound)
// → MCP 2026-07-28 over HTTP with the official v2 client. Usage:
//   BASE=http://localhost:3211 EMAIL=… PASSWORD=… node test/mcp-oauth.e2e.mjs
import crypto from "node:crypto";
import { chromium } from "@playwright/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const B = process.env.BASE ?? "http://localhost:3211", RES = `${B}/api/mcp`, CB = "http://127.0.0.1:9876/cb";
const ok = (label, cond, extra = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`); if (!cond) process.exitCode = 1; };

const browser = await chromium.launch();
const page = await browser.newPage();
let code = null;
await page.route("http://127.0.0.1:9876/**", (r) => { code = new URL(r.request().url()).searchParams.get("code"); r.fulfill({ status: 200, body: "ok" }); });

await page.goto(`${B}/sign-in`);
await page.getByLabel("Email").fill(process.env.EMAIL); await page.getByLabel("Password").fill(process.env.PASSWORD);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));

// a public (PKCE) native client, registered by a signed-in person — no dynamic registration
const created = await (await page.request.post(`${B}/api/auth/oauth2/create-client`, { headers: { origin: B }, data: {
  client_name: "crema e2e", redirect_uris: [CB], token_endpoint_auth_method: "none", type: "native", application_type: "native",
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "openid metrics:read offline_access",
} })).json();
ok("client created", Boolean(created.client_id), created.client_id ? "" : JSON.stringify(created));

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
await page.goto(`${B}/api/auth/oauth2/authorize?` + new URLSearchParams({ response_type: "code", client_id: created.client_id, redirect_uri: CB,
  scope: "openid metrics:read offline_access", state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: RES, prompt: "consent" }));
await page.getByRole("button", { name: "Allow" }).waitFor();
ok("consent page lists the scopes", (await page.locator(".consent-list").innerText()).includes("Read certified metrics"));
await page.getByRole("button", { name: "Allow" }).click();
for (let i = 0; i < 50 && !code; i++) await page.waitForTimeout(100);
ok("authorization code issued", Boolean(code));
await browser.close();

const tok = await (await fetch(`${B}/api/auth/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: created.client_id, code_verifier: verifier, resource: RES }) })).json();
ok("access token", Boolean(tok.access_token), `scope "${tok.scope}", refresh ${Boolean(tok.refresh_token)}`);

const connect = async (token) => {
  const client = new Client({ name: "crema-e2e", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(RES), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
};
const client = await connect(tok.access_token);
const tools = (await client.listTools()).tools.map((t) => t.name);
ok("tools over MCP 2026-07-28", tools.join(",") === "list_metrics,get_metric_values,explain_metric", tools.join(", "));
const listed = await client.callTool({ name: "list_metrics", arguments: {} });
ok("list_metrics answers", !listed.isError, listed.content[0].text.slice(0, 80).replace(/\s+/g, " "));
await client.close();

const legacy = await fetch(RES, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok.access_token}`, "mcp-protocol-version": "2025-06-18" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } } }) });
const legacyBody = await legacy.text();
ok("2025-era requests rejected", /unsupported|protocol/i.test(legacyBody), `${legacy.status} ${legacyBody.slice(0, 120)}`);
const tampered = await fetch(RES, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.access_token.slice(0, -4)}AAAA` }, body: "{}" });
ok("tampered token refused", tampered.status === 401);
const anonymous = await fetch(RES, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
ok("no token → 401 with discovery hint", anonymous.status === 401 && /resource_metadata=/.test(anonymous.headers.get("www-authenticate") ?? ""));
