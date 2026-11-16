// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/pi/agent.test.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACPAgentClient } from "./acp-agent.js";
import { CodexAppServerAgentClient } from "./codex-agent.js";
import { PiRpcAgentClient } from "./pi-agent.js";
import type { AgentClient, AgentSession, AgentStreamEvent, ClientOptions } from "../agent-sdk-types.js";
const fixture = fileURLToPath(new URL("../test-utils/fake-agent.mjs", import.meta.url));
let home: string;
let previousHome: string | undefined;
let sessions: AgentSession[];
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "baton-provider-test-")); previousHome = process.env.BATON_HOME; process.env.BATON_HOME = home; sessions = []; });
afterEach(async () => { await Promise.allSettled(sessions.map(session => session.close())); await rm(home, { recursive: true, force: true }); if (previousHome === undefined)
    delete process.env.BATON_HOME;
else
    process.env.BATON_HOME = previousHome; });
function client(kind: "codex" | "pi" | "acp"): AgentClient {
    const options: ClientOptions = { command: [process.execPath, fixture, kind], home, env: { BATON_HOME: home, FAKE_CAPTURE: join(home, "frames.jsonl") }, timeoutMs: 3000 };
    return kind === "codex" ? new CodexAppServerAgentClient(options) : kind === "pi" ? new PiRpcAgentClient(options) : new ACPAgentClient(options);
}
function eventsFor(session: AgentSession): AgentStreamEvent[] { const events: AgentStreamEvent[] = []; session.subscribe(event => events.push(event)); return events; }
async function until(events: AgentStreamEvent[], type: AgentStreamEvent["type"]): Promise<void> { await expect.poll(() => events.some(event => event.type === type), { timeout: 4000, interval: 10 }).toBe(true); }
async function frames(): Promise<Array<Record<string, unknown>>> { return (await readFile(join(home, "frames.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>); }
for (const kind of ["codex", "pi", "acp"] as const)
    describe(kind, () => {
        it("fetches catalogs and maps complete turns, text, reasoning, tools and usage", async () => {
            const provider = client(kind);
            const catalog = await provider.fetchCatalog();
            expect(catalog.models[0]?.id).toContain("fake-model");
            const session = await provider.createSession({ cwd: home, mcpServers: { baton: { type: "http", url: "http://127.0.0.1:7433/mcp/test" } }, systemPrompt: "baton-system", model: kind === "pi" ? "fake/fake-model" : "fake-model" });
            sessions.push(session);
            const events = eventsFor(session);
            session.subscribe(() => { throw new Error("consumer failure"); });
            const { turnId } = await session.startTurn("hello");
            await until(events, "turn_completed");
            expect(events.filter(event => event.type === "turn_started")).toHaveLength(1);
            expect(events.filter(event => event.type === "turn_completed")).toEqual([expect.objectContaining({ turnId })]);
            const timeline = events.filter(event => event.type === "timeline");
            expect(timeline.filter(event => event.item.type === "assistant_message").map(event => event.item.type === "assistant_message" ? event.item.text : "")).toEqual(["DONE"]);
            expect(timeline.some(event => event.item.type === "reasoning" && event.item.text === "thinking")).toBe(true);
            expect(timeline.some(event => event.item.type === "tool_call" && event.item.status === "completed" && event.item.detail.type === "shell" && event.item.detail.command === "echo hello")).toBe(true);
            expect(session.getPersistence()?.sessionId).toBe("fake-session");
            const captured = JSON.stringify(await frames());
            expect(captured).toContain(kind === "pi" ? "get_commands" : "127.0.0.1:7433");
            if (kind !== "pi")
                expect(captured).toContain("baton-system");
            else {
                // The extension receives injected tools and append-only system instructions.
                const files = await import("node:fs/promises");
                const runtimeDirs = (await files.readdir(home)).filter(name => name.startsWith("pi-runtime-"));
                const extension = await readFile(join(home, runtimeDirs[0]!, "baton.mjs"), "utf8");
                expect(extension).toContain("registerMcpServer");
                expect(extension).toContain("127.0.0.1:7433");
                expect(extension).toContain("baton-system");
            }
            if (kind !== "acp")
                expect(events.find(event => event.type === "turn_completed")).toMatchObject({ usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 } });
        });
        it("round-trips permissions and resumes using the persisted provider handle", async () => {
            const provider = client(kind);
            const session = await provider.createSession({ cwd: home });
            sessions.push(session);
            const events = eventsFor(session);
            await session.startTurn("permission");
            await until(events, "permission_requested");
            expect(session.pendingPermissions()).toHaveLength(1);
            const request = session.pendingPermissions()[0]!;
            await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "yes" });
            await until(events, "turn_completed");
            expect(session.pendingPermissions()).toEqual([]);
            expect(events.some(event => event.type === "permission_resolved")).toBe(true);
            const handle = session.getPersistence()!;
            await session.close();
            const resumed = await provider.resumeSession(handle, { cwd: home });
            sessions.push(resumed);
            expect(resumed.getPersistence()).toEqual(handle);
            if (kind !== "pi")
                expect(JSON.stringify(await frames())).toContain(kind === "codex" ? "thread/resume" : "session/load");
        });
        it("rejects overlapping turns and interrupts a held turn", async () => {
            const session = await client(kind).createSession({ cwd: home });
            sessions.push(session);
            const events = eventsFor(session);
            await session.startTurn("hold");
            await expect(session.startTurn("overlap")).rejects.toThrow("already active");
            await session.interrupt();
            await until(events, "turn_canceled");
            expect(session.pendingPermissions()).toEqual([]);
            if (kind === "codex")
                expect(JSON.stringify(await frames())).toContain("thread/backgroundTerminals/terminate");
            if (kind === "pi") {
                const calls = await frames();
                expect(calls.findIndex(frame => frame.type === "clear_queue")).toBeGreaterThanOrEqual(0);
                expect(calls.findIndex(frame => frame.type === "clear_queue")).toBeLessThan(calls.findIndex(frame => frame.type === "abort"));
            }
        });
        it("fails the active turn and reports an unexpected process death", async () => {
            const session = await client(kind).createSession({ cwd: home });
            sessions.push(session);
            const events = eventsFor(session);
            await session.startTurn("exit");
            await until(events, "closed");
            expect(events.some(event => event.type === "turn_failed")).toBe(true);
        });
        if (kind !== "acp")
            it("steers only the current turn", async () => {
                const session = await client(kind).createSession({ cwd: home });
                sessions.push(session);
                const events = eventsFor(session);
                expect(await session.steerActiveTurn?.("idle")).toBe(false);
                await session.startTurn("hold");
                expect(await session.steerActiveTurn?.("finish")).toBe(true);
                await until(events, "turn_completed");
                expect(events.filter(event => event.type === "turn_started")).toHaveLength(1);
            });
    });
describe("ACP hosted terminals", () => {
    it("executes terminal requests and releases the session cleanly", async () => {
        const session = await client("acp").createSession({ cwd: home });
        sessions.push(session);
        const events = eventsFor(session);
        await session.startTurn("terminal");
        await until(events, "turn_completed");
        expect(JSON.stringify(await frames())).toContain("terminalId");
        await session.close();
    });
});
describe("Pi MCP capabilities", () => {
    it("merges pi-mcp-adapter config and preserves global tools", async () => {
        const { mkdir } = await import("node:fs/promises");
        const agentDir = join(home, "pi-agent");
        await mkdir(agentDir);
        await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { existing: { command: "keep" } } }));
        const provider = new PiRpcAgentClient({ home, command: [process.execPath, fixture, "pi"], env: { BATON_HOME: home, FAKE_MCP: "adapter", PI_CODING_AGENT_DIR: agentDir } });
        const opened = await provider.createSession({ cwd: home, mcpServers: { baton: { type: "http", url: "http://127.0.0.1:7433/test", headers: { Authorization: "test" } } } });
        sessions.push(opened);
        const { readdir } = await import("node:fs/promises");
        const dir = (await readdir(home)).find(name => name.startsWith("pi-runtime-"))!;
        expect(JSON.parse(await readFile(join(home, dir, "mcp.json"), "utf8"))).toEqual({ mcpServers: { existing: { command: "keep" }, baton: { url: "http://127.0.0.1:7433/test", headers: { Authorization: "test" }, auth: false, oauth: false } } });
    });
    it("reports missing MCP capability and rejects injection with a useful diagnostic", async () => {
        const provider = new PiRpcAgentClient({ home, command: [process.execPath, fixture, "pi"], env: { BATON_HOME: home, FAKE_MCP: "none" } });
        await provider.fetchCatalog();
        expect(provider.capabilities.mcp).toBe(false);
        await expect(provider.createSession({ cwd: home, mcpServers: { baton: { type: "http", url: "http://127.0.0.1:7433/test" } } })).rejects.toThrow("Pi has no MCP support");
    });
});

describe("ACP session-free catalogs and elicitation", () => {
    it("never creates a session while probing, and uses session-free model RPC", async () => {
        const { ACP_AGENT_SPECS } = await import("../acp-spec.js");
        const provider = new ACPAgentClient({ home, command: [process.execPath, fixture, "acp"], spec: ACP_AGENT_SPECS.find(s => s.id === "cursor"), env: { BATON_HOME: home, FAKE_CAPTURE: join(home, "frames.jsonl") } });
        expect((await provider.fetchCatalog()).models[0]?.id).toBe("cursor-model");
        const calls = await frames();
        expect(calls.some(frame => frame.method === "initialize")).toBe(true);
        expect(calls.some(frame => frame.method === "cursor/list_available_models")).toBe(true);
        expect(calls.some(frame => frame.method === "session/new")).toBe(false);
    });
    it("scrubs inherited and configured Copilot allow-all settings from the real child", async () => {
        const { ACP_AGENT_SPECS } = await import("../acp-spec.js");
        const original = process.env.COPILOT_ALLOW_ALL;
        process.env.COPILOT_ALLOW_ALL = "1";
        try {
            const base = ACP_AGENT_SPECS.find(s => s.id === "copilot")!;
            const provider = new ACPAgentClient({ home, command: [process.execPath, fixture, "acp"], spec: { ...base, modelCatalogRpc: "fake/env" }, env: { BATON_HOME: home, COPILOT_ALLOW_ALL: "true" } });
            expect((await provider.fetchCatalog()).models[0]?.id).toBe("scrubbed");
        } finally { if (original === undefined) delete process.env.COPILOT_ALLOW_ALL; else process.env.COPILOT_ALLOW_ALL = original; }
    });
    it("routes form elicitation as a native question and returns schema content", async () => {
        const session = await client("acp").createSession({ cwd: home }); sessions.push(session);
        const events = eventsFor(session);
        await session.startTurn("form-elicitation");
        await until(events, "permission_requested");
        const question = session.pendingPermissions()[0]!;
        expect(question).toMatchObject({ kind: "question", name: "acp_elicitation", input: { questions: [{ id: "flavor" }] } });
        await session.respondToPermission(question.id, { behavior: "allow", updatedInput: { answers: { flavor: ["Vanilla"] } } });
        await until(events, "turn_completed");
        expect(await frames()).toContainEqual(expect.objectContaining({ result: { action: "accept", content: { flavor: "Vanilla" } } }));
    });
    it("shows URL elicitation only as a link notice, without granting consent", async () => {
        const session = await client("acp").createSession({ cwd: home }); sessions.push(session);
        const events = eventsFor(session);
        await session.startTurn("url-elicitation"); await until(events, "turn_completed");
        expect(events.some(e => e.type === "permission_requested")).toBe(false);
        expect(events.some(e => e.type === "timeline" && e.item.type === "notification" && e.item.message.includes("https://example.test/signin"))).toBe(true);
        expect(await frames()).toContainEqual(expect.objectContaining({ result: { action: "cancel" } }));
    });
});
