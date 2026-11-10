import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BATON_TOOLS, type BatonToolName } from "@baton/protocol";
import type { Kernel } from "../kernel/index.js";
export async function handleMcp(kernel: Kernel, token: string, request: IncomingMessage, response: ServerResponse, body?: unknown): Promise<void> {
  const nodeId = kernel.identify(token);
  if (!nodeId) { response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid or expired node token" })); return; }
  const server = new McpServer({ name: "baton", version: "0.1.0" });
  for (const name of Object.keys(BATON_TOOLS) as BatonToolName[]) {
    if (kernel.store.snapshot(kernel.store.node(nodeId).runId).run.policy.mode === "solo" && name !== "ask_human") continue;
    const tool = BATON_TOOLS[name];
    server.registerTool(name, { description: tool.description, inputSchema: tool.input }, async (args: Record<string, unknown>) => {
      try {
        const output: unknown = await kernel.tool(nodeId, name, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
    });
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.once("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport); await transport.handleRequest(request, response, body);
}
