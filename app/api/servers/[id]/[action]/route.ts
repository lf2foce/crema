import { CremaError } from "@/core/service";
import { handle } from "@/lib/http";

// Admin actions on one server: `check` (reachable, login still adequate), `name?db=` (is a database
// name free there) and `delete`.
export const GET = handle(({ r, body, url }) => {
  if (body.action === "check") return r.checkServer(Number(body.id));
  if (body.action === "name") return r.checkDbName(Number(body.id), url.searchParams.get("db") ?? "");
  throw new CremaError("Unknown action.", 404);
}, { admin: true });

export const POST = handle(({ r, body, actor }) => {
  if (body.action !== "delete") throw new CremaError("Unknown action.", 404);
  return r.removeServer(Number(body.id), actor);
}, { admin: true });
