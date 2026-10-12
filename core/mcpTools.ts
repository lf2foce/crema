// The MCP surface, defined once: the stdio server (bin/creama.ts) and the remote, OAuth-protected
// one (/api/mcp) register exactly these. Read-only, certified metrics only.
import * as z from "zod";
import type { Creama } from "./service";

export const MCP_INSTRUCTIONS =
  "Creama serves business metrics whose definitions a named person has certified. " +
  "Use list_metrics to see what exists, then get_metric_values. Always report the number with its provenance " +
  "(\"v2, certified by …\"). If a metric the user asks about is not listed, say it has not been certified yet " +
  "instead of estimating it another way. If trust is \"drifted\", warn that the schema changed since certification.";

export const MCP_TOOLS = [
  {
    name: "list_metrics",
    title: "List certified metrics",
    description: "All certified business metrics: key, name, the question each answers, plain-language definition, unit, version and who certified it.",
    input: z.object({}),
    run: async (r: Creama) => (await r.listMetrics()).map(({ sql, latest, ...m }) => ({ ...m, latestValue: latest.value })),
  },
  {
    name: "get_metric_values",
    title: "Get metric values",
    description: "Compute a certified metric. Without grain: one value for the period (flow metrics) or as of `to` (snapshot metrics). With grain: a time series.",
    input: z.object({
      key: z.string().describe("Metric key from list_metrics"),
      from: z.string().optional().describe("ISO date, default 12 months ago"),
      to: z.string().optional().describe("ISO date, default now"),
      grain: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
      version: z.number().int().optional().describe("Pin a certified version; default latest"),
    }),
    run: (r: Creama, a: { key: string; from?: string; to?: string; grain?: "day" | "week" | "month" | "quarter" | "year"; version?: number }) =>
      r.query(a.key, { from: a.from, to: a.to, grain: a.grain ?? null, version: a.version }),
  },
  {
    name: "explain_metric",
    title: "Explain a metric",
    description: "The exact certified definition (SQL), its version history and audit trail. Use when the user asks how a number is calculated.",
    input: z.object({ key: z.string() }),
    run: (r: Creama, a: { key: string }) => r.getMetric(a.key),
  },
] as const;

/** Tool results as MCP content; errors become tool errors the model can read, not transport failures. */
export async function runTool(fn: () => Promise<unknown>) {
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
  try { return text(await fn()); } catch (e) { return { ...text((e as Error).message), isError: true }; }
}
