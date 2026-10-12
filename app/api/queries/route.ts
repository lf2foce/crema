import { handle } from "@/lib/http";

export const GET = handle(({ r }) => r.queries());
export const POST = handle(({ r, body, actor }) => r.saveQuery({ id: body.id ?? null, name: body.name, sql: body.sql }, actor));
