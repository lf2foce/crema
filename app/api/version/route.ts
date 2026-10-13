// The id of the build this server runs, and the commit it came from. Public and tiny: the page
// compares the build with its own; CI waits for the commit after a deploy.
export const dynamic = "force-dynamic";
export const GET = () => Response.json({ build: process.env.NEXT_PUBLIC_CREMA_BUILD ?? null, commit: process.env.CREMA_COMMIT || null }, { headers: { "cache-control": "no-store" } });
