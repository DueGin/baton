import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PullRequestList, PullRequestPill, PrDetails } from "./PullRequests.js";
import { ForgeIcon } from "./ForgeIcon.js";
import { TranscriptRow } from "./Transcript.js";
import { DemoClient } from "../demo/client.js";
import { RunDetails } from "./RunDetails.js";
import { ProjectGroups } from "./Projects.js";
import { RunStore } from "../store.js";
import { Transcript } from "./Transcript.js";
const now = Date.parse("2026-11-15T01:00:00Z");
describe("PR surfaces", () => {
  it("exposes run-wide PRs beside background processes, in details and project groups", async () => {
    const client = new DemoClient(() => now); const snapshot = await client.run("run-pull-requests"); const store = new RunStore(client);
    const transcript = renderToStaticMarkup(<Transcript snapshot={snapshot} store={store} items={{}} itemStatus={{}} nodeId={snapshot.run.rootNodeId} setNodeId={() => undefined} now={now} inspect={() => undefined} answer={() => undefined} busy={false} />);
    expect(transcript).toContain("pr-popover-anchor"); expect(transcript).toContain("PR 5");
    const details = renderToStaticMarkup(<RunDetails snapshot={snapshot} client={client} now={now} connection="live" busy={false} close={() => undefined} autoApprove={() => undefined} cancel={() => undefined} openTeam={() => undefined} openPending={() => undefined} />);
    expect(details).toContain("Pull Requests"); expect(details).toContain("关联 PR URL"); expect(details).toContain("提醒我处理");
    const groups = renderToStaticMarkup(<ProjectGroups pullRequests={snapshot.pullRequests} projects={await client.projects()} runs={await client.runs()} runId={snapshot.run.id} currentId="project-atlas" page="runs" reveal={null} choose={() => undefined} selectProject={() => undefined} newRun={() => undefined} add={() => undefined} canCreate mutate={async () => undefined} loading={false} />);
    expect(groups).toContain("project-pr-count pr-tone-red"); expect(groups).toContain("run-pr-count pr-tone-red"); expect(groups).toContain("5 个 open / draft PR");
  });
  it("renders a worst-state pill and hides when no open/draft PR remains", async () => {
    const snapshot = await new DemoClient(() => now).run("run-pull-requests");
    const render = (value: typeof snapshot) => renderToStaticMarkup(<PullRequestPill snapshot={value} open={false} controls="pr-list" onClick={() => undefined} />);
    const html = render(snapshot); expect(html).toContain("PR 5"); expect(html).toContain("pr-tone-red"); expect(html).toContain('aria-controls="pr-list"');
    expect(render({ ...snapshot, pullRequests: [] })).toBe("");
    expect(render({ ...snapshot, pullRequests: snapshot.pullRequests!.filter(pr => ["merged", "closed"].includes(pr.state)) })).toBe("");
  });
  it("shows all states, checks, creator, metadata, errors and action controls", async () => {
    const client = new DemoClient(() => now); const snapshot = await client.run("run-pull-requests");
    const html = renderToStaticMarkup(<PullRequestList snapshot={snapshot} client={client} inspect={() => undefined} />);
    for (const text of ["GitHub", "baton/demo#41", "修复中文搜索边界", "Open", "Draft", "已合并", "已关闭", "状态未知", "integration / CJK search", "请求修改", "有冲突", "128", "5 files", "3 条评论", "Lead", "刷新", "发 CI 失败给 agent", "发评审意见给 agent", "取消关联", "关联 PR URL", "HTTPS_PROXY", "pr-mentioned"]) expect(html).toContain(text);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"'); expect(html).toContain('role="alert"');
    const unsafe = { ...snapshot.pullRequests![0]!, error: "<script>bad()</script>", checks: { ...snapshot.pullRequests![0]!.checks, failedChecks: [{ name: "<img src=x>", url: "javascript:alert(1)" }] } };
    const safe = renderToStaticMarkup(<PrDetails pr={unsafe} snapshot={snapshot} />); expect(safe).not.toContain("<script>"); expect(safe).not.toContain("<img"); expect(safe).not.toContain("javascript:"); expect(safe).toContain("&lt;script&gt;");
  });
  it("inserts one collapsed PR card directly beneath the creating tool and retains the raw tool disclosure", async () => {
    const client = new DemoClient(() => now); const snapshot = await client.run("run-pull-requests"); const node = snapshot.nodes[0]!; const rows = (await client.items(node.id)).items;
    const row = rows.find(row => row.item.type === "tool_call")!; const html = renderToStaticMarkup(<TranscriptRow row={row} node={node} snapshot={snapshot} client={client} inspect={() => undefined} />);
    expect(html.indexOf('class="tool-row')).toBeLessThan(html.indexOf("inline-pr-card")); expect(html).toContain("创建了 PR"); expect(html).toContain("#41"); expect(html).toContain('aria-expanded="false"'); expect(html).toContain('hidden=""');
    expect(html.match(/data-pr-id=/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<TranscriptRow row={rows[0]!} node={node} snapshot={snapshot} />)).not.toContain("inline-pr-card");
  });
  it("uses local forge SVGs with a generic fallback", () => {
    for (const forge of ["github", "gitlab", "other", "unknown"]) { const html = renderToStaticMarkup(<ForgeIcon forge={forge} />); expect(html).toContain("<svg"); expect(html).not.toContain("<img"); expect(html).toContain("aria-label="); }
  });
});
