import { describe, expect, it } from "vitest";
import type { ItemRecord, RunSnapshot } from "@baton/protocol";
import { createScenario, replay } from "../demo/scenario.js";
import { conversationPhase, conversationRows, deliveryLabel, inFlightMessage, messageActions, nodeIsLive, outgoingMatches, pruneOutgoing, quietSeconds, reconcileOutgoing, type OutgoingMessage } from "./conversation.js";
import { displayRunStatus, displayStatus } from "./derive.js";
const base = Date.parse("2026-11-10T07:00:00Z");
const ts = new Date(base).toISOString();
const pending: OutgoingMessage = { clientId: "c1", nodeId: "n", text: "hello", state: "sending", ts };
const row: ItemRecord = { seq: 9, nodeId: "n", ts, item: { type: "user_message", text: "hello", clientId: "c1", delivery: "queued" } };
describe("message delivery", () => {
  it("shows optimistic messages immediately and reconciles clientId or itemSeq without duplicates", () => {
    expect(conversationRows([], [pending], "n")[0]!.outgoing?.state).toBe("sending");
    const queued = reconcileOutgoing([pending], row);
    expect(queued[0]).toMatchObject({ state: "accepted", itemSeq: 9, delivery: "queued" });
    expect(conversationRows([row], queued, "n")).toHaveLength(0);
    const delivered = reconcileOutgoing(queued, { ...row, item: { type: "user_message", text: "hello", delivery: "turn" } });
    expect(delivered[0]).toMatchObject({ delivery: "turn" });
    expect(deliveryLabel(delivered[0]!.delivery, delivered[0]!.interrupted)).toBe("已送达");
    expect(deliveryLabel("steered")).toBe("已插入当前回合");
    expect(deliveryLabel("turn")).toBe("已送达");
    expect(deliveryLabel("queued")).toBe("排队中");
  });
  it("only reveals interruption after steering, and labels all terminal delivery states", () => {
    expect(messageActions("queued")).toEqual(["steer", "edit"]);
    expect(messageActions("queued", { steerUnsupported: true })).toEqual(["interrupt", "edit"]);
    expect(messageActions("steered")).toEqual(["interrupt"]);
    expect(messageActions("turn")).toEqual([]);
    expect(messageActions("retracted")).toEqual([]);
    expect(messageActions(undefined)).toEqual([]);
    expect(deliveryLabel("turn", true)).toBe("已中断并立即发送");
    expect(deliveryLabel("retracted")).toBe("已撤回");
    const retracted = reconcileOutgoing([pending], { ...row, item: { type: "user_message", text: "hello", clientId: "c1", delivery: "retracted" } });
    expect(retracted[0]?.delivery).toBe("retracted");
  });
  it("never merges equal sequences across nodes", () => {
    expect(reconcileOutgoing([pending], { ...row, nodeId: "other" })).toEqual([pending]);
  });
  it("falls back to same-node/text within two minutes without merging distinct known identities", () => {
    const legacy = { ...row, ts: new Date(base + 119_000).toISOString(), item: { type: "user_message" as const, text: "hello", delivery: "turn" as const } };
    expect(reconcileOutgoing([pending], legacy)[0]).toMatchObject({ acknowledged: true, itemSeq: 9, delivery: "turn" });
    expect(conversationRows([legacy], [pending], "n")).toHaveLength(1);
    expect(outgoingMatches(pending, { ...legacy, ts: new Date(base + 121_000).toISOString() })).toBe(false);
    expect(outgoingMatches(pending, { ...legacy, nodeId: "other" })).toBe(false);
    expect(outgoingMatches(pending, { ...legacy, item: { ...legacy.item, clientId: "different" } })).toBe(false);
    const duplicate = { ...pending, clientId: "c2" };
    expect(reconcileOutgoing([pending, duplicate], legacy).filter(message => message.acknowledged)).toHaveLength(1);
  });
  it("prunes persisted and stale outgoing records and only treats fresh unreconciled sending as in flight", () => {
    expect(pruneOutgoing([pending], [row], base)).toEqual([]);
    expect(pruneOutgoing([pending], [], base + 120_001)).toEqual([]);
    expect(pruneOutgoing([pending], [], base + 119_999)).toEqual([pending]);
    expect(inFlightMessage([pending], [], "n", base + 29_999)).toEqual(pending);
    for (const message of [{ ...pending, state: "accepted" as const }, { ...pending, state: "failed" as const }, { ...pending, acknowledged: true }, { ...pending, ts: new Date(base - 30_000).toISOString() }]) expect(inFlightMessage([message], [], "n", base)).toBeUndefined();
    expect(inFlightMessage([pending], [row], "n", base)).toBeUndefined();
  });
});
describe("conversation live phase", () => {
  const original = replay(createScenario(base), base + 86_000);
  const node = { ...original.nodes[0]!, status: "running" as const, updatedAt: ts };
  const snapshot: RunSnapshot = { ...original, nodes: [node], delegations: [], toolSpans: [], questions: [], permissions: [], turns: [{ id: "t", runId: original.run.id, nodeId: node.id, status: "running" as const, trigger: "user" as const, startedAt: ts }] };
  const phase = (rows: ItemRecord[] = [], value = snapshot) => conversationPhase(value, node, rows, base + 45_000);
  const textRow = (type: "reasoning" | "assistant_message"): ItemRecord => ({ seq: 1, ts, nodeId: node.id, turnId: "t", item: { type, text: "new output" } });
  it("derives waiting, reasoning and reply phases and elapsed quiet time", () => {
    expect(phase()?.label).toBe("已发送，等待响应…");
    expect(phase([textRow("reasoning")])).toMatchObject({ kind: "reasoning", reasoning: "new output", quiet: 45 });
    expect(phase([textRow("assistant_message")])?.label).toBe("正在回复…");
    expect(conversationPhase(snapshot, node, [], base + 45_000, base + 40_000)?.quiet).toBe(5);
    expect(quietSeconds(base, base + 1000)).toBe(0);
  });
  it("prioritizes permission, human questions and executing tools", () => {
    const permission = { ...original.permissions[0]!, nodeId: node.id, status: "pending" as const };
    expect(phase([], { ...snapshot, permissions: [permission] })?.kind).toBe("permission");
    const question = { id: "q", runId: snapshot.run.id, nodeId: node.id, question: "Which?", blocking: true, status: "pending" as const, askedAt: ts };
    expect(phase([], { ...snapshot, questions: [question] })?.kind).toBe("question");
    const span = { id: "s", runId: snapshot.run.id, nodeId: node.id, callId: "s", name: "shell", kind: "shell", summary: "npm test", startedAt: ts, status: "running" as const };
    expect(phase([], { ...snapshot, toolSpans: [span] })).toMatchObject({ kind: "tool", label: "正在执行 shell: npm test", toolSince: ts });
  });
  it("briefly acknowledges a human interruption, then returns to the live phase", () => {
    const value: RunSnapshot = { ...snapshot, turns: [...snapshot.turns, { ...snapshot.turns[0]!, id: "old", status: "canceled", error: "interrupted by human message", endedAt: new Date(base + 42_000).toISOString() }] };
    expect(phase([], value)?.label).toBe("已中断，正在处理你的新消息");
    expect(conversationPhase(value, node, [], base + 48_000)?.kind).toBe("waiting");
    expect(phase([], { ...value, turns: value.turns.map(turn => turn.id === "old" ? { ...turn, error: "canceled by user" } : turn) })?.kind).toBe("waiting");
  });
  it("shows child waiting and hides the bar once the node is done", () => {
    const edge = { ...original.delegations[0]!, fromNodeId: node.id, status: "running" as const };
    expect(phase([], { ...snapshot, delegations: [edge] })?.kind).toBe("children");
    expect(conversationPhase({ ...snapshot, turns: [] }, { ...node, status: "idle" }, [], base)).toBeNull();
  });
  it("never resurrects a completed idle turn from a stale accepted send or its final assistant text (08:14:38–08:17:10 regression)", () => {
    const startedAt = "2026-11-16T08:14:38Z"; const endedAt = "2026-11-16T08:17:10Z";
    const idle = { ...node, status: "idle" as const, updatedAt: endedAt, usage: { ...node.usage, inputTokens: 2_847_200 } };
    const value = { ...snapshot, nodes: [idle], turns: [{ ...snapshot.turns[0]!, status: "completed" as const, startedAt, endedAt }] };
    const rows: ItemRecord[] = [{ ...textRow("assistant_message"), ts: endedAt }];
    const stale = { ...pending, nodeId: node.id, state: "accepted" as const, delivery: "turn" as const, ts: startedAt };
    expect(conversationPhase(value, idle, rows, Date.parse(endedAt), Date.parse(endedAt), stale)).toBeNull();
    expect(conversationPhase(value, idle, rows, Date.parse(endedAt) + 600_000, Date.parse(endedAt), { ...stale, state: "sending" })).toBeNull();
    expect(nodeIsLive(value, idle)).toBe(false);
  });
  it("uses a running turn, blockers or a fresh sending message as the only liveness sources", () => {
    const quiet = { ...snapshot, turns: [] }; const rows = [textRow("assistant_message")];
    for (const status of ["starting", "running", "idle", "waiting_permission", "completed", "failed", "canceled", "replaced"] as const) expect(conversationPhase(quiet, { ...node, status }, rows, base)).toBeNull();
    const sending = { ...pending, nodeId: node.id };
    expect(conversationPhase(quiet, node, rows, base + 20_000, undefined, sending)?.kind).toBe("waiting");
    expect(conversationPhase(quiet, node, rows, base + 30_000, undefined, sending)).toBeNull();
    const staleTool = { ...original.toolSpans[0]!, nodeId: node.id, status: "running" as const };
    expect(conversationPhase({ ...quiet, toolSpans: [staleTool] }, node, rows, base)).toBeNull();
    const permission = { ...original.permissions[0]!, nodeId: node.id, status: "pending" as const };
    expect(conversationPhase({ ...quiet, permissions: [permission] }, node, rows, base)?.kind).toBe("permission");
    const question = { id: "async-question", nodeId: node.id, runId: snapshot.run.id, status: "pending" as const, question: "确认范围", blocking: false, delivery: "async" as const, askedAt: ts };
    expect(conversationPhase({ ...quiet, questions: [question] }, node, rows, base)?.kind).toBe("question");
    expect(phase()?.tokens).toBeUndefined();
    expect(phase([], { ...snapshot, turns: [{ ...snapshot.turns[0]!, usage: { inputTokens: 1000, outputTokens: 160 } }] })?.tokens).toBe(1160);
  });
  it("links inline questions by card id and suppresses live indicators while paused", () => {
    const question = { id: "question-id", runId: snapshot.run.id, nodeId: node.id, question: "请选择", blocking: false, delivery: "inline" as const, source: "native" as const, status: "pending" as const, askedAt: ts };
    expect(phase([], { ...snapshot, questions: [question] })).toMatchObject({ kind: "question", label: "等你回答", related: ["question-id"] });
    expect(displayStatus(node, { ...snapshot, questions: [question] })).toBe("waiting_answer");
    const paused = { ...snapshot, run: { ...snapshot.run, status: "paused" as const } };
    expect(phase([], paused)).toBeNull(); expect(nodeIsLive(paused, node)).toBe(false); expect(displayStatus(node, paused)).toBe("paused"); expect(displayRunStatus(paused)).toBe("paused");
    const permission = { ...original.permissions[0]!, nodeId: node.id, status: "pending" as const, requestId: "call", request: { ...original.permissions[0]!.request, kind: "question" as const } };
    expect(phase([], { ...snapshot, questions: [{ ...question, anchor: { callId: "call" } }], permissions: [permission] })?.kind).toBe("question");
  });
});
