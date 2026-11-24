import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEvent, type GetItemsResponse, type RunEventEnvelope, type SendMessageResponse } from "@baton/protocol";
import { DemoClient } from "./demo/client.js";
import { createScenario, replay } from "./demo/scenario.js";
import { conversationRows } from "./lib/conversation.js";
import { mergeItems, RunStore } from "./store.js";
import { HttpError } from "./api.js";
import { messageActionKey } from "./lib/conversation.js";
import { queuedRows, queueDropOrder, queueMoveOrder } from "./lib/conversation.js";

const base = Date.parse("2026-11-10T07:00:00Z");
afterEach(() => vi.useRealTimers());

describe("RunStore and protocol integration", () => {
  it("shows confirmed config resets even before SSE catches up, without replacing other live node fields", async () => {
    const client = new DemoClient(() => base), store = new RunStore(client);
    try {
      await store.open("run-questions"); const snapshot = store.getSnapshot().snapshot!, before = snapshot.nodes[0]!;
      expect(before.model).toBeTruthy();
      vi.spyOn(client, "updateNodeConfig").mockImplementation(async () => {
        store.apply({ type: "node.updated", nodeId: before.id, runId: snapshot.run.id, seq: snapshot.lastSeq + 1, ts: before.updatedAt, patch: { activity: "live", modeId: "plan" } });
        return { node: { ...before, model: undefined }, applied: "next_turn" };
      });
      await store.updateNodeConfig(before.id, { model: null });
      expect(store.getSnapshot().snapshot?.nodes[0]).toMatchObject({ model: undefined, activity: "live", modeId: "plan" });
    } finally { store.close(); }
  });
  it("replays structured question replacements and pause/resume metadata without duplicating cards", async () => {
    const client = new DemoClient(() => base); const store = new RunStore(client); await store.open("run-questions");
    const before = store.getSnapshot().snapshot!; const question = before.questions[0]!;
    const emit = (event: Omit<Extract<RunEventEnvelope, { type: "question" }>, "seq">) => { store.apply({ ...event, seq: store.getSnapshot().snapshot!.lastSeq + 1 }); };
    emit({ type: "question", runId: before.run.id, ts: new Date(base + 1000).toISOString(), question: { ...question, status: "answered", answers: { scope: ["当前项目"], checks: ["中文", "权限"] }, answer: "当前项目，中文与权限", answeredAt: new Date(base + 1000).toISOString() } });
    expect(store.getSnapshot().snapshot!.questions).toHaveLength(before.questions.length);
    expect(store.getSnapshot().snapshot!.questions[0]).toMatchObject({ status: "answered", answers: { checks: ["中文", "权限"] } });
    expect(store.getSnapshot().lastEventAt[question.nodeId]).toBe(base + 1000);
    const snapshot = store.getSnapshot().snapshot!;
    store.apply({ type: "run.updated", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, ts: new Date(base + 2000).toISOString(), patch: { status: "paused", pauses: [{ at: new Date(base + 2000).toISOString(), by: "human" }] } });
    expect(store.getSnapshot().snapshot!.run.status).toBe("paused"); expect(store.getSnapshot().snapshot!.run.pauses).toHaveLength(1);
    store.close();
  });
  it("applies an ordered live stream, replaces itemSeq and ignores old/cross-run envelopes", async () => {
    const client = new DemoClient(() => base + 86000);
    const store = new RunStore(client);
    await store.open("run-demo");
    const before = store.getSnapshot().snapshot!;
    const nodeId = before.run.rootNodeId;
    await store.loadItems(nodeId);
    const count = store.getSnapshot().items[nodeId]!.length;
    const next: RunEventEnvelope = { runId: before.run.id, seq: before.lastSeq + 1, ts: new Date(base + 90000).toISOString(), itemTs: new Date(base).toISOString(), type: "item", nodeId, itemSeq: 1, item: { type: "user_message", text: "replaced" } };
    store.apply(next);
    expect(store.getSnapshot().items[nodeId]).toHaveLength(count);
    expect(store.getSnapshot().items[nodeId]![0]!.item).toEqual({ type: "user_message", text: "replaced" });
    expect(store.getSnapshot().items[nodeId]![0]!.ts).toBe(next.itemTs);
    expect(store.getSnapshot().lastEventAt[nodeId]).toBe(Date.parse(next.ts));
    expect(store.getSnapshot().snapshot).toEqual(applyEvent(before, next));
    const same = store.getSnapshot();
    store.apply(next);
    store.apply({ ...next, runId: "another-run", seq: next.seq + 1 });
    expect(store.getSnapshot()).toBe(same);
    store.close();
  });

  it("keeps a live item update that arrives while the lazy items request is pending", async () => {
    const client = new DemoClient(() => base + 86000);
    let resolveItems: ((value: GetItemsResponse) => void) | undefined;
    vi.spyOn(client, "items").mockImplementation(() => new Promise(resolve => { resolveItems = resolve; }));
    const store = new RunStore(client);
    await store.open("run-demo");
    const snapshot = store.getSnapshot().snapshot!;
    const nodeId = snapshot.run.rootNodeId;
    const loading = store.loadItems(nodeId);
    const row = { seq: 1, nodeId, ts: snapshot.run.createdAt, item: { type: "assistant_message" as const, text: "old" } };
    store.apply({ type: "item", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, itemSeq: 1, ts: row.ts, itemTs: row.ts, nodeId, item: { type: "assistant_message", text: "new stream content" } });
    resolveItems!({ items: [row], lastSeq: 1 });
    await loading;
    expect(store.getSnapshot().items[nodeId]![0]!.item).toEqual({ type: "assistant_message", text: "new stream content" });
    store.close();
  });

  it("reconnects with the last applied run sequence and cancels reconnect on close", async () => {
    vi.useFakeTimers();
    const scenario = createScenario(base);
    const snapshot = replay(scenario, base + 86000);
    const client = new DemoClient(() => base + 86000);
    vi.spyOn(client, "run").mockResolvedValue(snapshot);
    const events = vi.spyOn(client, "events").mockImplementation(async (_id, after, emit) => {
      emit({ type: "log", runId: snapshot.run.id, seq: after + 1, ts: snapshot.run.createdAt, level: "info", message: "connected" });
      throw new Error("disconnected");
    });
    const store = new RunStore(client);
    await store.open(snapshot.run.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveBeenCalledTimes(2);
    expect(events.mock.calls[1]![1]).toBe(snapshot.lastSeq + 1);
    expect(store.getSnapshot().connection).toBe("reconnecting");
    store.close();
    await vi.advanceTimersByTimeAsync(30000);
    expect(events).toHaveBeenCalledTimes(2);
  });

  it("sorts lazy rows and preserves same-sequence replacement", () => {
    const nodeId = "n"; const ts = new Date(base).toISOString();
    const row = (seq: number, text: string) => ({ seq, nodeId, ts, item: { type: "assistant_message" as const, text } });
    expect(mergeItems([row(3, "old"), row(1, "one")], [row(2, "two"), row(3, "new")]).map(entry => [entry.seq, "text" in entry.item ? entry.item.text : ""])).toEqual([[1, "one"], [2, "two"], [3, "new"]]);
  });
  it("tracks the latest run event including item-only activity and clears it on run change", async () => {
    const client = new DemoClient(() => base); const store = new RunStore(client);
    await store.open("run-idle-gaps"); const snapshot = store.getSnapshot().snapshot!;
    store.apply({ type: "item", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, ts: new Date(base).toISOString(), itemTs: new Date(base).toISOString(), nodeId: snapshot.run.rootNodeId, itemSeq: 1, item: { type: "assistant_message", text: "latest activity" } });
    expect(store.getSnapshot().snapshot!.lastEventAt).toBe(new Date(base).toISOString());
    const next = await client.run("run-conversation");
    await store.open(next.run.id); expect(store.getSnapshot().snapshot!.lastEventAt).toBe(next.lastEventAt);
    store.close();
  });
  it("keeps approval notices when closing and reopening the durable transcript", async () => {
    const client = new DemoClient(() => base); const store = new RunStore(client);
    const before = await client.run("run-local-1");
    await client.approveTeam(before.run.id, before.run.team!.proposals[0]!.id, { note: "独立审查后再交付" });
    for (let round = 0; round < 2; round++) {
      await store.open(before.run.id); await store.loadItems(before.run.rootNodeId);
      const rows = store.getSnapshot().items[before.run.rootNodeId]!;
      expect(rows.some(row => row.item.type === "user_message" && row.item.text.includes('<baton-notice kind="team">') && row.item.text.includes("独立审查后再交付"))).toBe(true);
      store.close();
    }
  });
});

describe("optimistic sending", () => {
  it("reconciles an item received before HTTP by the response itemSeq even without clientId", async () => {
    vi.useFakeTimers(); vi.setSystemTime(base);
    const client = new DemoClient(() => base); let accept: ((value: { accepted: true; delivery: "turn"; itemSeq: number }) => void) | undefined;
    vi.spyOn(client, "send").mockImplementation(() => new Promise(resolve => { accept = resolve; }));
    const store = new RunStore(client); await store.open("run-conversation"); const snapshot = store.getSnapshot().snapshot!; const nodeId = snapshot.run.rootNodeId; await store.loadItems(nodeId);
    const sending = store.sendMessage(nodeId, "client text");
    store.apply({ type: "item", nodeId, itemSeq: 99, runId: snapshot.run.id, seq: snapshot.lastSeq + 1, ts: new Date(base).toISOString(), itemTs: new Date(base).toISOString(), item: { type: "user_message", text: "server normalized text", delivery: "turn" } });
    accept!({ accepted: true, delivery: "turn", itemSeq: 99 }); await sending;
    expect(store.getSnapshot().outgoing[0]).toMatchObject({ state: "accepted", acknowledged: true, itemSeq: 99, text: "server normalized text" });
    await store.loadItems(nodeId, true); expect(store.getSnapshot().outgoing).toEqual([]); store.close();
  });
  it("prunes matched and >2 minute outgoing records on lazy reload without resurrecting a completed turn", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-11-16T08:14:38Z"); const sentAt = Date.now();
    const client = new DemoClient(() => sentAt); vi.spyOn(client, "send").mockResolvedValue({ accepted: true, delivery: "turn", itemSeq: 99 });
    const store = new RunStore(client); await store.open("run-conversation"); const snapshot = store.getSnapshot().snapshot!; const nodeId = snapshot.run.rootNodeId;
    await store.sendMessage(nodeId, "优化创作页底部与计费展示");
    vi.setSystemTime("2026-11-16T08:17:10Z");
    await store.loadItems(nodeId, true); expect(store.getSnapshot().outgoing).toEqual([]);
    vi.setSystemTime(sentAt); await store.sendMessage(nodeId, "legacy response");
    vi.spyOn(client, "items").mockResolvedValue({ items: [{ seq: 99, nodeId, ts: new Date(sentAt).toISOString(), item: { type: "user_message", text: "legacy response", delivery: "turn" } }], lastSeq: 99 });
    await store.loadItems(nodeId, true); expect(store.getSnapshot().outgoing).toEqual([]); store.close();
  });
  it("shows an immediate row, accepts SSE before HTTP and does not regress an acknowledged send on HTTP failure", async () => {
    const client = new DemoClient(() => base); let rejectSend: (error: Error) => void = () => undefined;
    vi.spyOn(client, "send").mockImplementation(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    const store = new RunStore(client); await store.open("run-conversation");
    const before = store.getSnapshot().snapshot!; const nodeId = before.run.rootNodeId;
    const sending = store.sendMessage(nodeId, "hello"); const local = store.getSnapshot().outgoing[0]!;
    expect(local.state).toBe("sending");
    expect(client.send).toHaveBeenCalledWith(nodeId, "hello", local.clientId, "queue");
    const ts = new Date(base).toISOString();
    store.apply({ type: "item", runId: before.run.id, seq: before.lastSeq + 1, nodeId, itemSeq: 8, ts, itemTs: ts, item: { type: "user_message", text: "hello", clientId: local.clientId, delivery: "queued" } });
    expect(store.getSnapshot().outgoing[0]!.state).toBe("accepted");
    expect(store.getSnapshot().lastEventAt[nodeId]).toBe(base);
    rejectSend(new Error("response lost")); await sending;
    expect(store.getSnapshot().outgoing[0]!.state).toBe("accepted"); store.close();
  });
  it("keeps failures retryable with the same clientId and reconciles an acknowledgement by itemSeq", async () => {
    const client = new DemoClient(() => base);
    const send = vi.spyOn(client, "send").mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ accepted: true, delivery: "turn", itemSeq: 20 });
    const store = new RunStore(client); await store.open("run-conversation"); const nodeId = store.getSnapshot().snapshot!.run.rootNodeId;
    await store.sendMessage(nodeId, "retry me"); const message = store.getSnapshot().outgoing[0]!;
    expect(message).toMatchObject({ state: "failed", error: "offline" });
    await store.sendMessage(nodeId, message.text, message.clientId);
    expect(store.getSnapshot().outgoing).toHaveLength(1);
    expect(store.getSnapshot().outgoing[0]).toMatchObject({ state: "accepted", itemSeq: 20, delivery: "turn" });
    expect(send.mock.calls[0]![2]).toBe(send.mock.calls[1]![2]); store.close();
  });
  it.each(["idle", "busy", "paused"] as const)("places a send to a %s node once, before and after HTTP/SSE reconciliation", async status => {
    const client = new DemoClient(() => base);
    const reply = Promise.withResolvers<SendMessageResponse>(); vi.spyOn(client, "send").mockReturnValue(reply.promise);
    const snapshot = await client.run("run-conversation"), nodeId = snapshot.run.rootNodeId;
    if (status !== "busy") snapshot.turns = [];
    if (status === "paused") snapshot.run.status = "paused";
    vi.spyOn(client, "run").mockResolvedValue(snapshot);
    const store = new RunStore(client); await store.open(snapshot.run.id); await store.loadItems(nodeId);
    const text = "follow up", sending = store.sendMessage(nodeId, text), clientId = store.getSnapshot().outgoing[0]!.clientId;
    const delivery = status === "idle" ? "turn" : "queued";
    const locations = (): number[] => {
      const { items, outgoing } = store.getSnapshot();
      return [conversationRows, queuedRows].map(select => select(items[nodeId] ?? [], outgoing, nodeId).filter(({ row }) => row.item.type === "user_message" && row.item.clientId === clientId).length);
    };
    const expected = status === "idle" ? [1, 0] : [0, 1];
    expect(locations()).toEqual(expected);
    const ts = new Date(base).toISOString();
    const event: RunEventEnvelope = { type: "item", nodeId, runId: snapshot.run.id, seq: store.getSnapshot().snapshot!.lastSeq + 1, itemSeq: 999, ts, itemTs: ts, turnId: delivery === "turn" ? "new-turn" : undefined, item: { type: "user_message", text, clientId, delivery } };
    if (status !== "busy") { store.apply(event); expect(locations()).toEqual(expected); }
    reply.resolve({ accepted: true, delivery, itemSeq: 999 }); await sending; expect(locations()).toEqual(expected);
    if (status === "busy") { store.apply(event); expect(locations()).toEqual(expected); }
    expect(store.getSnapshot().outgoing[0]).toMatchObject({ clientId, state: "accepted", acknowledged: true, delivery, itemSeq: 999 });
    store.close();
  });

});

describe("message actions", () => {
  async function setup(agent = "claude") {
    const client = new DemoClient(() => base); const store = new RunStore(client);
    await store.open("run-conversation");
    const nodeId = store.getSnapshot().snapshot!.nodes.find(node => node.agentId === agent)!.id;
    await store.loadItems(nodeId); await store.sendMessage(nodeId, "新的要求");
    const itemSeq = store.getSnapshot().outgoing.at(-1)!.itemSeq!;
    return { client, store, nodeId, itemSeq, key: messageActionKey(nodeId, itemSeq) };
  }
  it("shows pending actions, guards duplicate clicks and reconciles SSE replacements", async () => {
    const { client, store, nodeId, itemSeq, key } = await setup();
    const deliver = client.deliver.bind(client); let finish: (() => void) | undefined;
    const mocked = vi.spyOn(client, "deliver").mockImplementation(() => new Promise(resolve => { finish = () => { void deliver(nodeId, itemSeq, { mode: "steer" }).then(resolve); }; }));
    const action = store.actOnMessage(nodeId, itemSeq, "steer");
    expect(store.getSnapshot().messageActions[key]).toEqual({ pending: "steer", error: undefined });
    await store.actOnMessage(nodeId, itemSeq, "steer"); expect(mocked).toHaveBeenCalledTimes(1);
    finish!(); await action;
    expect(store.getSnapshot().messageActions[key]?.pending).toBeUndefined();
    expect(store.getSnapshot().outgoing.at(-1)).toMatchObject({ delivery: "steered" });
    expect(store.getSnapshot().items[nodeId]!.find(row => row.seq === itemSeq)!.item).toMatchObject({ delivery: "steered", escalated: true });
    mocked.mockRestore();
    await store.actOnMessage(nodeId, itemSeq, "interrupt");
    expect(store.getSnapshot().outgoing.at(-1)).toMatchObject({ delivery: "turn", interrupted: true }); store.close();
  });
  it("records unsupported steering and retracts the same row", async () => {
    const { store, nodeId, itemSeq, key } = await setup("pi");
    await store.actOnMessage(nodeId, itemSeq, "steer");
    expect(store.getSnapshot().messageActions[key]).toEqual({ steerUnsupported: true });
    expect(store.getSnapshot().outgoing.at(-1)?.delivery).toBe("queued");
    await store.actOnMessage(nodeId, itemSeq, "retract");
    expect(store.getSnapshot().outgoing.at(-1)?.delivery).toBe("retracted");
    expect(store.getSnapshot().items[nodeId]!.find(row => row.seq === itemSeq)!.item).toMatchObject({ delivery: "retracted" }); store.close();
  });
  it("keeps network failures retryable and force-refreshes changed rows on 409", async () => {
    const { client, store, nodeId, itemSeq, key } = await setup();
    vi.spyOn(client, "deliver").mockRejectedValueOnce(new Error("offline"));
    await store.actOnMessage(nodeId, itemSeq, "steer");
    expect(store.getSnapshot().messageActions[key]).toEqual({ error: "offline" });
    const old = store.getSnapshot().items[nodeId]!.find(row => row.seq === itemSeq)!;
    const fresh = { ...old, item: { type: "user_message" as const, text: "新的要求", delivery: "turn" as const } };
    vi.spyOn(client, "items").mockResolvedValue({ items: [fresh], lastSeq: itemSeq });
    vi.spyOn(client, "deliver").mockRejectedValueOnce(new HttpError(409, "消息已送达"));
    await store.actOnMessage(nodeId, itemSeq, "steer");
    expect(store.getSnapshot().messageActions[key]).toMatchObject({ error: "消息状态已变化，已刷新。" });
    expect(store.getSnapshot().items[nodeId]!.find(row => row.seq === itemSeq)).toEqual(fresh);
    expect(store.getSnapshot().outgoing).toEqual([]);
    store.close();
  });
  it("handles HTTP before SSE without creating a second message", async () => {
    const { client, store, nodeId, itemSeq } = await setup();
    vi.spyOn(client, "deliver").mockResolvedValue({ accepted: true, delivery: "turn", itemSeq });
    await store.actOnMessage(nodeId, itemSeq, "interrupt");
    const rows = store.getSnapshot().items[nodeId]!.filter(row => row.seq === itemSeq);
    expect(rows).toHaveLength(1); expect(rows[0]!.item).toMatchObject({ delivery: "turn", interrupted: true });
    expect(store.getSnapshot().outgoing.at(-1)).toMatchObject({ delivery: "turn", interrupted: true }); store.close();
  });
  it("anchors a steer confirmed over HTTP until the ordered event arrives", async () => {
    const { client, store, nodeId, itemSeq } = await setup();
    try {
      const before = store.getSnapshot();
      const last = conversationRows(before.items[nodeId]!, before.outgoing, nodeId).at(-1)!.row.seq;
      vi.spyOn(client, "deliver").mockResolvedValue({ accepted: true, delivery: "steered", itemSeq });
      await store.actOnMessage(nodeId, itemSeq, "steer");
      const envelope = { type: "item" as const, runId: before.snapshot!.run.id, nodeId, ts: new Date(base).toISOString(), itemTs: new Date(base).toISOString() };
      const next = itemSeq + 1;
      store.apply({ ...envelope, item: { type: "assistant_message", text: "new output" }, itemSeq: next, seq: before.snapshot!.lastSeq + 1 });
      const transcript = () => conversationRows(store.getSnapshot().items[nodeId]!, store.getSnapshot().outgoing, nodeId).map(entry => entry.row.seq);
      expect(transcript().slice(-3)).toEqual([last, itemSeq, next]);
      store.apply({ ...envelope, itemSeq, item: { type: "user_message", text: "新的要求", delivery: "steered", steeredAfterSeq: next }, seq: before.snapshot!.lastSeq + 2 });
      expect(transcript().slice(-3)).toEqual([last, next, itemSeq]);
    } finally { store.close(); }
  });
  it("does not let a late HTTP steering acknowledgement overwrite a delivered SSE row", async () => {
    const { client, store, nodeId, itemSeq } = await setup();
    let finish: ((response: { accepted: true; delivery: "steered"; itemSeq: number }) => void) | undefined;
    vi.spyOn(client, "deliver").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const action = store.actOnMessage(nodeId, itemSeq, "steer");
    const snapshot = store.getSnapshot().snapshot!;
    store.apply({ type: "item", nodeId, itemSeq, seq: snapshot.lastSeq + 1, runId: snapshot.run.id, ts: new Date(base).toISOString(), itemTs: new Date(base).toISOString(), item: { type: "user_message", text: "新的要求", delivery: "turn", interrupted: true } });
    finish!({ accepted: true, delivery: "steered", itemSeq }); await action;
    expect(store.getSnapshot().items[nodeId]!.find(row => row.seq === itemSeq)!.item).toMatchObject({ delivery: "turn", interrupted: true }); store.close();
  });
  it("accepts an action acknowledged by SSE even when its HTTP response is lost", async () => {
    const { client, store, nodeId, itemSeq, key } = await setup();
    let reject: ((error: Error) => void) | undefined;
    vi.spyOn(client, "retract").mockImplementation(() => new Promise((_resolve, failure) => { reject = failure; }));
    const action = store.actOnMessage(nodeId, itemSeq, "retract");
    const snapshot = store.getSnapshot().snapshot!;
    store.apply({ type: "item", nodeId, itemSeq, seq: snapshot.lastSeq + 1, runId: snapshot.run.id, ts: new Date(base).toISOString(), itemTs: new Date(base).toISOString(), item: { type: "user_message", text: "新的要求", delivery: "retracted" } });
    reject!(new Error("response lost")); await action;
    expect(store.getSnapshot().messageActions[key]).toEqual({});
    expect(store.getSnapshot().outgoing.at(-1)?.delivery).toBe("retracted"); store.close();
  });
});

describe("queue reordering", () => {
  async function setup() {
    const client = new DemoClient(() => base); const store = new RunStore(client);
    await store.open("run-conversation"); const nodeId = store.getSnapshot().snapshot!.run.rootNodeId;
    await store.loadItems(nodeId);
    for (const text of ["第一条", "第二条", "第三条"]) await store.sendMessage(nodeId, text);
    const order = store.getSnapshot().outgoing.map(message => message.itemSeq!);
    const visible = () => queuedRows(store.getSnapshot().items[nodeId] ?? [], store.getSnapshot().outgoing, nodeId, store.getSnapshot().queues[nodeId]?.order).map(entry => entry.row.seq);
    return { client, store, nodeId, order, visible };
  }
  it("optimistically moves with keyboard/pointer orders and commits the complete API permutation", async () => {
    const { client, store, nodeId, order, visible } = await setup();
    const reorder = client.reorderQueue.bind(client); let finish: (() => void) | undefined;
    const request = vi.spyOn(client, "reorderQueue").mockImplementation((_node, body) => new Promise(resolve => { finish = () => { void reorder(nodeId, body).then(resolve); }; }));
    const next = queueMoveOrder(order, order[0]!, 1);
    const action = store.reorderQueue(nodeId, next);
    expect(visible()).toEqual(next); expect(store.getSnapshot().queues[nodeId]?.pending).toBe(true);
    expect(request).toHaveBeenCalledWith(nodeId, { order: next });
    await store.reorderQueue(nodeId, order); expect(request).toHaveBeenCalledTimes(1);
    finish!(); await action; request.mockRestore();
    expect(visible()).toEqual(next); expect(store.getSnapshot().queues[nodeId]?.pending).toBe(false);
    const pointer = queueDropOrder(next, order[2]!, 0); const second = vi.spyOn(client, "reorderQueue");
    await store.reorderQueue(nodeId, pointer); expect(second).toHaveBeenCalledWith(nodeId, { order: pointer }); expect(visible()).toEqual(pointer); store.close();
  });
  it("rolls back a failed reorder without overwriting new queue events", async () => {
    const { client, store, nodeId, order, visible } = await setup();
    vi.spyOn(client, "reorderQueue").mockRejectedValueOnce(new Error("offline"));
    await store.reorderQueue(nodeId, [...order].reverse());
    expect(visible()).toEqual(order); expect(store.getSnapshot().queues[nodeId]).toMatchObject({ pending: false, error: "offline" }); store.close();
  });
  it("rolls back/refetches after 409 and removes messages that already left the queue", async () => {
    const { client, store, nodeId, order, visible } = await setup();
    const initial = store.getSnapshot().items[nodeId]!;
    const fresh = initial.map(row => row.seq === order[0] && row.item.type === "user_message" ? { ...row, item: { ...row.item, delivery: "retracted" as const } } : row);
    vi.spyOn(client, "reorderQueue").mockRejectedValueOnce(new HttpError(409, "queue changed"));
    const items = vi.spyOn(client, "items").mockResolvedValue({ items: fresh, lastSeq: fresh.at(-1)!.seq });
    await store.reorderQueue(nodeId, [...order].reverse());
    expect(items).toHaveBeenCalledWith(nodeId); expect(visible()).toEqual(order.slice(1));
    expect(store.getSnapshot().queues[nodeId]).toMatchObject({ pending: false, error: "队列已变化，已刷新，请重新排序。" }); store.close();
  });
  it("keeps a newer SSE reorder when an older HTTP acknowledgement arrives", async () => {
    const { client, store, nodeId, order, visible } = await setup();
    let finish: ((response: { order: number[] }) => void) | undefined;
    vi.spyOn(client, "reorderQueue").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const action = store.reorderQueue(nodeId, [...order].reverse());
    const latest = [order[1]!, order[0]!, order[2]!];
    for (const [index, seq] of latest.entries()) {
      const snapshot = store.getSnapshot().snapshot!;
      const original = store.getSnapshot().items[nodeId]!.find(row => row.seq === seq)!;
      if (original.item.type === "user_message") store.apply({ type: "item", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, nodeId, itemSeq: seq, ts: new Date(base).toISOString(), itemTs: new Date(base).toISOString(), item: { ...original.item, queuePosition: index + 1 } });
    }
    finish!({ order: [...order].reverse() }); await action;
    expect(visible()).toEqual(latest); store.close();
  });
});

describe("editing queued messages", () => {
  async function setup() {
    const client = new DemoClient(() => base); const store = new RunStore(client);
    await store.open("run-conversation"); const nodeId = store.getSnapshot().snapshot!.run.rootNodeId;
    await store.loadItems(nodeId); await store.sendMessage(nodeId, "原始要求");
    const itemSeq = store.getSnapshot().outgoing.at(-1)!.itemSeq!;
    return { client, store, nodeId, itemSeq, key: messageActionKey(nodeId, itemSeq) };
  }
  it("saves in place, keeps original row time/position, and reconciles edited outgoing text", async () => {
    const { client, store, nodeId, itemSeq, key } = await setup(); const edit = vi.spyOn(client, "edit");
    const original = store.getSnapshot().items[nodeId]!.find(row => row.seq === itemSeq)!;
    expect(await store.editMessage(nodeId, itemSeq, "新的要求\n第二行")).toBe(true);
    expect(edit).toHaveBeenCalledWith(nodeId, itemSeq, { text: "新的要求\n第二行" });
    const changed = store.getSnapshot().items[nodeId]!.find(row => row.seq === itemSeq)!;
    expect(changed.ts).toBe(original.ts); expect(changed.item).toMatchObject({ text: "新的要求\n第二行", delivery: "queued", queuePosition: 1, editedAt: new Date(base).toISOString() });
    expect(store.getSnapshot().outgoing.at(-1)).toMatchObject({ text: "新的要求\n第二行", editedAt: new Date(base).toISOString() });
    expect(store.getSnapshot().messageActions[key]?.pending).toBeUndefined(); store.close();
  });
  it("rejects empty drafts locally and leaves failed saves retryable", async () => {
    const { client, store, nodeId, itemSeq, key } = await setup(); const edit = vi.spyOn(client, "edit").mockRejectedValueOnce(new Error("offline"));
    expect(await store.editMessage(nodeId, itemSeq, " \n ")).toBe(false); expect(edit).not.toHaveBeenCalled(); expect(store.getSnapshot().messageActions[key]?.error).toBe("消息不能为空");
    expect(await store.editMessage(nodeId, itemSeq, "新草稿")).toBe(false); expect(store.getSnapshot().messageActions[key]?.error).toBe("offline");
    expect(store.getSnapshot().outgoing.at(-1)?.text).toBe("原始要求");
    expect(await store.editMessage(nodeId, itemSeq, "新草稿")).toBe(true); store.close();
  });
  it("guards duplicate saves and uses the HTTP fallback when SSE has not arrived", async () => {
    const { client, store, nodeId, itemSeq, key } = await setup(); let resolve: (() => void) | undefined;
    const edit = vi.spyOn(client, "edit").mockImplementation(() => new Promise(done => { resolve = done; }));
    const saving = store.editMessage(nodeId, itemSeq, "新内容"); expect(store.getSnapshot().messageActions[key]?.pending).toBe("edit");
    expect(await store.editMessage(nodeId, itemSeq, "重复")).toBe(false); expect(edit).toHaveBeenCalledTimes(1);
    resolve!(); expect(await saving).toBe(true);
    expect(store.getSnapshot().items[nodeId]!.find(row => row.seq === itemSeq)!.item).toMatchObject({ text: "新内容", delivery: "queued", editedAt: expect.any(String) }); store.close();
  });
  it("refreshes a 409 and keeps the conflict visible after the message leaves the dock", async () => {
    const { client, store, nodeId, itemSeq, key } = await setup();
    const rows = store.getSnapshot().items[nodeId]!.map(row => row.seq === itemSeq && row.item.type === "user_message" ? { ...row, item: { ...row.item, delivery: "turn" as const } } : row);
    vi.spyOn(client, "edit").mockRejectedValue(new HttpError(409, "not queued")); const items = vi.spyOn(client, "items").mockResolvedValue({ items: rows, lastSeq: rows.at(-1)!.seq });
    expect(await store.editMessage(nodeId, itemSeq, "太晚的草稿")).toBe(false); expect(items).toHaveBeenCalledWith(nodeId);
    expect(store.getSnapshot().messageActions[key]?.error).toBe("已送达，无法修改"); expect(store.getSnapshot().queues[nodeId]?.error).toBe("已送达，无法修改");
    expect(queuedRows(store.getSnapshot().items[nodeId]!, store.getSnapshot().outgoing, nodeId)).toHaveLength(0); store.close();
  });
  it("trusts a durable edit acknowledgement when HTTP is lost and never overwrites a newer replacement", async () => {
    const { client, store, nodeId, itemSeq, key } = await setup(); let fail: ((error: Error) => void) | undefined;
    vi.spyOn(client, "edit").mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const saving = store.editMessage(nodeId, itemSeq, "新内容"); const snapshot = store.getSnapshot().snapshot!;
    store.apply({ type: "item", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, nodeId, itemSeq, itemTs: new Date(base).toISOString(), ts: new Date(base + 5000).toISOString(), item: { type: "user_message", text: "新内容", delivery: "queued", queuePosition: 1, editedAt: new Date(base + 5000).toISOString() } });
    fail!(new Error("response lost")); expect(await saving).toBe(true); expect(store.getSnapshot().messageActions[key]?.error).toBeUndefined();
    expect(store.getSnapshot().lastEventAt[nodeId]).toBe(base + 5000); store.close();
  });
  it("does not regress an edit when a newer SSE replacement precedes the HTTP response", async () => {
    const { client, store, nodeId, itemSeq } = await setup(); let resolve: (() => void) | undefined;
    vi.spyOn(client, "edit").mockImplementation(() => new Promise(done => { resolve = done; }));
    const saving = store.editMessage(nodeId, itemSeq, "旧草稿"); const snapshot = store.getSnapshot().snapshot!;
    store.apply({ type: "item", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, nodeId, itemSeq, itemTs: new Date(base).toISOString(), ts: new Date(base + 5000).toISOString(), item: { type: "user_message", text: "另一个标签页的新内容", delivery: "turn", editedAt: new Date(base + 5000).toISOString() } });
    resolve!(); expect(await saving).toBe(true);
    expect(store.getSnapshot().items[nodeId]!.find(row => row.seq === itemSeq)!.item).toMatchObject({ text: "另一个标签页的新内容", delivery: "turn" }); store.close();
  });
});
