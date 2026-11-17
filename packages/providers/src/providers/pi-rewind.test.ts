import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcAgentClient } from "./pi-agent.js";
import { parsePiRewindPoint, piLeaf, revertPiConversation, type PiRequest } from "./pi/rewind.js";
import type { AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";

function pi() {
  const entries = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "one" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "re one" } },
    { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "two" } },
    { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: "re two" } },
  ];
  const sent: Array<Record<string, unknown>> = [];
  let file = "/s/one.jsonl";
  const request: PiRequest = async (command) => {
    sent.push(command);
    switch (command.type) {
      case "get_entries": { if (command.since === "gone") throw new Error("Entry not found"); const from = command.since ? entries.findIndex((e) => e.id === command.since) + 1 : 0; return { entries: entries.slice(from), leafId: entries.at(-1)!.id }; }
      case "switch_session": file = String(command.sessionPath); return { cancelled: false };
      case "fork": file = `/s/fork-${String(command.entryId)}.jsonl`; return { text: "x", cancelled: false };
      case "get_state": return { sessionFile: file, sessionId: file.slice(3, -6) };
      default: throw new Error(`unexpected ${command.type}`);
    }
  };
  return { request, sent };
}

describe("Pi conversation rewind", () => {
  it("tracks the leaf with a get_entries cursor", async () => {
    const { request, sent } = pi();
    expect(await piLeaf(request, null)).toEqual({ leafId: "a2", cursor: "a2" });
    expect(await piLeaf(request, "a1")).toEqual({ leafId: "a2", cursor: "a2" });
    expect(await piLeaf(request, "gone")).toEqual({ leafId: "a2", cursor: "a2" });
    expect(sent.map((c) => c.since ?? null)).toEqual([null, "a1", "gone", null]);
  });

  it("forks from the user entry under the recorded leaf, switching sessions first when needed", async () => {
    const { request, sent } = pi();
    expect(await revertPiConversation(request, { sessionFile: "/s/one.jsonl", leafId: "a1" }, "/s/one.jsonl")).toEqual({ sessionFile: "/s/fork-u2.jsonl", sessionId: "fork-u2" });
    expect(sent.find((c) => c.type === "fork")).toEqual({ type: "fork", entryId: "u2" });
    sent.length = 0;
    await revertPiConversation(request, { sessionFile: "/s/one.jsonl", leafId: null }, "/s/other.jsonl");
    expect(sent.map((c) => c.type)).toEqual(["switch_session", "get_entries", "fork", "get_state"]);
    expect(sent[2]).toEqual({ type: "fork", entryId: "u1" });
    await expect(revertPiConversation(request, { sessionFile: "/s/one.jsonl", leafId: "nope" }, "/s/one.jsonl")).rejects.toThrow("not found");
    expect(() => parsePiRewindPoint({ leafId: "a1" })).toThrow();
  });
});

describe("PiSession rewind", () => {
  const fixture = fileURLToPath(new URL("../test-utils/fake-agent.mjs", import.meta.url));
  let home: string, previous: string | undefined, session: AgentSession | undefined;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "baton-pi-rewind-")); previous = process.env.BATON_HOME; process.env.BATON_HOME = home; });
  afterEach(async () => { await session?.close(); session = undefined; await rm(home, { recursive: true, force: true }); if (previous === undefined) delete process.env.BATON_HOME; else process.env.BATON_HOME = previous; });
  it("records the leaf before each prompt and switches to the forked session file", async () => {
    const client = new PiRpcAgentClient({ command: [process.execPath, fixture, "pi"], home, env: { BATON_HOME: home }, timeoutMs: 3000 });
    session = await client.createSession({ cwd: home, model: "fake/fake-model" });
    const events: AgentStreamEvent[] = []; session.subscribe((event) => events.push(event));
    const turn = async (prompt: string): Promise<void> => {
      const done = events.filter((event) => event.type === "turn_completed").length;
      await session!.startTurn(prompt);
      await expect.poll(() => events.filter((event) => event.type === "turn_completed").length).toBe(done + 1);
    };
    const file = `${home}/fake-session.jsonl`;
    await turn("one");
    expect(session.rewindPoint!()).toEqual({ sessionFile: file, leafId: null });
    await turn("two");
    const point = session.rewindPoint!();
    expect(point).toEqual({ sessionFile: file, leafId: "a1" });
    await turn("three");
    expect(session.rewindPoint!()).toEqual({ sessionFile: file, leafId: "a2" });
    await session.rewindConversation!(point!);
    expect(session.getPersistence()).toEqual({ provider: "pi", sessionId: "fork-u2", sessionFile: `${home}/fork-u2.jsonl` });
  });
});
