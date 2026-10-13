import { CremaError } from "@/core/service";
import { handle } from "@/lib/http";

export const POST = handle(({ r, body, actor }) => {
  const id = Number(body.id);
  switch (body.action) {
    case "certify":
      return r.certify({ conceptId: id, candidateId: Number(body.candidateId), edits: body.edits, actor, note: body.note });
    case "reject":
      return r.reject(id, actor, body.reason);
    case "reopen":
      return r.reopen(id, actor);
    default:
      throw new CremaError("Unknown action.", 404);
  }
});
