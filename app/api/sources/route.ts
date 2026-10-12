import { CreamaError } from "@/core/service";
import { handle } from "@/lib/http";

// The workspace's databases. Adding one is an admin action: an external connection string, the demo,
// or a new hosted database Creama creates.
export const GET = handle(({ r }) => r.sources());
export const POST = handle(async ({ r, body, actor }) => {
  if (body.kind === "hosted") return { source: await r.createHosted(String(body.name ?? ""), actor) };
  const url = body.demo ? process.env.CREAMA_DEMO_URL : String(body.url ?? "").trim();
  if (!url) throw new CreamaError(body.demo ? "No demo database configured (CREAMA_DEMO_URL)." : "Paste a postgres:// connection string.");
  return r.addExternal(url, actor, body.demo ? "Demo (Lumen SaaS)" : body.name);
}, { admin: true });
