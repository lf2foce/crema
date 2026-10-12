import { authReady } from "@/lib/auth";

// Sign-in, sessions, admin invitations and the OAuth server for MCP clients (/api/auth/oauth2/*).
const handler = async (req: Request) => (await authReady()).handler(req);
export { handler as GET, handler as POST };
