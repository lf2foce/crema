import { handle } from "@/lib/http";

export const GET = handle(async ({ r, user }) => ({
  ...(await r.state()),
  me: user && { id: user.id, name: user.name, email: user.email, role: user.role ?? "user" },
  demoAvailable: Boolean(process.env.CREMA_DEMO_URL),
  tokenRequired: Boolean(process.env.CREMA_API_TOKEN),
  cwd: process.cwd(),
}));
