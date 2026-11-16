/** Opt-in real CLIs + network. Run: npx tsx packages/server/scripts/smoke-drivers.ts [agent-id ...] */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createPaseoDriverRegistry } from "../src/driver/paseo-adapter.js";
import type { DriverEvent, DriverSession } from "../src/driver/types.js";
const requested = process.argv.slice(2);
const agentIds = requested.length ? requested : ["claude", "codex", "pi"];

const home = await mkdtemp(join(tmpdir(), "baton-driver-smoke-"));
const previousHome = process.env.BATON_HOME;
process.env.BATON_HOME = home;
const registry = createPaseoDriverRegistry({ home });
let failures = 0;
try {
    const entries = await registry.detect();
    assert(agentIds.every(id => entries.some(entry => entry.id === id)), `Unknown agent ID. Available IDs: ${entries.map(entry => entry.id).join(", ")}`);
    for (const id of agentIds) {
        const entry = entries.find(candidate => candidate.id === id);
        if (entry?.status !== "ready") {
            console.log(`${id}: SKIP (${entry?.diagnostic ?? "not detected"})`);
            if (requested.length)
                failures++;
            continue;
        }
        const started = performance.now();
        const cwd = await mkdtemp(join(home, `${id}-cwd-`));
        let session: DriverSession | undefined;
        const pings: string[] = [];
        const resources = new Set<McpServer>();
        const server = createServer((request, response) => {
            void (async () => {
                if (request.url !== "/mcp") {
                    response.writeHead(404).end();
                    return;
                }
                const mcp = new McpServer({ name: "baton-driver-smoke", version: "0.1.0" });
                resources.add(mcp);
                mcp.registerTool("ping", { description: "Echo text for the baton driver smoke test.", inputSchema: { text: z.string() } }, async ({ text }) => {
                    pings.push(text);
                    return { content: [{ type: "text", text }] };
                });
                const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
                response.on("close", () => { resources.delete(mcp); void mcp.close().catch(() => { }); });
                await mcp.connect(transport);
                await transport.handleRequest(request, response);
            })().catch(error => { console.error(`${id}: MCP request failed`, error); if (!response.headersSent)
                response.writeHead(500).end();
            else
                response.end(); });
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}/mcp`;
        let unsubscribe: (() => void) | undefined;
        try {
            session = await registry.get(id)!.open({ cwd, mcpServers: { baton: { type: "http", url } }, systemPrompt: "This is a driver integration test. Use the injected baton MCP ping tool when asked." });
            const openedMs = performance.now() - started;
            const events: DriverEvent[] = [];
            let timer: NodeJS.Timeout | undefined;
            const activeSession = session;
            const completed = new Promise<DriverEvent>((resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Smoke turn timed out after 180s")), 180000);
                unsubscribe = activeSession.subscribe(event => {
                    events.push(event);
                    if (event.type === "permission_requested")
                        void activeSession.respondToPermission(event.request.id, { behavior: "allow" }).catch(reject);
                    if (event.type === "turn_completed")
                        resolve(event);
                    if (event.type === "turn_failed")
                        reject(new Error(event.error));
                    if (event.type === "turn_canceled" || event.type === "closed")
                        reject(new Error(`Session stopped: ${JSON.stringify(event)}`));
                });
            });
            // Attach before submitting the turn so a synchronous launch error is handled too.
            void completed.catch(() => { });
            let result: DriverEvent;
            try {
                await session.startTurn('Call the baton MCP tool ping with text "hello" exactly once, then reply with exactly DONE.');
                result = await completed;
            }
            finally {
                clearTimeout(timer);
            }
            assert(events.some(event => event.type === "item" && event.item.type === "tool_call"), "Expected a tool_call timeline item");
            assert(pings.includes("hello"), "MCP server did not receive ping(hello)");
            const answer = events.filter(event => event.type === "item" && event.item.type === "assistant_message").map(event => event.type === "item" && event.item.type === "assistant_message" ? event.item.text : "").join("");
            assert(answer.includes("DONE"), `Expected DONE, received ${JSON.stringify(answer)}`);
            console.log(JSON.stringify({ agent: id, status: "PASS", openMs: Math.round(openedMs), totalMs: Math.round(performance.now() - started), usage: result.type === "turn_completed" ? result.usage : undefined, pings }));
        }
        catch (error) {
            failures++;
            console.error(`${id}: FAIL`, error);
        }
        finally {
            unsubscribe?.();
            await session?.close();
            await Promise.allSettled([...resources].map(mcp => mcp.close()));
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }
}
finally {
    await registry.shutdown();
    await rm(home, { recursive: true, force: true });
    if (previousHome === undefined)
        delete process.env.BATON_HOME;
    else
        process.env.BATON_HOME = previousHome;
}
if (failures)
    process.exitCode = 1;
