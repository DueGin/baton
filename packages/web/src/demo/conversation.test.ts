import { describe, expect, it } from "vitest";
import { applyEvent, type RunEventEnvelope } from "@baton/protocol";
import { DemoClient } from "./client.js";
import { richConversation } from "./conversation.js";
import { codeFences } from "../lib/markdown.js";
const base = Date.parse("2026-11-10T07:00:00Z");
describe("conversation demo", () => {
  it("provides rich Markdown and three complete diagrams with a quiet active turn", async () => {
    const client = new DemoClient(() => base); const snapshot = await client.run("run-conversation");
    const rows = (await client.items(snapshot.run.rootNodeId)).items;
    expect(rows.some(row => row.item.type === "assistant_message" && row.item.text === richConversation)).toBe(true);
    expect(codeFences(richConversation).filter(fence => fence.language === "mermaid" && fence.complete)).toHaveLength(3);
    expect(codeFences(richConversation).map(fence => fence.language)).toContain("python");
    expect(snapshot.turns.every(turn => turn.status === "running")).toBe(true);
    expect(base - Date.parse(rows.at(-1)!.ts)).toBe(65_000);
  });
  it("records steered and queued sends immediately, replaces the queued item and replays every event", async () => {
    let now = base; const client = new DemoClient(() => now); const initial = await client.run("run-conversation");
    const events: RunEventEnvelope[] = []; const controller = new AbortController();
    const streaming = client.events(initial.run.id, initial.lastSeq, event => events.push(event), controller.signal);
    const root = initial.run.rootNodeId; const pi = initial.nodes.find(node => node.agentId === "pi")!.id;
    expect((await client.send(root, "立即插入", "steer-1")).delivery).toBe("steered");
    const queued = await client.send(pi, "排队补充", "queue-1");
    expect(queued.delivery).toBe("queued");
    expect(await client.send(pi, "排队补充", "queue-1")).toEqual(queued);
    const before = (await client.items(pi)).items.find(row => row.seq === queued.itemSeq)!;
    expect(before.item).toMatchObject({ delivery: "queued", clientId: "queue-1" });
    now += 46_000;
    const after = await client.run(initial.run.id);
    const delivered = (await client.items(pi)).items.find(row => row.seq === queued.itemSeq)!;
    expect(delivered.item).toMatchObject({ delivery: "turn", clientId: "queue-1" });
    expect(delivered.turnId).toBe(after.turns.findLast(turn => turn.nodeId === pi && turn.status === "running")!.id);
    expect(after.turns.some(turn => turn.nodeId === pi && turn.status === "running")).toBe(true);
    controller.abort(); await streaming;
    expect(events.reduce(applyEvent, initial)).toEqual(after);
    expect(new Set(events.map(event => event.seq)).size).toBe(events.length);
    now += 16_000; await client.run(initial.run.id);
    const rows = (await client.items(pi)).items;
    expect(new Set(rows.map(row => row.seq)).size).toBe(rows.length);
    expect(rows.filter(row => row.item.type === "user_message" && row.item.clientId === "queue-1")).toHaveLength(1);
  });
  it("keeps canceled queued rows and appends a durable warning without delivering them later", async () => {
    let now = base; const client = new DemoClient(() => now);
    const snapshot = await client.run("run-conversation"); const pi = snapshot.nodes.find(node => node.agentId === "pi")!.id;
    const queued = await client.send(pi, "不可丢失的消息", "cancel-queue");
    await client.cancelNode(pi); now += 60_000;
    const rows = (await client.items(pi)).items;
    expect(rows.find(row => row.seq === queued.itemSeq)!.item).toMatchObject({ delivery: "queued" });
    expect(rows.some(row => row.item.type === "notice" && row.item.message === "未送达：节点已结束")).toBe(true);
    expect((await client.run(snapshot.run.id)).nodes.find(node => node.id === pi)!.status).toBe("canceled");
  });

});
