import { handle } from "@/lib/http";

/** Certified metrics only. Proposals are never visible through the consumer API. */
// production by default; ?development=1 adds metrics certified on development branches
export const GET = handle(async ({ r, url }) => ({ metrics: await r.listMetrics({ includeDevelopment: url.searchParams.get("development") === "1" }) }));
