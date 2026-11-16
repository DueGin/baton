import { describe, expect, it } from "vitest";
import { applyEvent } from "@baton/protocol";
import { pullRequestDemo } from "../demo/pull-requests.js";
import { isOpenPr, linkedPullRequests, PrChangeTracker, prSummary, prTone, pullRequestsAtRow, safePrUrl } from "./pull-requests.js";
import { summarize } from "./derive.js";
import { liveProjectSummaries } from "./projects.js";
import { DemoClient } from "../demo/client.js";

const now = Date.parse("2026-11-15T01:00:00Z"); const gallery = pullRequestDemo(now); const pr = gallery.prs[0]!;
describe("PR derivations", () => {
  it("notifies only transitions into failure, requested changes, merged or closed and ignores unlink", () => {
    const tracker = new PrChangeTracker(); const pending = { ...pr, checks: { ...pr.checks, state: "pending" as const, failed: 0 }, reviewDecision: "review_required" as const };
    expect(tracker.observe([pending])).toEqual([]); expect(tracker.observe([pending])).toEqual([]);
    expect(tracker.observe([pr])[0]).toMatchObject({ runId: pr.runId, terminal: false, title: "PR #41 · CI 失败" }); expect(tracker.observe([pr])).toEqual([]);
    const reviewed = { ...pr, reviewDecision: "changes_requested" as const };
    expect(tracker.observe([reviewed])[0]?.title).toContain("评审要求修改");
    const merged = { ...reviewed, state: "merged" as const }; expect(tracker.observe([merged])[0]).toMatchObject({ terminal: true, title: "PR #41 · 已合并" });
    expect(tracker.observe([{ ...merged, unlinkedAt: pr.createdAt }])).toEqual([]);
  });
  it("counts open/draft only, excludes tombstones everywhere and uses the worst actionable status", async () => {
    const { prs } = gallery;
    expect(prTone(prs)).toBe("red");
    expect(prTone([{ ...pr, checks: { ...pr.checks, state: "success", failed: 0 }, reviewDecision: "changes_requested" }])).toBe("amber");
    const pending = prs.find(pr => pr.state === "draft")!; const success = prs.find(pr => pr.number === 47)!;
    expect(prTone([pending, success])).toBe("blue"); expect(prTone([success])).toBe("green");
    expect(prTone([prs.find(pr => pr.state === "merged")!])).toBe("purple"); expect(prTone([])).toBe("neutral");
    const snapshot = { ...gallery.snapshot, pullRequests: prs.map(pr => ({ ...pr, unlinkedAt: new Date(now).toISOString() })) };
    expect(linkedPullRequests(snapshot)).toEqual([]); expect(prSummary(snapshot)).toMatchObject({ count: 0, tone: "neutral" }); expect(summarize(snapshot).openPrCount).toBe(0);
    expect(isOpenPr(pr)).toBe(true); expect(isOpenPr({ ...pr, unlinkedAt: "now" })).toBe(false);
    const client = new DemoClient(() => now); const runs = await client.runs(); const projects = liveProjectSummaries(await client.projects(), runs);
    expect(projects.find(project => project.id === "project-atlas")?.openPrCount).toBe(5);
    expect(runs.find(run => run.id === gallery.snapshot.run.id)?.openPrCount).toBe(5);
  });
  it("anchors only created PRs to their exact tool span and node", () => {
    const snapshot = { ...gallery.snapshot, pullRequests: gallery.prs }; const row = gallery.items[1]!;
    expect(pullRequestsAtRow(snapshot, row)).toEqual([pr]);
    expect(pullRequestsAtRow(snapshot, { ...row, seq: 99 })).toEqual([pr]);
    expect(pullRequestsAtRow(snapshot, { ...row, nodeId: "other" })).toEqual([]);
    expect(pullRequestsAtRow(snapshot, gallery.items[0]!)).toEqual([]);
    expect(pullRequestsAtRow({ ...snapshot, toolSpans: [] }, row)).toEqual([]);
    expect(pullRequestsAtRow({ ...snapshot, pullRequests: [{ ...pr, unlinkedAt: "now" }] }, row)).toEqual([]);
  });
  it("upserts PR events, preserves snapshots and applies unlink tombstones", () => {
    const before = gallery.snapshot; const first = applyEvent(before, { type: "pr", pr, runId: pr.runId, ts: pr.createdAt, seq: before.lastSeq + 1 });
    expect(before.pullRequests).toEqual([]); expect(first.pullRequests).toEqual([pr]);
    const updated = applyEvent(first, { type: "pr", pr: { ...pr, state: "merged" }, runId: pr.runId, ts: pr.createdAt, seq: first.lastSeq + 1 });
    expect(updated.pullRequests).toHaveLength(1); expect(prSummary(updated).count).toBe(0);
    const unlinked = applyEvent(updated, { type: "pr", pr: { ...pr, unlinkedAt: pr.createdAt }, runId: pr.runId, ts: pr.createdAt, seq: updated.lastSeq + 1 }); expect(linkedPullRequests(unlinked)).toEqual([]);
  });
  it("allows only safe external URLs", () => {
    expect(safePrUrl("https://github.com/a/b/pull/1")).toBe("https://github.com/a/b/pull/1"); expect(safePrUrl("http://git.local/a")).toBeDefined();
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "bad url", ""]) expect(safePrUrl(url)).toBeUndefined();
  });
});
