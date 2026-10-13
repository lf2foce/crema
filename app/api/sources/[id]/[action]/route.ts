import { CremaError } from "@/core/service";
import { handle } from "@/lib/http";

// Admin actions on one database. `branch` makes a branch of a project's main database (copied by the
// worker), `reset` copies main into a branch again. `connection` shows a hosted database's login (owner = the app's,
// reader = Crema's read-only one).
export const GET = handle(({ r, body, url }) => {
  if (body.action !== "connection") throw new CremaError("Unknown action.", 404);
  return r.hostedConnection(Number(body.id), url.searchParams.get("role") === "reader" ? "reader" : "owner");
}, { admin: true });

export const POST = handle(({ r, body, actor }) => {
  const id = Number(body.id);
  switch (body.action) {
    case "reset-password": return r.resetHostedPassword(id, actor, body.role === "reader" ? "reader" : "owner");
    case "retry": return r.retryHosted(id, actor);
    case "branch": return r.createBranch(id, { branch: body.branch ?? null, copy: body.copy ?? null }, actor);
    case "reset": return r.resetBranch(id, actor, body.copy ?? null);
    case "delete": return r.removeSource(id, actor);
    default: throw new CremaError("Unknown action.", 404);
  }
}, { admin: true });
