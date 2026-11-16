import { describe, expect, it } from "vitest";
import { applyEvent, type RunEventEnvelope } from "@baton/protocol";
import { DemoClient } from "./client.js";
import { prSummary, pullRequestsAtRow } from "../lib/pull-requests.js";
const base = Date.parse("2026-11-15T01:00:00Z");
describe("PR demo", () => {
  it("covers failure, requested changes, merged, draft, error, closed and success with valid anchors", async () => {
    const client = new DemoClient(() => base); const snapshot = await client.run("run-pull-requests");
    const prs = snapshot.pullRequests!; expect(prs).toHaveLength(8); expect(prSummary(snapshot).count).toBe(5);
    expect(new Set(prs.map(pr => pr.state))).toEqual(new Set(["open", "draft", "merged", "closed", "unknown"]));
    expect(prs.some(pr => pr.checks.state === "failure")).toBe(true); expect(prs.some(pr => pr.reviewDecision === "changes_requested")).toBe(true); expect(prs.some(pr => pr.error)).toBe(true);
    const rows = (await client.items(snapshot.run.rootNodeId)).items;
    for (const pr of prs) {
      expect(pr.id).toBe(`${pr.runId}:${pr.forge}:${pr.repo}#${pr.number}`); expect(Date.parse(pr.createdAt)).toBeLessThanOrEqual(base); expect(snapshot.nodes.some(node => node.id === pr.nodeId)).toBe(true);
      if (pr.source === "created") expect(rows.some(row => pullRequestsAtRow(snapshot, row).some(record => record.id === pr.id))).toBe(true);
    }
    expect(await client.pullRequests()).toHaveLength(5); expect(await client.pullRequests(undefined, "all")).toHaveLength(8); expect(await client.pullRequests("project-notes")).toHaveLength(0);
  });
  it("refreshes, queues feedback with notes, unlinks using a replayable tombstone and relinks", async () => {
    let now = base; const client = new DemoClient(() => now); const before = await client.run("run-pull-requests"); const events: RunEventEnvelope[] = []; const controller = new AbortController(); const stream = client.events(before.run.id, before.lastSeq, event => events.push(event), controller.signal);
    const pr = before.pullRequests![0]!; now += 1000;
    await client.feedbackPullRequest(pr.id, { include: ["checks", "reviews"], note: "优先修复中文边界" });
    const rows = (await client.items(before.run.rootNodeId)).items;
    expect(rows.some(row => row.item.type === "user_message" && row.item.text.includes("integration / CJK search") && row.item.text.includes("优先修复中文边界"))).toBe(true);
    await client.unlinkPullRequest(pr.id); expect((await client.pullRequests()).some(row => row.id === pr.id)).toBe(false); expect((await client.run(before.run.id)).pullRequests!.find(row => row.id === pr.id)?.unlinkedAt).toBeDefined();
    await client.linkPullRequest(before.run.id, { url: pr.url }); expect((await client.pullRequests()).some(row => row.id === pr.id)).toBe(true);
    const error = before.pullRequests!.find(pr => pr.error)!; await client.refreshPullRequest(error.id);
    const after = await client.run(before.run.id); expect(after.pullRequests!.find(pr => pr.id === error.id)).toMatchObject({ lastCheckedAt: new Date(now).toISOString(), error: undefined });
    controller.abort(); await stream; expect(events.reduce(applyEvent, before)).toEqual(after);
  });
  it("links safe URLs in the right run and validates ownership", async () => {
    const client = new DemoClient(() => base); const run = await client.run("run-pull-requests");
    const pr = await client.linkPullRequest(run.run.id, { url: "https://github.com/org/hello/pull/99", nodeId: run.run.rootNodeId });
    expect(pr).toMatchObject({ repo: "org/hello", number: 99, forge: "github", source: "manual", projectId: "project-atlas" });
    const other = await client.linkPullRequest("run-background", { url: pr.url }); expect(other.id).not.toBe(pr.id);
    const gitlab = await client.linkPullRequest(run.run.id, { url: "https://gitlab.com/org/repo/-/merge_requests/23" }); expect(gitlab).toMatchObject({ forge: "gitlab", repo: "org/repo", number: 23 });
    await expect(client.linkPullRequest(run.run.id, { url: "javascript:alert(1)" })).rejects.toThrow("400"); await expect(client.linkPullRequest(run.run.id, { url: pr.url, nodeId: "missing" })).rejects.toThrow("400");
  });
  it("saves GitHub settings without removing title-model settings or exposing its secret", async () => {
    const client = new DemoClient(() => base); const github = { ghPath: "/usr/local/bin/gh", env: { HTTPS_PROXY: "http://127.0.0.1:7890" }, trackMentioned: false };
    const saved = await client.updateSettings({ github }); expect(saved.github).toMatchObject({ ...github, ghFound: true, authenticated: true }); expect(saved.titleModel?.model).toBe("demo-title-model");
    await client.updateSettings({ titleModel: { apiKey: "secret" } }); expect((await client.settings()).github).toMatchObject(github);
    await client.updateSettings({ titleModel: null }); expect((await client.settings()).github).toMatchObject(github);
    expect((await client.settings()).titleModel).toBeUndefined(); expect(JSON.stringify(await client.settings())).not.toContain("secret");
    await client.updateSettings({ github: { ghPath: "" } }); expect((await client.settings()).github?.ghPath).toBeUndefined(); expect((await client.settings()).github?.env).toEqual(github.env);
  });
});
