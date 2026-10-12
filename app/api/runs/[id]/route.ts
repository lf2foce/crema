import { handle } from "@/lib/http";

export const GET = handle(async ({ r, body }) => {
  const { sentToModel, ...run } = await r.run(Number(body.id));
  return run;
});
