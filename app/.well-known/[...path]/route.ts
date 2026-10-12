import { authReady } from "@/lib/auth";

// OAuth discovery lives at the domain root (RFC 8414 / RFC 9728): /.well-known/oauth-protected-resource
// and /.well-known/oauth-authorization-server/api/auth. Better Auth answers them; anything else is 404.
export const GET = async (req: Request) => (await authReady()).handler(req);
export const HEAD = GET;
