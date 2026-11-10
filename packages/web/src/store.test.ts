import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEvent, type GetItemsResponse, type RunEventEnvelope } from "@baton/protocol";
import { DemoClient } from "./demo/client.js";
import { createScenario, replay } from "./demo/scenario.js";
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
});
