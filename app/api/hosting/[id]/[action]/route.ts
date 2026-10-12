import { CreamaError } from "@/core/service";
import { handle } from "@/lib/http";

export const POST = handle(({ r, body, actor }) => {
  const id = Number(body.id);
  switch (body.action) {
    case "reset-password": return r.resetHostedPassword(id, actor, body.role === "reader" ? "reader" : "owner");
    case "use": return r.useHosted(id, actor);
    case "delete": return r.deleteHosted(id, actor);
    default: throw new CreamaError("Unknown action.", 404);
  }
}, { admin: true });

// Connection details for one login (owner = the app's, reader = Creama's read-only one).
export const GET = handle(({ r, body, url }) => {
  if (body.action !== "connection") throw new CreamaError("Unknown action.", 404);
  return r.hostedConnection(Number(body.id), url.searchParams.get("role") === "reader" ? "reader" : "owner");
}, { admin: true });
