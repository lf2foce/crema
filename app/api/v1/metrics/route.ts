import { handle } from "@/lib/http";

/** Certified metrics only. Proposals are never visible through the consumer API. */
// production (and unlabelled) databases by default; ?all=1 adds staging and development branches
export const GET = handle(async ({ r, url }) => ({ metrics: await r.listMetrics({ includeNonProduction: url.searchParams.get("all") === "1" }) }));
