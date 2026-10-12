import { handle } from "@/lib/http";

// One certified metric: its contract, version history and audit trail.
export const GET = handle(({ r, body }) => r.getMetric(`${body.source}/${body.key}`));
