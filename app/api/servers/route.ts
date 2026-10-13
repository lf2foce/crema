import { handle } from "@/lib/http";

// Postgres servers Crema creates databases on. Adding one takes an admin login: a superuser is used
// once to create Crema's own limited provisioner and isn't stored. `suggested` adds the server this
// installation offers (its bundled hosting server, or this machine in development).
export const GET = handle(({ r }) => r.servers(), { admin: true });
export const POST = handle(({ r, body, actor }) => body.suggested
  ? r.addSuggestedServer(actor)
  : r.addServer({ url: String(body.url ?? ""), name: body.name ?? null, publicHost: body.publicHost ?? null, ssl: typeof body.ssl === "boolean" ? body.ssl : null }, actor),
{ admin: true });
