import { handle } from "@/lib/http";

export const POST = handle(async ({ r, body, actor }) => ({ runId: await r.startDiscovery({ hint: body.hint || null, focus: body.focus || null, actor }) }));
