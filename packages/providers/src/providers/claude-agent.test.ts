// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/claude/agent.test.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentClient, type ClaudeQueryFactory } from "./claude-agent.js";
import type { AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
class Messages implements AsyncIterable<SDKMessage> {
    private values: SDKMessage[] = [];
    private wake?: () => void;
    private ended = false;
    push(value: unknown): void { this.values.push(value as SDKMessage); this.wake?.(); }
    end(): void { this.ended = true; this.wake?.(); }
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
        while (!this.ended) {
            const value = this.values.shift();
            if (value) {
                yield value;
                continue;
            }
            await new Promise<void>(resolve => { this.wake = resolve; });
        }
    }
}
let home: string;
let session: AgentSession | undefined;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "baton-claude-test-")); });
afterEach(async () => { await session?.close(); session = undefined; await rm(home, { recursive: true, force: true }); });
function setup() {
    const messages = new Messages();
    let captured: Parameters<ClaudeQueryFactory>[0] | undefined;
    const generator = messages[Symbol.asyncIterator]();
    const query = Object.assign(generator, { supportedModels: vi.fn(async () => [{ value: "fake", displayName: "Fake", description: "", supportedEffortLevels: ["high"] }]), interrupt: vi.fn(async () => { messages.push(result(0, true)); }), close: vi.fn(() => messages.end()) }) as unknown as Query;
    const factory: ClaudeQueryFactory = input => { captured = input; return query; };
    const client = new ClaudeAgentClient({ home, command: ["fake-claude"], queryFactory: factory });
    return { client, messages, query, options: () => captured!.options!, input: () => captured!.prompt };
}
function result(cost = 0.01, failed = false): unknown { return { type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed, session_id: "claude-session", total_cost_usd: cost, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 4 }, modelUsage: { fake: { inputTokens: cost * 1000, cacheReadInputTokens: cost * 200, outputTokens: cost * 400, contextWindow: 10000 } }, errors: failed ? ["aborted"] : undefined }; }
async function wait(events: AgentStreamEvent[], type: AgentStreamEvent["type"]): Promise<void> { await expect.poll(() => events.some(event => event.type === type), { interval: 5 }).toBe(true); }
describe("Claude SDK client", () => {
    it("passes MCP, append system prompt, thinking and env through SDK options", async () => {
        const fake = setup();
        const mcpServers = { baton: { type: "http" as const, url: "http://127.0.0.1:7433/mcp/test" } };
        session = await fake.client.createSession({ cwd: home, mcpServers, systemPrompt: "delegate tools", modeId: "plan", thinking: "high", env: { BATON_HOME: home } });
        expect(fake.options()).toMatchObject({ cwd: home, mcpServers, permissionMode: "plan", systemPrompt: { type: "preset", preset: "claude_code", append: "delegate tools" }, effort: "high", thinking: { type: "adaptive" }, env: { BATON_HOME: home } });
        const events: AgentStreamEvent[] = [];
        session.subscribe(event => events.push(event));
        await session.startTurn("hello");
        fake.messages.push({ type: "system", subtype: "init", session_id: "claude-session", model: "fake" });
        fake.messages.push({ type: "stream_event", session_id: "claude-session", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } });
        fake.messages.push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "thought" } } });
        fake.messages.push({ type: "assistant", message: { content: [{ type: "text", text: "hello" }, { type: "thinking", thinking: "thought" }, { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "echo hi" } }] } });
        fake.messages.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "hi" }] } });
        fake.messages.push(result());
        await wait(events, "turn_completed");
        const items = events.filter(event => event.type === "timeline").map(event => event.item);
        expect(items.filter(item => item.type === "assistant_message")).toEqual([{ type: "assistant_message", text: "hello" }]);
        expect(items.filter(item => item.type === "reasoning")).toEqual([{ type: "reasoning", text: "thought" }]);
        expect(items.find(item => item.type === "tool_call" && item.status === "completed")).toMatchObject({ detail: { type: "shell", command: "echo hi", output: "hi" } });
        expect(session.getPersistence()).toEqual({ provider: "claude", sessionId: "claude-session" });
        await session.startTurn("again");
        fake.messages.push(result(0.015));
        await expect.poll(() => events.filter(event => event.type === "turn_completed").length).toBe(2);
        const last = events.filter(event => event.type === "turn_completed").at(-1);
        expect(last).toMatchObject({ usage: { inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 } });
        if (last?.type === "turn_completed")
            expect(last.usage?.totalCostUsd).toBeCloseTo(0.005);
    });
    it("round-trips permissions with edited input and emits denial resolution", async () => {
        const fake = setup();
        session = await fake.client.createSession({ cwd: home });
        const events: AgentStreamEvent[] = [];
        session.subscribe(event => events.push(event));
        await session.startTurn("permission");
        const canUseTool = fake.options().canUseTool!;
        const response = canUseTool("Bash", { command: "echo hi" }, { toolUseID: "p-1", requestId: "r-1", signal: new AbortController().signal });
        await wait(events, "permission_requested");
        expect(session.pendingPermissions()[0]).toMatchObject({ id: "p-1", detail: { type: "shell", command: "echo hi" } });
        await session.respondToPermission("p-1", { behavior: "allow", updatedInput: { command: "echo edited" } });
        await expect(response).resolves.toEqual({ behavior: "allow", updatedInput: { command: "echo edited" } });
        const denied = canUseTool("Write", { file_path: "x" }, { toolUseID: "p-2", requestId: "r-2", signal: new AbortController().signal });
        await session.respondToPermission("p-2", { behavior: "deny", message: "no" });
        await expect(denied).resolves.toMatchObject({ behavior: "deny", message: "no" });
        expect(events.filter(event => event.type === "permission_resolved")).toHaveLength(2);
    });
    it("marks steering as next input without starting another turn, and interrupts", async () => {
        const fake = setup();
        session = await fake.client.createSession({ cwd: home });
        const events: AgentStreamEvent[] = [];
        session.subscribe(event => events.push(event));
        expect(await session.steerActiveTurn?.("idle")).toBe(false);
        await session.startTurn("hold");
        await session.steerActiveTurn?.("steer");
        const input = fake.input();
        if (typeof input === "string")
            throw new Error("Expected streaming input");
        const iterator = input[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toMatchObject({ message: { content: "hold" } });
        expect((await iterator.next()).value).toMatchObject({ message: { content: "steer" }, priority: "next" });
        await session.interrupt();
        expect(fake.query.interrupt).toHaveBeenCalledOnce();
        expect(events.filter(event => event.type === "turn_canceled")).toHaveLength(1);
    });
    it("resumes the SDK session and reads its model catalog", async () => {
        const fake = setup();
        session = await fake.client.resumeSession({ provider: "claude", sessionId: "resume-id" }, { cwd: home });
        expect(fake.options().resume).toBe("resume-id");
        await session.close();
        session = undefined;
        const catalog = setup();
        expect((await catalog.client.fetchCatalog()).models[0]).toMatchObject({ id: "fake", thinkingOptions: [{ id: "high", label: "high" }] });
        expect(catalog.query.close).toHaveBeenCalledOnce();
    });
    it("reports SDK result errors even when subtype is success", async () => {
        const fake = setup();
        session = await fake.client.createSession({ cwd: home });
        const events: AgentStreamEvent[] = [];
        session.subscribe(event => events.push(event));
        await session.startTurn("fail");
        fake.messages.push({ type: "result", subtype: "success", is_error: true, result: "provider refused" });
        await wait(events, "turn_failed");
        expect(events.find(event => event.type === "turn_failed")).toMatchObject({ error: "provider refused" });
    });
});
