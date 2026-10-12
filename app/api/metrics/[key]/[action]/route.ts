import { CreamaError } from "@/core/service";
import { handle } from "@/lib/http";

export const POST = handle(({ r, body, actor }) => {
  switch (body.action) {
    case "revise":
      return r.revise({ key: body.key, edits: body.edits ?? {}, actor, note: body.note });
    case "deprecate":
      return r.deprecate(body.key, actor, body.reason);
    default:
      throw new CreamaError("Unknown action.", 404);
  }
});
