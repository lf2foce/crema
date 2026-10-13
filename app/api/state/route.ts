import { DEMO_NAME } from "@/core/service";
import { handle } from "@/lib/http";

export const GET = handle(async ({ r, user }) => {
  const state = await r.state();
  return {
    ...state,
    me: user && { id: user.id, name: user.name, email: user.email, role: user.role ?? "user" },
    // the demo is offered while it's configured and not connected yet
    demoAvailable: Boolean(process.env.CREMA_DEMO_URL) && !state.sources.some((s) => s.projectName === DEMO_NAME),
    tokenRequired: Boolean(process.env.CREMA_API_TOKEN),
    cwd: process.cwd(),
  };
});
