import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { MCP_INSTRUCTIONS, MCP_TOOLS, runTool } from "@/core/mcpTools";
import { crema } from "@/core/service";
import { authReady, MCP_RESOURCE } from "@/lib/auth";

// Remote MCP for Claude, ChatGPT, Cursor…: protocol 2026-07-28 only, OAuth 2.1 through Better Auth
// (client identity by CIMD), tokens bound to this resource and the metrics:read scope. Certified metrics only.
const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: "crema", version: "0.1.0" }, { instructions: MCP_INSTRUCTIONS });
  for (const t of MCP_TOOLS) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input }, (a: any) => runTool(() => t.run(crema(), a)));
  }
  return server;
}, { legacy: "reject" });

export const POST = async (req: Request) => {
  const auth = await authReady();
  return requireMcpAuth(auth, (request) => mcp.fetch(request), { resource: MCP_RESOURCE, requiredScopes: ["metrics:read"] })(req);
};
