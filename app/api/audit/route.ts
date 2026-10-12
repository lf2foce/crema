import { handle } from "@/lib/http";

export const GET = handle(({ r, url }) => r.audit(Number(url.searchParams.get("limit") ?? 100)));
