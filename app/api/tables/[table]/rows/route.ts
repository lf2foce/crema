import { handle } from "@/lib/http";

export const GET = handle(({ r, body, url }) => {
  const q = url.searchParams;
  return r.tableRows(decodeURIComponent(body.table), {
    limit: Number(q.get("limit") ?? 50),
    offset: Number(q.get("offset") ?? 0),
    order: q.get("order"),
    dir: q.get("dir"),
  });
});
