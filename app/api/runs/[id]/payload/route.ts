import { handle } from "@/lib/http";

// Exactly what was sent to the model for this run.
export const GET = handle(async ({ r, body }) => (await r.run(Number(body.id))).sentToModel);
