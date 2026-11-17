import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentClient, type ClaudeQueryFactory } from "./claude-agent.js";
import { claudeProjectDir, lastAssistantEntry, parseClaudeRewindPoint, revertClaudeConversation, type ClaudeRewindSdk } from "./claude/rewind.js";
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
            if (value) { yield value; continue; }
            await new Promise<void>(resolve => { this.wake = resolve; });
        }
    }
}
let home: string, config: string;
let session: AgentSession | undefined;
beforeEach(async () => { home = await realpath(await mkdtemp(join(tmpdir(), "baton-claude-rewind-"))); config = join(home, "claude-config"); });
afterEach(async () => { await session?.close(); session = undefined; await rm(home, { recursive: true, force: true }); });
const result = { type: "result", subtype: "success", is_error: false, session_id: "s1", total_cost_usd: 0, usage: {} };
function setup(sdk: ClaudeRewindSdk) {
    const messages = new Messages();
    const generator = messages[Symbol.asyncIterator]();
    const query = Object.assign(generator, { supportedModels: vi.fn(async () => []), interrupt: vi.fn(async () => {}), close: vi.fn(() => messages.end()) }) as unknown as Query;
    const factory: ClaudeQueryFactory = () => query;
    return { client: new ClaudeAgentClient({ home, command: ["fake-claude"], queryFactory: factory, rewindSdk: sdk, env: { CLAUDE_CONFIG_DIR: config } }), messages };
}
async function turn(s: AgentSession, messages: Messages, events: AgentStreamEvent[], prompt: string, assistant: string): Promise<void> {
    const done = events.filter(event => event.type === "turn_completed").length;
    await s.startTurn(prompt);
    messages.push({ type: "assistant", uuid: assistant, session_id: "s1", message: { content: [{ type: "text", text: `re: ${prompt}` }] } });
    messages.push({ type: "assistant", uuid: `side-${assistant}`, isSidechain: true, parent_tool_use_id: "task", session_id: "s1", message: { content: [] } });
    messages.push(result);
    await expect.poll(() => events.filter(event => event.type === "turn_completed").length).toBe(done + 1);
}

describe("Claude conversation rewind", () => {
    it("records the fork point before each prompt and forks the session through the SDK", async () => {
        const fork = vi.fn(async (_sessionId: string, _options: { upToMessageId: string; transcriptPath: string }) => ({ sessionId: "s2" }));
        const fake = setup({ forkSession: fork });
        session = await fake.client.createSession({ cwd: home });
        const events: AgentStreamEvent[] = [];
        session.subscribe(event => events.push(event));
        // The first prompt has nothing before it: rewinding there starts a fresh session.
        await turn(session, fake.messages, events, "one", "a1");
        expect(session.rewindPoint!()).toEqual({ sessionId: null, forkAt: null });
        await turn(session, fake.messages, events, "two", "a2");
        expect(session.rewindPoint!()).toEqual({ sessionId: "s1", forkAt: "a1" });
        const point = session.rewindPoint!();
        await turn(session, fake.messages, events, "three", "a3");
        expect(session.rewindPoint!()).toEqual({ sessionId: "s1", forkAt: "a2" });
        await session.rewindConversation!(point!);
        expect(fork).toHaveBeenCalledWith("s1", { upToMessageId: "a1", transcriptPath: join(await claudeProjectDir(home, config), "s1.jsonl") });
        expect(session.getPersistence()).toEqual({ provider: "claude", sessionId: "s2" });
        await session.rewindConversation!({ sessionId: null, forkAt: null });
        expect(session.getPersistence()).toBeNull();
    });

    it("reads the fork point of a resumed session from its transcript", async () => {
        const fake = setup({ forkSession: vi.fn() });
        const dir = await claudeProjectDir(home, config);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "old.jsonl"), [
            { type: "user", uuid: "u1", message: { content: "hi" } },
            { type: "assistant", uuid: "a1", message: { content: [] } },
            { type: "assistant", uuid: "sub", isSidechain: true, message: { content: [] } },
            "not json",
            { type: "system", uuid: "x" },
        ].map(entry => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n"));
        expect(await lastAssistantEntry(join(dir, "old.jsonl"))).toBe("a1");
        session = await fake.client.resumeSession({ provider: "claude", sessionId: "old" }, { cwd: home });
        await session.startTurn("continue");
        expect(session.rewindPoint!()).toEqual({ sessionId: "old", forkAt: "a1" });
    });

    it("cannot point at an unreadable transcript, and validates points", async () => {
        const fake = setup({ forkSession: vi.fn() });
        session = await fake.client.resumeSession({ provider: "claude", sessionId: "missing" }, { cwd: home });
        await session.startTurn("continue");
        expect(session.rewindPoint!()).toBeNull();
        expect(() => parseClaudeRewindPoint({ sessionId: null, forkAt: "a1" })).toThrow();
        expect(await revertClaudeConversation({ sdk: { forkSession: vi.fn() }, point: { sessionId: "s", forkAt: null }, transcriptPath: async () => "" })).toBeNull();
    });
});
