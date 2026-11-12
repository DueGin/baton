import { describe, expect, it } from "vitest";
import type { ItemRecord, RunSnapshot } from "@baton/protocol";
import { createScenario, replay } from "../demo/scenario.js";
import { conversationPhase, conversationRows, deliveryLabel, quietSeconds, reconcileOutgoing, type OutgoingMessage } from "./conversation.js";
const base = Date.parse("2026-11-10T07:00:00Z");
const ts = new Date(base).toISOString();
const pending: OutgoingMessage = { clientId: "c1", nodeId: "n", text: "hello", state: "sending", ts };
const row: ItemRecord = { seq: 9, nodeId: "n", ts, item: { type: "user_message", text: "hello", clientId: "c1", delivery: "queued" } };
describe("message delivery", () => {
  it("shows optimistic messages immediately and reconciles clientId or itemSeq without duplicates", () => {
    expect(conversationRows([], [pending], "n")[0]!.outgoing?.state).toBe("sending");
    const queued = reconcileOutgoing([pending], row);
    expect(queued[0]).toMatchObject({ state: "accepted", itemSeq: 9, delivery: "queued" });
    expect(conversationRows([row], queued, "n")).toHaveLength(1);
    const delivered = reconcileOutgoing(queued.map(message => ({ ...message, wasQueued: true })), { ...row, item: { type: "user_message", text: "hello", delivery: "turn" } });
    expect(delivered[0]).toMatchObject({ delivery: "turn", wasQueued: true });
    expect(deliveryLabel(delivered[0]!.delivery, delivered[0]!.wasQueued)).toBe("已送达");
    expect(deliveryLabel("steered")).toBe("已插入当前回合");
    expect(deliveryLabel("turn")).toBe("已开始新一轮");
    expect(deliveryLabel("queued")).toContain("当前回合结束后送达");
  });
  it("never merges equal sequences across nodes", () => {
    expect(reconcileOutgoing([pending], { ...row, nodeId: "other" })).toEqual([pending]);
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
  it("shows child waiting and hides the bar once the node is done", () => {
    const edge = { ...original.delegations[0]!, fromNodeId: node.id, status: "running" as const };
    expect(phase([], { ...snapshot, delegations: [edge] })?.kind).toBe("children");
    expect(conversationPhase({ ...snapshot, turns: [] }, { ...node, status: "idle" }, [], base)).toBeNull();
  });
});
