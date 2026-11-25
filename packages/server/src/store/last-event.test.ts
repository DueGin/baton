import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, emptyUsage, type BackgroundProcess, type ItemRecord, type PullRequestRecord, type RunEvent, type RunEventEnvelope, type RunSnapshot } from "@baton/protocol";
import { Store } from "./index.js";
import { exportRun } from "../telemetry/index.js";

describe("snapshot.lastEventAt", () => {
  it("is the timestamp of the latest event and appears in run summaries", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "baton-store-")), "baton.db"));
    const ts = "2026-11-13T00:00:00.000Z";
    store.append("r1", { type: "run.created", run: { id: "r1", title: "t", titleSource: "generated", cwd: "/", status: "active", rootNodeId: "n1", policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false }, createdAt: ts, updatedAt: ts, usage: emptyUsage() } });
    const second = store.append("r1", { type: "log", level: "info", message: "x" });
    const snapshot = store.snapshot("r1");
    expect(snapshot.lastSeq).toBe(2);
    expect(snapshot.lastEventAt).toBe(second.ts);
    const summary = store.list().find((r) => r.id === "r1");
    expect(summary?.titleSource).toBe("generated");
    expect(summary?.lastEventAt).toBe(second.ts);
    store.close();
  });

  it("advances lastEventAt but not lastActivityAt for background and PR updates", () => {
    const store = new Store(":memory:"), runId = "r1";
    const createdAt = "2026-11-13T00:00:00.000Z", activityAt = "2026-11-13T00:01:00.000Z";
    const backgroundAt = "2026-11-13T00:02:00.000Z", prAt = "2026-11-13T00:06:00.000Z";
    const initial: RunSnapshot = {
      run: { id: runId, title: "t", cwd: "/", rootNodeId: "n1", status: "active", policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false }, createdAt, updatedAt: createdAt, usage: emptyUsage() },
      nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], lastSeq: 0,
    };
    const process: BackgroundProcess = {
      id: `1234:${Date.parse(activityAt) / 1000}`, runId, pid: 1234, ppid: 1230, pgid: 1234,
      command: "node app.js", ports: [3000], children: [], startedAt: activityAt, status: "running", attribution: "tree", lastSeenAt: backgroundAt,
    };
    const pr: PullRequestRecord = {
      id: `${runId}:github:owner/repo#42`, runId, source: "manual", url: "https://github.com/owner/repo/pull/42",
      forge: "github", repo: "owner/repo", number: 42, state: "open", createdAt: activityAt, lastCheckedAt: prAt,
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0, failedChecks: [] },
    };
    const updates: [string, RunEvent][] = [[backgroundAt, { type: "background", process }], [prAt, { type: "pr", pr }]];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(createdAt);
      store.append(runId, { type: "run.created", run: initial.run });
      vi.setSystemTime(activityAt);
      const activity = store.append(runId, { type: "run.updated", patch: { status: "idle", updatedAt: activityAt } });
      for (const [lastEventAt, update] of updates) {
        vi.setSystemTime(lastEventAt);
        store.append(runId, update);
        const expected = { lastActivityAt: activity.ts, lastEventAt };
        expect(store.snapshot(runId)).toMatchObject(expected);
        expect(store.list().find(({ id }) => id === runId)).toMatchObject(expected);
      }
      expect(store.events(runId).reduce(applyEvent, initial)).toMatchObject({ lastActivityAt: activity.ts, lastEventAt: prAt });
    } finally { vi.useRealTimers(); store.close(); }
  });

  it("preserves itemTs across replacements while event time and lastEventAt advance, including export replay", () => {
    const home = mkdtempSync(join(tmpdir(), "baton-item-time-")), store = new Store(join(home, "baton.db"));
    vi.useFakeTimers();
    try {
      const itemTs = "2026-11-13T00:00:00.000Z", firstTime = "2026-11-13T00:01:00.000Z", secondTime = "2026-11-13T00:02:00.000Z";
      vi.setSystemTime(firstTime);
      store.append("r1", { type: "run.created", run: { id: "r1", title: "t", cwd: "/", status: "active", rootNodeId: "n1", policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false }, createdAt: itemTs, updatedAt: itemTs, usage: emptyUsage() } });
      store.append("r1", { type: "node.created", node: { id: "n1", runId: "r1", parentNodeId: null, delegationId: null, depth: 0, agentId: "fake", title: "t", cwd: "/", status: "running", createdAt: itemTs, updatedAt: itemTs, usage: emptyUsage(), turns: 1 } });
      const row: ItemRecord = { nodeId: "n1", seq: 1, ts: itemTs, item: { type: "user_message", text: "original", delivery: "queued", queuePosition: 1 } };
      const first = store.appendItem("r1", row);
      expect(first).toMatchObject({ type: "item", itemTs, ts: firstTime });
      vi.setSystemTime(secondTime);
      const replacement = store.appendItem("r1", { ...row, item: { type: "user_message", text: "edited", delivery: "queued", queuePosition: 1, editedAt: secondTime } });
      expect(replacement).toMatchObject({ type: "item", itemTs, ts: secondTime });
      expect(Date.parse(replacement.ts)).toBeGreaterThan(Date.parse(first.ts));
      expect(store.items("n1")).toEqual([{ ...row, item: { type: "user_message", text: "edited", delivery: "queued", queuePosition: 1, editedAt: secondTime } }]);
      expect(store.snapshot("r1").lastEventAt).toBe(secondTime);
      expect(store.list()[0]?.lastEventAt).toBe(secondTime);
      const exported = JSON.parse(exportRun(store, "r1", "json")) as { snapshot: RunSnapshot; events: RunEventEnvelope[]; items: ItemRecord[] };
      const replayedItems = new Map<number, ItemRecord>();
      for (const event of exported.events) if (event.type === "item") replayedItems.set(event.itemSeq, { nodeId: event.nodeId, seq: event.itemSeq, ts: event.itemTs, ...(event.turnId ? { turnId: event.turnId } : {}), item: event.item });
      expect([...replayedItems.values()]).toEqual(exported.items);
      const created = exported.events[0]!;
      if (created.type !== "run.created") throw new Error("Expected run.created");
      const initial: RunSnapshot = { run: created.run, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], questions: [], escalations: [], lastSeq: 0 };
      expect(exported.events.reduce(applyEvent, initial)).toEqual(exported.snapshot);
    } finally { vi.useRealTimers(); store.close(); rmSync(home, { recursive: true, force: true }); }
  });
});
