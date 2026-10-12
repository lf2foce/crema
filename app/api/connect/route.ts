import { CreamaError } from "@/core/service";
import { handle } from "@/lib/http";

export const POST = handle(({ r, body, actor }) => {
  const url = body.demo ? process.env.CREAMA_DEMO_URL : String(body.url ?? "").trim();
  if (!url) throw new CreamaError(body.demo ? "No demo database configured (CREAMA_DEMO_URL)." : "Paste a postgres:// connection string.");
  return r.connect(url, actor);
}, { admin: true });

export const DELETE = handle(({ r, actor }) => r.disconnect(actor), { admin: true });
