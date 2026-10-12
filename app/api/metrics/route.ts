import { handle } from "@/lib/http";

// A metric written by hand: same verification and audit trail as an AI-proposed one.
export const POST = handle(({ r, body, actor }) => r.create({ edits: body.edits ?? {}, actor, note: body.note }));
