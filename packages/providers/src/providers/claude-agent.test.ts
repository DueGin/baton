// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/claude/agent.test.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { text as readStreamText } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentClient, claudeCustomHeaders, type ClaudeQueryFactory } from "./claude-agent.js";
import type { AgentSession, AgentStreamEvent, SaveImage } from "../agent-sdk-types.js";
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
function setup(saveImage?: SaveImage, options: { env?: Record<string, string>; cliVersion?: string } = {}) {
    const messages = new Messages();
    let captured: Parameters<ClaudeQueryFactory>[0] | undefined;
    const generator = messages[Symbol.asyncIterator]();
    const query = Object.assign(generator, { supportedModels: vi.fn(async () => [{ value: "fake", displayName: "Fake", description: "", supportedEffortLevels: ["high"] }]), cancelAsyncMessage: vi.fn(async (_uuid: string) => true), interrupt: vi.fn(async () => { messages.push(result(0, true)); }), close: vi.fn(() => messages.end()) }) as unknown as Query;
    const factory: ClaudeQueryFactory = input => { captured = input; return query; };
    const client = new ClaudeAgentClient({ home, command: ["fake-claude"], queryFactory: factory, saveImage, ...options });
    return { client, messages, query, options: () => captured!.options!, input: () => captured!.prompt };
}
function result(cost = 0.01, failed = false): unknown { return { type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed, session_id: "claude-session", total_cost_usd: cost, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 4 }, modelUsage: { fake: { inputTokens: cost * 1000, cacheReadInputTokens: cost * 200, outputTokens: cost * 400, contextWindow: 10000 } }, errors: failed ? ["aborted"] : undefined }; }
async function wait(events: AgentStreamEvent[], type: AgentStreamEvent["type"]): Promise<void> { await expect.poll(() => events.some(event => event.type === type), { interval: 5 }).toBe(true); }
describe("Claude request headers", () => {
    const version = "2.1.322 (Claude Code)";
    const ua = "User-Agent: claude-cli/2.1.322 (external, cli)";
    it("uses the real CLI version", () => {
        expect(claudeCustomHeaders(undefined, version)).toBe(ua);
    });
    it("appends to existing headers", () => {
        const headers = "X-First: a\r\nX-Second: b\r\n";
        expect(claudeCustomHeaders(headers, version)).toBe(headers + ua);
    });
    it("preserves a user-supplied User-Agent without changing any bytes", () => {
        const headers = "X-First: a\r\n  uSeR-aGeNt : custom\r\n";
        expect(claudeCustomHeaders(headers, version)).toBe(headers);
    });
    it("leaves headers alone when the CLI version is absent or unparseable", () => {
        expect(claudeCustomHeaders(undefined, undefined)).toBeUndefined();
        expect(claudeCustomHeaders("X-First: a", "unavailable")).toBe("X-First: a");
    });
});
async function readClaudeChildEnv(options: Options): Promise<unknown> {
    const keys = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_AGENT_SDK_CLIENT_APP", "ANTHROPIC_CUSTOM_HEADERS"];
    const child = options.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: ["-e", `console.log(JSON.stringify(process.env, ${JSON.stringify(keys)}))`],
        cwd: home,
        env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "0.3.246", CLAUDE_AGENT_SDK_CLIENT_APP: "sdk-app" },
        signal: new AbortController().signal,
    });
    return JSON.parse(await readStreamText(child.stdout)) as unknown;
}
describe("Claude Code child environment", () => {
    const providerOverrides = {
        CLAUDE_CODE_ENTRYPOINT: "provider-entrypoint",
        CLAUDE_AGENT_SDK_VERSION: "provider-version",
        CLAUDE_AGENT_SDK_CLIENT_APP: "provider-app",
    };
    const sessionOverrides = { CLAUDE_CODE_ENTRYPOINT: "session-entrypoint", CLAUDE_AGENT_SDK_CLIENT_APP: "" };
    it.each([
        { name: "removes SDK metadata even without a version", expected: { CLAUDE_CODE_ENTRYPOINT: "cli" } },
        { name: "preserves explicit provider values and skips the automatic UA", cliVersion: "2.1.322", providerEnv: providerOverrides, expected: providerOverrides },
        { name: "lets session values override provider values", cliVersion: "2.1.322", providerEnv: providerOverrides, sessionEnv: sessionOverrides, expected: { ...providerOverrides, ...sessionOverrides } },
        { name: "appends the UA to inherited headers", cliVersion: "2.1.322 (Claude Code)", parentHeaders: "X-Inherited: ok", expected: { CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_CUSTOM_HEADERS: "X-Inherited: ok\nUser-Agent: claude-cli/2.1.322 (external, cli)" } },
        { name: "preserves an effective session UA", cliVersion: "2.1.322", parentHeaders: "X-Inherited: ok", providerEnv: { ANTHROPIC_CUSTOM_HEADERS: "X-Provider: ok" }, sessionEnv: { ANTHROPIC_CUSTOM_HEADERS: "X-Session: ok\nuser-agent: custom" }, expected: { CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_CUSTOM_HEADERS: "X-Session: ok\nuser-agent: custom" } },
    ])("$name", async ({ cliVersion, parentHeaders, providerEnv, sessionEnv, expected }) => {
        vi.stubEnv("CLAUDE_AGENT_SDK_CLIENT_APP", "parent-app");
        vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", parentHeaders);
        try {
            const fake = setup(undefined, { cliVersion, env: providerEnv });
            session = await fake.client.createSession({ cwd: home, env: sessionEnv });
            expect(await readClaudeChildEnv(fake.options())).toStrictEqual(expected);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
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
    it("withdraws both local and SDK-consumed steers before interrupt", async () => {
        const fake = setup();
        session = await fake.client.createSession({ cwd: home });
        await session.startTurn("first");
        await session.steerActiveTurn?.("sdk-queued");
        const input = fake.input();
        if (typeof input === "string") throw new Error("stream required");
        const iterator = input[Symbol.asyncIterator]();
        const first = (await iterator.next()).value;
        fake.messages.push({ type: "command_lifecycle", state: "started", command_uuid: first.uuid });
        const queued = (await iterator.next()).value;
        await new Promise(resolve => setTimeout(resolve, 0));
        await session.steerActiveTurn?.("local-queued");
        const query = fake.query as Query & { cancelAsyncMessage: ReturnType<typeof vi.fn> };
        await session.interrupt();
        expect(query.cancelAsyncMessage).toHaveBeenCalledExactlyOnceWith(queued.uuid);
        expect(query.cancelAsyncMessage.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fake.query.interrupt).mock.invocationCallOrder[0]!);
        await session.startTurn("next human turn");
        expect((await iterator.next()).value).toMatchObject({ message: { content: "next human turn" } });
    });
    it("does not withdraw a steer that Claude has already started", async () => {
        const fake = setup();
        session = await fake.client.createSession({ cwd: home });
        await session.startTurn("first");
        await session.steerActiveTurn?.("started");
        const input = fake.input();
        if (typeof input === "string") throw new Error("stream required");
        const iterator = input[Symbol.asyncIterator]();
        const first = (await iterator.next()).value;
        fake.messages.push({ type: "command_lifecycle", state: "started", command_uuid: first.uuid });
        const steer = (await iterator.next()).value;
        fake.messages.push({ type: "command_lifecycle", state: "started", command_uuid: steer.uuid });
        await new Promise(resolve => setTimeout(resolve, 0));
        await session.interrupt();
        expect((fake.query as Query & { cancelAsyncMessage: ReturnType<typeof vi.fn> }).cancelAsyncMessage).not.toHaveBeenCalled();
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

it("closes before interruption when an older SDK cannot recall consumed input", async () => {
    const fake = setup();
    Object.assign(fake.query, { cancelAsyncMessage: undefined });
    session = await fake.client.createSession({ cwd: home });
    await session.startTurn("queued but not announced");
    const input = fake.input();
    if (typeof input === "string") throw new Error("stream required");
    await input[Symbol.asyncIterator]().next();
    await session.interrupt();
    expect(fake.query.close).toHaveBeenCalledOnce();
    expect(fake.query.interrupt).not.toHaveBeenCalled();
    await expect(session.startTurn("must not revive")).rejects.toThrow("closed");
});
describe("Claude images", () => {
    it("sends image parts as base64 content blocks and records the text with path notes", async () => {
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"), path = join(home, "shot.png");
        await writeFile(path, png);
        const fake = setup();
        session = await fake.client.createSession({ cwd: home });
        const events: AgentStreamEvent[] = [];
        session.subscribe(event => events.push(event));
        await session.startTurn([{ type: "text", text: "look " }, { type: "image", path, mimeType: "image/png", name: "shot.png" }, { type: "text", text: " here" }]);
        const queued = await (fake.input() as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
        expect(queued.value?.message.content).toEqual([{ type: "text", text: "look " }, { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }, { type: "text", text: " here" }]);
        expect(events.find(event => event.type === "timeline")).toMatchObject({ item: { type: "user_message", text: `look [图片 shot.png: ${path}] here` } });
    });
    it("stores tool-result images as attachment refs before the turn ends", async () => {
        const saved: string[] = [];
        const fake = setup(async (data, mimeType, name) => { await delay(30); saved.push(String(data)); return { id: `att_${saved.length}`, mimeType, ...(name ? { name } : {}) }; });
        session = await fake.client.createSession({ cwd: home });
        const events: AgentStreamEvent[] = [];
        session.subscribe(event => events.push(event));
        await session.startTurn("read the screenshot");
        fake.messages.push({ type: "assistant", session_id: "claude-session", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/tmp/shots/screen.png" } }] } });
        fake.messages.push({ type: "user", tool_use_result: { type: "image", file: { base64: "SDKCOPY", type: "image/png" } }, message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "INLINE" } }] }] } });
        fake.messages.push(result());
        await wait(events, "turn_completed");
        const index = events.findIndex(event => event.type === "timeline" && event.item.type === "tool_call" && event.item.status === "completed");
        expect(index).toBeGreaterThan(-1);
        expect(index).toBeLessThan(events.findIndex(event => event.type === "turn_completed"));
        expect(events[index]).toMatchObject({ item: { callId: "read-1", images: [{ id: "att_1", mimeType: "image/png", name: "screen.png" }] } });
        // One image per result: the inline block wins over the SDK's structured copy.
        expect(saved).toEqual(["INLINE"]);
        expect(JSON.stringify(events)).not.toContain("SDKCOPY");
    });
});
