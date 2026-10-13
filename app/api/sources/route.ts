import { CremaError, DEMO_NAME } from "@/core/service";
import { handle } from "@/lib/http";

// The workspace's databases. Adding one is an admin action: an external connection string, the demo,
// or a new hosted database Crema creates on one of the workspace's servers.
export const GET = handle(({ r }) => r.sources());
export const POST = handle(async ({ r, body, actor }) => {
  if (body.kind === "hosted") return { source: await r.createHosted(String(body.name ?? ""), actor, body.serverId ? Number(body.serverId) : null, body.dbName ? String(body.dbName) : null, body.withDevelopment === true) };
  const url = body.demo ? process.env.CREMA_DEMO_URL : String(body.url ?? "").trim();
  if (!url) throw new CremaError(body.demo ? "No demo database configured (CREMA_DEMO_URL)." : "Paste a postgres:// connection string.");
  return r.addExternal(url, actor, body.demo ? DEMO_NAME : body.name);
}, { admin: true });
