import { handle } from "@/lib/http";

export const DELETE = handle(({ r, body, actor }) => r.deleteQuery(Number(body.id), actor));
