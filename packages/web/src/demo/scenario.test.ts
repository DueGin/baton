import { describe, expect, it } from "vitest";
import { applyEvent, type RunSnapshot } from "@baton/protocol";
import { createScenario } from "./scenario.js";
import { DemoClient } from "./client.js";
import { parseBatonMessage } from "../lib/baton-messages.js";

const base = Date.parse("2026-11-10T07:00:00Z");

describe("deterministic demo protocol stream", () => {
  it("only updates existing records and produces valid timestamps, relationships and item replacements", () => {
    const scenario = createScenario(base); let snapshot: RunSnapshot = scenario.initial;
    const rowSeqs = new Map<string, Set<number>>(); let replacements = 0;
    for (const [index, event] of scenario.events.entries()) {
      expect(event.runId).toBe(scenario.initial.run.id);
      expect(event.seq).toBe(index + 1);
      expect(Number.isFinite(Date.parse(event.ts))).toBe(true);
      if (index > 0) expect(event.ts >= scenario.events[index - 1]!.ts).toBe(true);
      if (event.type === "node.updated" || event.type === "item") expect(snapshot.nodes.some(node => node.id === event.nodeId)).toBe(true);
      if (event.type === "turn.updated") expect(snapshot.turns.some(turn => turn.id === event.turnId)).toBe(true);
      if (event.type === "delegation.updated") expect(snapshot.delegations.some(edge => edge.id === event.delegationId)).toBe(true);
      if (event.type === "delegation.created") {
        expect(snapshot.nodes.some(node => node.id === event.delegation.fromNodeId)).toBe(true);
        expect(snapshot.nodes.some(node => node.id === event.delegation.toNodeId)).toBe(true);
      }
      if (event.type === "item") {
        const seqs = rowSeqs.get(event.nodeId) ?? new Set<number>();
        if (seqs.has(event.itemSeq)) replacements++; else expect(event.itemSeq).toBe(seqs.size + 1);
        seqs.add(event.itemSeq); rowSeqs.set(event.nodeId, seqs);
      }
      snapshot = applyEvent(snapshot, event);
      for (const record of [...snapshot.nodes, ...snapshot.delegations]) if (record.endedAt) expect(Date.parse(record.endedAt)).toBeGreaterThanOrEqual(Date.parse(record.createdAt));
    }
    expect(replacements).toBeGreaterThan(5);
    expect(snapshot.nodes).toHaveLength(7);
    expect(snapshot.nodes.some(node => node.depth === 2)).toBe(true);
    expect(snapshot.nodes.some(node => node.status === "failed")).toBe(true);
    expect(snapshot.nodes.some(node => node.status === "replaced")).toBe(true);
    expect(snapshot.delegations.some(edge => edge.status === "replaced" && snapshot.delegations.some(next => next.id === edge.replacedBy && next.replaces === edge.id))).toBe(true);
    expect(snapshot.permissions.some(permission => permission.status === "pending")).toBe(true);
    expect(new Set(snapshot.toolSpans.map(span => span.kind)).size).toBeGreaterThanOrEqual(8);
    expect(snapshot.turns.some(turn => turn.trigger === "result")).toBe(true);
    const sum = snapshot.nodes.reduce((usage, node) => ({ inputTokens: usage.inputTokens + node.usage.inputTokens, outputTokens: usage.outputTokens + node.usage.outputTokens, costUsd: usage.costUsd + node.usage.costUsd }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(snapshot.run.usage.inputTokens).toBe(sum.inputTokens);
    expect(snapshot.run.usage.outputTokens).toBe(sum.outputTokens);
    expect(snapshot.run.usage.costUsd).toBeCloseTo(sum.costUsd, 8);
    const protocol = scenario.events.filter(event => event.type === "item" && event.item.type === "user_message").flatMap(event => event.type === "item" && event.item.type === "user_message" ? parseBatonMessage(event.item.text) ?? [] : []);
    expect(protocol.filter(part => part.type === "assignment")).toHaveLength(6);
    expect(protocol.filter(part => part.type === "results")).toHaveLength(4);
  });
  it("implements the same client actions, resolves permissions and delivers the child result", async () => {
    const client = new DemoClient(() => base + 86000);
    const before = await client.run("run-demo"); const permission = before.permissions.find(entry => entry.status === "pending")!;
    await client.decide(permission.requestId, { response: { behavior: "allow" } });
    const after = await client.run("run-demo");
    expect(after.permissions[0]!.resolvedBy).toBe("human");
    expect(after.delegations.find(edge => edge.toNodeId === permission.nodeId)?.deliveredVia).toBe("turn");
    expect(after.run.status).toBe("idle");
    const rows = await client.items(permission.nodeId);
    expect(rows.items.at(-1)?.item.type).toBe("assistant_message");
    const parent = await client.items(after.run.rootNodeId);
    expect(parent.items.some(row => row.item.type === "user_message" && parseBatonMessage(row.item.text)?.some(part => part.type === "results" && part.results.some(result => result.delegationId === `d-${permission.nodeId}`)))).toBe(true);
    await client.send(permission.nodeId, "补充无障碍说明");
    expect((await client.run("run-demo")).nodes.find(node => node.id === permission.nodeId)!.turns).toBe(2);
    expect((await client.delegation(`d-${permission.nodeId}`)).round).toBe(2);
  });
  it("creates a usable Run and cascades cancellation without affecting siblings", async () => {
    const client = new DemoClient(() => base + 86000);
    const created = await client.createRun({ projectId: "project-atlas", agent: "codex", prompt: "检查项目", policy: { autoApprove: true, mode: "solo" } });
    expect(created.run.policy.autoApprove).toBe(true);
    expect((await client.items(created.run.rootNodeId)).items).toHaveLength(3);
    await client.cancelNode("run-demo:root");
    const canceled = await client.run("run-demo");
    expect(canceled.run.status).toBe("canceled");
    expect(canceled.nodes.every(node => ["completed", "failed", "canceled", "replaced"].includes(node.status))).toBe(true);
    expect(canceled.permissions.every(permission => permission.status !== "pending")).toBe(true);
    expect((await client.run(created.run.id)).run.status).toBe("idle");
  });
  it("streams evolving tools and merged text after opening and keeps canceled nodes stopped", async () => {
    let now = base + 86000;
    const client = new DemoClient(() => now);
    const initial = await client.run("run-demo");
    now += 7000;
    const running = await client.run("run-demo");
    expect(running.toolSpans.length).toBeGreaterThan(initial.toolSpans.length);
    const row = (await client.items(running.run.rootNodeId)).items.find(item => item.item.type === "assistant_message" && item.item.text.startsWith("API 结果"))!;
    now += 4000;
    const updated = (await client.items(running.run.rootNodeId)).items.find(item => item.seq === row.seq)!;
    expect(updated.item).not.toEqual(row.item);
    await client.cancelRun("run-demo");
    now += 100000;
    const canceled = await client.run("run-demo");
    expect(canceled.nodes.find(node => node.id === canceled.run.rootNodeId)?.status).toBe("canceled");
    expect(canceled.toolSpans.some(span => span.status === "running")).toBe(false);
  });
});
