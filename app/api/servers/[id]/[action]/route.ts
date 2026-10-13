import { CreamaError } from "@/core/service";
import { handle } from "@/lib/http";

// Admin actions on one server: `check` (reachable, login still adequate) and `delete`.
export const GET = handle(({ r, body }) => {
  if (body.action !== "check") throw new CreamaError("Unknown action.", 404);
  return r.checkServer(Number(body.id));
}, { admin: true });

export const POST = handle(({ r, body, actor }) => {
  if (body.action !== "delete") throw new CreamaError("Unknown action.", 404);
  return r.removeServer(Number(body.id), actor);
}, { admin: true });
