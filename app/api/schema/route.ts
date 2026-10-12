import { handle } from "@/lib/http";

export const GET = handle(({ r }) => r.schemaMap());
