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
    expect((await client.send(root, "立即插入", "steer-1", "steer")).delivery).toBe("steered");
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

  it("defaults to queue, escalates supported steering in place, and interrupts only that node", async () => {
    let now = base; const client = new DemoClient(() => now); const initial = await client.run("run-conversation");
    const root = initial.run.rootNodeId; const pi = initial.nodes.find(node => node.agentId === "pi")!.id;
    const queued = await client.send(root, "先验证", "ladder"); expect(queued.delivery).toBe("queued");
    const steered = await client.deliver(root, queued.itemSeq, { mode: "steer" }); expect(steered).toMatchObject({ delivery: "steered", itemSeq: queued.itemSeq });
    expect((await client.items(root)).items.find(row => row.seq === queued.itemSeq)!.item).toMatchObject({ delivery: "steered", escalated: true });
    expect(await client.deliver(root, queued.itemSeq, { mode: "interrupt" })).toMatchObject({ delivery: "turn", itemSeq: queued.itemSeq });
    const after = await client.run(initial.run.id);
    expect(after.turns.find(turn => turn.id === `${root}:quiet`)).toMatchObject({ status: "canceled", error: "interrupted by human message" });
    expect(after.turns.filter(turn => turn.nodeId === root && turn.status === "running")).toHaveLength(1);
    expect(after.turns.find(turn => turn.nodeId === pi)!.status).toBe("running");
    expect(after.delegations).toEqual(initial.delegations);
    expect((await client.items(root)).items.find(row => row.seq === queued.itemSeq)!.item).toMatchObject({ delivery: "turn", interrupted: true });
    await expect(client.deliver(root, queued.itemSeq, { mode: "interrupt" })).rejects.toThrow("409");
    now += 46_000;
    const done = await client.run(initial.run.id);
    expect(done.turns.find(turn => turn.id === `${root}:quiet`)!.status).toBe("canceled");
    expect(done.turns.filter(turn => turn.nodeId === root && turn.status === "running")).toHaveLength(0);
  });

  it("keeps unsupported steering queued, allows interrupt, and never delivers retracted messages", async () => {
    let now = base; const client = new DemoClient(() => now); const snapshot = await client.run("run-conversation");
    const pi = snapshot.nodes.find(node => node.agentId === "pi")!.id;
    const queued = await client.send(pi, "改用快速验证", "unsupported");
    expect(await client.deliver(pi, queued.itemSeq, { mode: "steer" })).toEqual({ accepted: true, delivery: "queued", itemSeq: queued.itemSeq, steerUnsupported: true });
    expect((await client.items(pi)).items.find(row => row.seq === queued.itemSeq)!.item).toMatchObject({ delivery: "queued" });
    expect((await client.deliver(pi, queued.itemSeq, { mode: "interrupt" })).delivery).toBe("turn");
    const removed = await client.send(pi, "撤回这条", "removed"); await client.retract(pi, removed.itemSeq);
    await expect(client.retract(pi, removed.itemSeq)).rejects.toThrow("409");
    await expect(client.deliver(pi, removed.itemSeq, { mode: "interrupt" })).rejects.toThrow("409");
    now += 60_000;
    expect((await client.items(pi)).items.find(row => row.seq === removed.itemSeq)!.item).toMatchObject({ delivery: "retracted" });
    expect((await client.run(snapshot.run.id)).turns.filter(turn => turn.nodeId === pi)).toHaveLength(2);
  });

  it("delivers multiple queued rows as one turn and starts idle nodes immediately for every mode", async () => {
    let now = base; const client = new DemoClient(() => now); const snapshot = await client.run("run-conversation"); const root = snapshot.run.rootNodeId;
    const one = await client.send(root, "第一条"); const two = await client.send(root, "第二条");
    now += 46_000;
    const rows = (await client.items(root)).items.filter(row => row.seq === one.itemSeq || row.seq === two.itemSeq);
    expect(rows.every(row => row.item.type === "user_message" && row.item.delivery === "turn")).toBe(true);
    expect(new Set(rows.map(row => row.turnId)).size).toBe(1);
    for (const mode of ["queue", "steer", "interrupt"] as const) {
      now += 16_000; const sent = await client.send(root, `idle ${mode}`, undefined, mode);
      expect(sent.delivery).toBe("turn");
      expect((await client.items(root)).items.find(row => row.seq === sent.itemSeq)!.item).not.toHaveProperty("interrupted");
    }
  });

});
