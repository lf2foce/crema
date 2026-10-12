import { handle } from "@/lib/http";

export const POST = handle(({ r, body }) =>
  r.preview({ kind: body.kind, unit: body.unit, sql: String(body.sql ?? ""), membersSql: body.membersSql || null, memberTable: body.memberTable || null }),
);
