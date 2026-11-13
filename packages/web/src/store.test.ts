import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEvent, type GetItemsResponse, type RunEventEnvelope } from "@baton/protocol";
import { DemoClient } from "./demo/client.js";
import { createScenario, replay } from "./demo/scenario.js";
import { deliveryLabel } from "./lib/conversation.js";
import { mergeItems, RunStore } from "./store.js";

const base = Date.parse("2026-11-10T07:00:00Z");
afterEach(() => vi.useRealTimers());

describe("RunStore and protocol integration", () => {
  it("applies an ordered live stream, replaces itemSeq and ignores old/cross-run envelopes", async () => {
    const client = new DemoClient(() => base + 86000);
    const store = new RunStore(client);
    await store.open("run-demo");
    const before = store.getSnapshot().snapshot!;
    const nodeId = before.run.rootNodeId;
    await store.loadItems(nodeId);
    const count = store.getSnapshot().items[nodeId]!.length;
    const next: RunEventEnvelope = { runId: before.run.id, seq: before.lastSeq + 1, ts: new Date(base + 90000).toISOString(), type: "item", nodeId, itemSeq: 1, item: { type: "user_message", text: "replaced" } };
    store.apply(next);
    expect(store.getSnapshot().items[nodeId]).toHaveLength(count);
    expect(store.getSnapshot().items[nodeId]![0]!.item).toEqual({ type: "user_message", text: "replaced" });
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
    store.apply({ type: "item", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, itemSeq: 1, ts: row.ts, nodeId, item: { type: "assistant_message", text: "new stream content" } });
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
    store.apply({ type: "item", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, ts: new Date(base).toISOString(), nodeId: snapshot.run.rootNodeId, itemSeq: 1, item: { type: "assistant_message", text: "latest activity" } });
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
      expect(rows.some(row => row.item.type === "user_message" && row.item.text.includes("<baton-notice>") && row.item.text.includes("独立审查后再交付"))).toBe(true);
      store.close();
    }
  });
});

describe("optimistic sending", () => {
  it("shows an immediate row, accepts SSE before HTTP and does not regress an acknowledged send on HTTP failure", async () => {
    const client = new DemoClient(() => base); let rejectSend: (error: Error) => void = () => undefined;
    vi.spyOn(client, "send").mockImplementation(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    const store = new RunStore(client); await store.open("run-conversation");
    const before = store.getSnapshot().snapshot!; const nodeId = before.run.rootNodeId;
    const sending = store.sendMessage(nodeId, "hello"); const local = store.getSnapshot().outgoing[0]!;
    expect(local.state).toBe("sending");
    const ts = new Date(base).toISOString();
    store.apply({ type: "item", runId: before.run.id, seq: before.lastSeq + 1, nodeId, itemSeq: 8, ts, item: { type: "user_message", text: "hello", clientId: local.clientId, delivery: "queued" } });
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
  it("does not mistake the server's transient queued record for an actual queued delivery", async () => {
    const client = new DemoClient(() => base);
    let accept: (value: { accepted: true; delivery: "turn"; itemSeq: number }) => void = () => undefined;
    vi.spyOn(client, "send").mockImplementation(() => new Promise(resolve => { accept = resolve; }));
    const store = new RunStore(client); await store.open("run-conversation");
    const snapshot = store.getSnapshot().snapshot!; const nodeId = snapshot.run.rootNodeId;
    const sending = store.sendMessage(nodeId, "start a new turn");
    const clientId = store.getSnapshot().outgoing[0]!.clientId;
    const event: RunEventEnvelope = { type: "item", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, nodeId, itemSeq: 10, ts: new Date(base).toISOString(), item: { type: "user_message", text: "start a new turn", delivery: "queued", clientId } };
    store.apply(event);
    store.apply({ ...event, seq: event.seq + 1, item: { type: "user_message", text: "start a new turn", delivery: "turn", clientId } });
    accept({ accepted: true, delivery: "turn", itemSeq: 10 }); await sending;
    const message = store.getSnapshot().outgoing[0]!;
    expect(deliveryLabel(message.delivery, message.wasQueued)).toBe("已开始新一轮"); store.close();
  });

});
