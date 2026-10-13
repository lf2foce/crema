import { handle } from "@/lib/http";

// Postgres servers Creama creates databases on. Adding one takes an admin login: a superuser is used
// once to create Creama's own limited provisioner and isn't stored. `local` (development only) adds
// the server in DATABASE_URL.
export const GET = handle(({ r }) => r.servers(), { admin: true });
export const POST = handle(({ r, body, actor }) => body.local
  ? r.addLocalServer(actor)
  : r.addServer({ url: String(body.url ?? ""), name: body.name ?? null, publicHost: body.publicHost ?? null, ssl: typeof body.ssl === "boolean" ? body.ssl : null }, actor),
{ admin: true });
