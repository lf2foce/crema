#!/usr/bin/env -S npx tsx
// Crema CLI and MCP server. Same domain core as the web app; no HTTP involved.
//   crema connect <postgres-url> [--name "..."]          add a database (a source) to the workspace
//   crema sources
//   crema discover [--source slug] [--hint "..."] [--focus "metric name"]
//   crema list
//   crema query <source/key> [--from 2026-01-01] [--to ...] [--grain month] [--version 1] [--json]
//   crema audit
//   crema mcp            # stdio MCP server exposing certified metrics only
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env.local", ".env"]) {
  const p = resolve(root, f);
  if (existsSync(p)) process.loadEnvFile(p);
}

const { Crema, CremaError } = await import("../core/service");
const { display } = await import("../core/format");
const { closePools } = await import("../core/warehouse");
const { closeDatabases } = await import("../core/db");

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const k = rest[i].slice(2);
    flags[k] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
  } else args.push(rest[i]);
}

const r = new Crema();
/** The source a command acts on: --source, or the only/first one in the workspace. */
async function pick() {
  if (flags.source) return r.withSource(flags.source);
  const [first] = await r.reg.sources(r.scope.workspaceId);
  if (!first) throw new CremaError("No database yet: run `crema connect <postgres-url>` first.");
  return r.withSource(first.id);
}
const out = (s = "") => process.stdout.write(s + "\n");

async function main() {
  switch (cmd) {
    case "connect": {
      if (!args[0]) throw new CremaError("Usage: crema connect <postgres-url>");
      const c = await r.addExternal(args[0], process.env.USER ?? "cli", flags.name);
      out(`Added ${c.source.name} as “${c.source.slug}” · ${c.display} · ${c.tables} tables · ${c.readOnlyRole || !c.writableTables ? "read-only role" : `role can write to ${c.writableTables} tables (Crema only reads)`}`);
      return;
    }
    case "sources": {
      for (const s of await r.sources()) out(`${s.slug.padEnd(24)} ${s.kind.padEnd(9)} ${s.status.padEnd(13)} ${String(s.metrics).padStart(3)} metrics  ${s.name}`);
      return;
    }
    case "discover": {
      const src = await pick();
      const id = await src.startDiscovery({ hint: flags.hint, focus: flags.focus, actor: process.env.USER ?? "cli" });
      out(`Discovery ${id} queued durably. Run pnpm worker in another terminal, then review progress and certify in the web app.`);
      return;
    }
    case "list": {
      const ms = await r.listMetrics();
      if (!ms.length) return out("No certified metrics yet. Run `crema discover`, then certify proposals in the web app.");
      for (const m of ms) out(`${m.ref.padEnd(36)} ${display(m.latest.value, m.unit).padStart(10)}  v${m.version} · ${m.certifiedBy} · ${m.name}`);
      return;
    }
    case "query": {
      if (!args[0]) throw new CremaError("Usage: crema query <source/key> [--from] [--to] [--grain day|week|month|quarter|year] [--version n]");
      const res: any = await r.query(args[0], { from: flags.from, to: flags.to, grain: (flags.grain as any) ?? null, version: flags.version ? Number(flags.version) : undefined });
      if (flags.json) return out(JSON.stringify(res, null, 2));
      out(`${res.name} (${res.metric}) · v${res.version} certified by ${res.certifiedBy}`);
      if (res.points) for (const p of res.points) out(`  ${p.start.slice(0, 10)}  ${display(p.value, res.unit, { compact: false }).padStart(14)}`);
      else out(`  ${display(res.value, res.unit, { compact: false })}  (${res.from.slice(0, 10)} → ${res.to.slice(0, 10)})`);
      return;
    }
    case "audit": {
      for (const e of (await r.audit(Number(flags.limit ?? 50))).reverse()) out(`${e.at.slice(0, 19).replace("T", " ")}  ${e.actor.padEnd(12)} ${e.action.padEnd(20)} ${e.subject}`);
      return;
    }
    case "mcp":
      return mcp();
    default:
      out("Usage: crema <connect|sources|discover|list|query|audit|mcp> ...");
  }
}

async function mcp() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { MCP_INSTRUCTIONS, MCP_TOOLS, runTool } = await import("../core/mcpTools");

  const server = new McpServer({ name: "crema", version: "0.1.0" }, { instructions: MCP_INSTRUCTIONS });
  for (const t of MCP_TOOLS) {
    // the v1 SDK takes the raw zod shape
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input.shape }, (a: any) => runTool(() => t.run(r, a)));
  }

  await server.connect(new StdioServerTransport());
}

try {
  await main();
  if (cmd !== "mcp") { await (await import("../core/jobs")).closeJobs(); await closePools(); await closeDatabases(); }
} catch (e) {
  process.stderr.write(`${e instanceof CremaError ? "" : "Error: "}${(e as Error).message}\n`);
  await (await import("../core/jobs")).closeJobs();
  await closePools();
  await closeDatabases();
  process.exit(1);
}
