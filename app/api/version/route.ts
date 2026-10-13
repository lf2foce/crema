// The id of the build this server runs. Public and tiny: the page compares it with its own.
export const dynamic = "force-dynamic";
export const GET = () => Response.json({ build: process.env.NEXT_PUBLIC_CREMA_BUILD ?? null }, { headers: { "cache-control": "no-store" } });
