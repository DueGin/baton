import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoClient } from "../demo/client.js";
import { RunBar } from "./RunBar.js";
import { RunDetails } from "./RunDetails.js";
import { ConversationStatus } from "./Transcript.js";

const now = Date.parse("2026-11-10T07:00:00Z");
describe("compact Run chrome", () => {
  it("puts tabs, title, status, mini metrics and an accessible details toggle in one toolbar", async () => {
    const snapshot = await new DemoClient(() => now).run("run-demo");
    const html = renderToStaticMarkup(<RunBar snapshot={snapshot} tab="transcript" setTab={() => undefined} detailsOpen={false} toggleDetails={() => undefined} />);
    expect(html).toContain(`title="${snapshot.run.title}"`);
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toContain('id="run-tab-transcript" role="tab" aria-selected="true"');
    expect(html).toContain('aria-expanded="false"'); expect(html).toContain('aria-controls="run-details"');
    expect(html).not.toContain(snapshot.run.cwd); expect(html).not.toContain("取消 Run");
    expect(html).not.toContain("run-stats"); expect(html).not.toContain("autoApprove");
  });
  it("keeps full metadata, policy and cancel actions in the details panel", async () => {
    const snapshot = await new DemoClient(() => now).run("run-demo");
    const html = renderToStaticMarkup(<RunDetails snapshot={snapshot} now={now} connection="live" busy={false} close={() => undefined} autoApprove={() => undefined} cancel={() => undefined} openTeam={() => undefined} openPending={() => undefined} />);
    for (const text of [snapshot.run.title, snapshot.run.cwd, "复制路径", "Run 详情", "活跃 / 总节点", "Cached tokens", "运行时间", "委派 / 回合", "权限请求", "名单确认", "Agent 提问", "需要介入", "动态组队", "autoApprove", "团队人数", "停滞提醒", "委派轮次", "查看团队", "取消 Run"]) expect(html).toContain(text);
    expect(html).toContain('aria-label="关闭 Run 详情"');
  });
  it("keeps status on one line by default and names child waiting time correctly", async () => {
    const snapshot = await new DemoClient(() => now).run("run-demo");
    const waiting = renderToStaticMarkup(<ConversationStatus phase={{ kind: "children", label: "等待 2 个子任务", since: new Date(now - 149_000).toISOString(), quiet: 45, related: [], tokens: 1200 }} snapshot={snapshot} now={now} inspect={() => undefined} />);
    expect(waiting).toContain("等待 2m 29s"); expect(waiting).not.toContain("本轮"); expect(waiting).toContain("已 45s 无新输出");
    const thinking = renderToStaticMarkup(<ConversationStatus phase={{ kind: "reasoning", label: "思考中", reasoning: "hidden live reasoning", since: new Date(now).toISOString(), quiet: 0, related: [], tokens: 0 }} snapshot={snapshot} now={now} inspect={() => undefined} />);
    expect(thinking).toContain('aria-expanded="false"'); expect(thinking).toContain("展开实时思考");
    expect(thinking).not.toContain("hidden live reasoning"); expect(thinking).toContain("本轮 0s");
  });
});
