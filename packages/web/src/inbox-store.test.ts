import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@baton/protocol";
import { DemoClient } from "./demo/client.js";
import { InboxStore } from "./inbox-store.js";

const base = Date.parse("2026-11-10T07:00:00Z");
afterEach(() => vi.useRealTimers());
describe("cross-run inbox subscription", () => {
  it("refetches after every changed, including a change during an in-flight snapshot", async () => {
    const client = new DemoClient(() => base); const rows = await client.inbox();
    let changed: (() => void) | undefined; let release: ((items: InboxItem[]) => void) | undefined;
    vi.spyOn(client, "inboxEvents").mockImplementation((callback, signal) => { changed = callback; return new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); });
    const fetch = vi.spyOn(client, "inbox").mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(rows);
    const store = new InboxStore(client); store.start(); changed!(); release!([]); await store.refresh();
    expect(fetch).toHaveBeenCalledTimes(2); expect(store.getSnapshot().items).toEqual(rows);
    changed!(); await store.refresh(); expect(fetch).toHaveBeenCalledTimes(4); // changed + explicit manual refresh
    store.stop();
  });
  it("ignores stale snapshots across stop/restart and reconnects after disconnect", async () => {
    vi.useFakeTimers(); const client = new DemoClient(() => base); const rows = await client.inbox();
    let release: ((items: InboxItem[]) => void) | undefined;
    vi.spyOn(client, "inbox").mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(rows);
    const stream = vi.spyOn(client, "inboxEvents").mockRejectedValue(new Error("disconnected"));
    const store = new InboxStore(client); store.start(); store.stop(); store.start(); await store.refresh();
    release!([]); await Promise.resolve(); await Promise.resolve();
    expect(store.getSnapshot().items).toEqual(rows);
    await vi.advanceTimersByTimeAsync(1000); expect(stream).toHaveBeenCalledTimes(3);
    store.stop(); await vi.advanceTimersByTimeAsync(30000); expect(stream).toHaveBeenCalledTimes(3);
  });
});
