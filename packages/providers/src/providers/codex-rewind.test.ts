import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerAgentClient } from "./codex-agent.js";
import { CodexAppServerRpcError } from "./codex/app-server-transport.js";
import { listCodexTurns, parseCodexRewindPoint, revertCodexConversation, type CodexRewindClient } from "./codex/rewind.js";
import type { AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";

/** A Codex app-server stand-in: `fork` decides which fork parameters this "version" honours. */
function server(fork: "lastTurnId" | "beforeTurnId" | "legacy", turnsList = true) {
  const threads = new Map<string, string[]>([["t1", ["a", "b", "c"]]]), calls: Array<[string, Record<string, unknown>]> = [];
  const missing = (): never => { throw new CodexAppServerRpcError("Method not found", -32601, null); };
  const client: CodexRewindClient = {
    async request(method, raw) {
      const params = (raw ?? {}) as Record<string, unknown>; calls.push([method, params]);
      const turns = (id: unknown): string[] => threads.get(String(id)) ?? [];
      const copy = (list: string[]): { thread: { id: string } } => { const id = `t${threads.size + 1}`; threads.set(id, list.map((turn) => `${turn}'`)); return { thread: { id } }; };
      switch (method) {
        case "thread/turns/list": return turnsList ? { data: turns(params.threadId).map((id) => ({ id })), nextCursor: null } : missing();
        case "thread/read": return { thread: { id: params.threadId, turns: turns(params.threadId).map((id) => ({ id })) } };
        case "thread/fork": {
          const all = turns(params.threadId);
          if (fork === "lastTurnId" && typeof params.lastTurnId === "string") return copy(all.slice(0, all.indexOf(params.lastTurnId) + 1));
          if (fork === "beforeTurnId" && typeof params.beforeTurnId === "string") return copy(all.slice(0, all.indexOf(params.beforeTurnId)));
          return copy(all); // unknown parameters are ignored
        }
        case "thread/rollback": { if (fork !== "legacy") return missing(); const list = turns(params.threadId); threads.set(String(params.threadId), list.slice(0, list.length - Number(params.numTurns))); return { thread: { id: params.threadId } }; }
        case "thread/archive": threads.delete(String(params.threadId)); return {};
        default: return missing();
      }
    },
  };
  return { client, threads, calls };
}

describe("Codex conversation rewind", () => {
  it("forks through lastTurnId on current Codex and keeps the old thread", async () => {
    const { client, threads, calls } = server("lastTurnId");
    const thread = await revertCodexConversation(client, { threadId: "t1", turnId: "a", index: 0 }, { cwd: "/repo", model: "gpt" });
    expect(threads.get(thread!)).toEqual(["a'"]);
    expect(threads.get("t1")).toEqual(["a", "b", "c"]);
    expect(calls.find(([method]) => method === "thread/fork")?.[1]).toEqual({ threadId: "t1", cwd: "/repo", model: "gpt", excludeTurns: true, lastTurnId: "a" });
  });

  it("falls back to beforeTurnId when lastTurnId is ignored, archiving the wrong fork", async () => {
    const { client, threads, calls } = server("beforeTurnId");
    const thread = await revertCodexConversation(client, { threadId: "t1", turnId: "b", index: 1 }, {});
    expect(threads.get(thread!)).toEqual(["a'", "b'"]);
    expect(calls.filter(([method]) => method === "thread/fork").map(([, params]) => params.lastTurnId ?? params.beforeTurnId)).toEqual(["b", "c"]);
    expect(calls.some(([method]) => method === "thread/archive")).toBe(true);
    expect([...threads.keys()]).toEqual(["t1", thread]);
  });

  it("uses fork + thread/rollback on legacy Codex (thread/read history)", async () => {
    const { client, threads } = server("legacy", false);
    const thread = await revertCodexConversation(client, { threadId: "t1", turnId: "a", index: 0 }, {});
    expect(threads.get(thread!)).toEqual(["a'"]);
  });

  it("starts fresh for the first prompt and rejects targets outside the thread", async () => {
    const { client } = server("lastTurnId");
    expect(await revertCodexConversation(client, { threadId: "t1", turnId: null, index: -1 }, {})).toBeNull();
    await expect(revertCodexConversation(client, { threadId: "t1", turnId: "zzz", index: 7 }, {})).rejects.toThrow("not in the thread");
    expect(await listCodexTurns(client, "t1")).toEqual(["a", "b", "c"]);
    expect(() => parseCodexRewindPoint({ threadId: "t1", turnId: 3, index: 0 })).toThrow();
  });
});

describe("CodexSession rewind", () => {
  const fixture = fileURLToPath(new URL("../test-utils/fake-agent.mjs", import.meta.url));
  let home: string, session: AgentSession | undefined;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "baton-codex-rewind-")); });
  afterEach(async () => { await session?.close(); session = undefined; await rm(home, { recursive: true, force: true }); });
  it("records the turn before each prompt and continues in the forked thread", async () => {
    const client = new CodexAppServerAgentClient({ command: [process.execPath, fixture, "codex"], home, env: { BATON_HOME: home }, timeoutMs: 3000 });
    session = await client.createSession({ cwd: home });
    const events: AgentStreamEvent[] = []; session.subscribe((event) => events.push(event));
    const turn = async (prompt: string): Promise<void> => {
      const done = events.filter((event) => event.type === "turn_completed").length;
      await session!.startTurn(prompt);
      await expect.poll(() => events.filter((event) => event.type === "turn_completed").length).toBe(done + 1);
    };
    await turn("one");
    expect(session.rewindPoint!()).toEqual({ threadId: "fake-session", turnId: null, index: -1 });
    await turn("two");
    const point = session.rewindPoint!();
    expect(point).toEqual({ threadId: "fake-session", turnId: "turn-1", index: 0 });
    await turn("three");
    expect(session.rewindPoint!()).toEqual({ threadId: "fake-session", turnId: "turn-2", index: 1 });
    await session.rewindConversation!(point!);
    expect(session.getPersistence()).toEqual({ provider: "codex", sessionId: "fork-1" });
    await session.rewindConversation!({ threadId: "fake-session", turnId: null, index: -1 });
    expect(session.getPersistence()).toBeNull();
  });
});
