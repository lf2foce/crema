import { handle } from "@/lib/http";

export const GET = handle(({ r, body }) => r.getMetric(body.key));
