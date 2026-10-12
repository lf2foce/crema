import { handle } from "@/lib/http";

/** Certified metrics only. Proposals are never visible through the consumer API. */
export const GET = handle(async ({ r }) => ({ metrics: await r.listMetrics() }));
