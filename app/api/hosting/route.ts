import { handle } from "@/lib/http";

// Admin only: databases Creama creates for apps elsewhere.
export const GET = handle(({ r }) => r.hostedList(), { admin: true });
export const POST = handle(({ r, body, actor }) => r.createHosted(String(body.name ?? ""), actor), { admin: true });
