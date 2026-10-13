import { googleEnabled, hasUsers, setupPolicy } from "@/lib/auth";

// Public: lets the sign-in page offer first-time setup (and whether it needs a setup code: the
// one-time link from the server log, or CREMA_SETUP_TOKEN) and the Google button.
export const GET = async () => {
  try {
    const users = await hasUsers();
    const policy = setupPolicy();
    return Response.json({ hasUsers: users, google: googleEnabled, setupCode: !users && policy.codeRequired, fixedToken: policy.fixedToken }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // e.g. the schema is behind (production doesn't migrate itself): say so instead of a blank page
    return Response.json({ error: (e as Error).message }, { status: 503, headers: { "cache-control": "no-store" } });
  }
};
