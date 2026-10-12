import { googleEnabled, hasUsers } from "@/lib/auth";

// Public: lets the sign-in page offer first-time setup and the Google button. Reveals nothing else.
export const GET = async () => Response.json({ hasUsers: await hasUsers(), google: googleEnabled }, { headers: { "cache-control": "no-store" } });
