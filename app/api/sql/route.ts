import { handle } from "@/lib/http";

// Read-only: one SELECT/WITH statement, at most 500 rows, inside a rolled-back READ ONLY transaction.
export const POST = handle(({ r, body }) => r.sql(String(body.sql ?? ""), body.limit ? Math.min(1000, Number(body.limit)) : undefined));
