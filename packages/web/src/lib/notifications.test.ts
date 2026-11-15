import { describe, expect, it } from "vitest";
import { DemoClient } from "../demo/client.js";
import { NotificationTracker } from "./notifications.js";

const base = Date.parse("2026-11-10T07:00:00Z");
describe("browser notification decisions", () => {
  it("ignores initial state/visible tab and coalesces each Run for 30 seconds", async () => {
    const client = new DemoClient(() => base); const items = await client.inbox(); const question = items.find(item => item.kind === "question")!;
    const tracker = new NotificationTracker(); tracker.observeInbox([], false);
    tracker.observeInbox([question], true); expect(tracker.drain(base, true)).toHaveLength(1);
    tracker.observeInbox([], true); tracker.observeInbox([question], true);
    expect(tracker.drain(base + 1000, true)).toEqual([]);
    expect(tracker.drain(base + 30000, true)).toHaveLength(1);
    tracker.observeInbox([], true); tracker.observeInbox([question], true); tracker.observeInbox([], true);
    expect(tracker.drain(base + 60000, true)).toEqual([]);
    tracker.observeInbox([], false); tracker.observeInbox([question], false);
    expect(tracker.drain(base + 60000, true)).toEqual([]);
    const initial = new NotificationTracker(); initial.observeInbox(items, true); expect(initial.drain(base, true)).toEqual([]);
  });
  it("notifies only blocking questions and completed Run transitions", async () => {
    const client = new DemoClient(() => base); const items = await client.inbox(); const question = items.find(item => item.kind === "question")!;
    if (question.kind !== "question") throw new Error("expected question");
    const tracker = new NotificationTracker(); tracker.observeInbox([], false);
    tracker.observeInbox([{ ...question, question: { ...question.question, blocking: false } }], true);
    expect(tracker.drain(base, true)).toEqual([]);
    const run = (await client.runs()).find(row => row.id === question.runId)!;
    tracker.observeInbox([], false);
    tracker.observeRuns([{ ...run, status: "active" }], false);
    tracker.observeRuns([{ ...run, status: "idle", activeNodeCount: 0, pendingTotal: 0, backgroundCount: 2 }], true);
    const notice = tracker.drain(base + 1000, true)[0]; expect(notice?.title).toContain("Run 完成"); expect(notice?.body).toContain("仍有 2 个后台进程在运行");
    tracker.observeRuns([{ ...run, status: "idle", activeNodeCount: 0, pendingTotal: 0 }], true);
    expect(tracker.drain(base + 32000, true)).toEqual([]);
  });
});
