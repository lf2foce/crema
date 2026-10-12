import { CreamaError, type Grain } from "@/core/service";
import { handle } from "@/lib/http";

const GRAINS = ["day", "week", "month", "quarter", "year"];

export const GET = handle(async ({ r, body, url }) => {
  const q = url.searchParams;
  const grain = q.get("grain");
  if (grain && !GRAINS.includes(grain)) throw new CreamaError(`grain must be one of ${GRAINS.join(", ")}`);
  const format = q.get("format") ?? "json";
  if (format !== "json" && format !== "csv") throw new CreamaError("format must be json or csv");
  const version = q.get("version");
  const out = await r.query(body.key, {
    from: q.get("from") ?? undefined,
    to: q.get("to") ?? undefined,
    grain: (grain as Grain) || null,
    version: version ? Number(version) : undefined,
  });
  return format === "csv" ? csv(out) : out;
});

/** Spreadsheet-friendly: one row per period, provenance repeated on every row so a pasted range keeps it. */
function csv(out: unknown) {
  const o = out as { metric: string; version: number; trust: string; to: string; value?: number | null; points?: { start: string; value: number | null; partial?: boolean }[] };
  const rows = o.points
    ? o.points.map((p) => [p.start.slice(0, 10), p.value ?? "", p.partial ? "yes" : "no"])
    : [[o.to.slice(0, 10), o.value ?? "", "no"]];
  const lines = [["period", "value", "in_progress", "metric", "version", "trust"], ...rows.map((r) => [...r, o.metric, o.version, o.trust])];
  return new Response(lines.map((l) => l.join(",")).join("\n") + "\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `inline; filename="${o.metric}.csv"`, "cache-control": "no-store" },
  });
}
