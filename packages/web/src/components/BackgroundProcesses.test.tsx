import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoClient } from "../demo/client.js";
import { BackgroundList, BackgroundPill, CancelRunDialog } from "./BackgroundProcesses.js";
import { ExitedGroupDetails } from "./ExitedBackgroundHistory.js";
import { backgroundSummary, exitTimeLabel, groupExitedProcesses } from "../lib/background.js";
import { duration } from "../lib/derive.js";
const now = Date.parse("2026-11-15T01:00:00Z");
describe("background process UI", () => {
  it("hides an empty pill and highlights a run-wide count when a process has a port", async () => {
    const snapshot = await new DemoClient(() => now).run("run-background");
    const render = (value: typeof snapshot) => renderToStaticMarkup(<BackgroundPill snapshot={value} open={false} controls="process-list" onClick={() => undefined} />);
    expect(render(snapshot)).toContain("后台 2"); expect(render(snapshot)).toContain("has-ports");
    expect(render(snapshot)).toContain('aria-controls="process-list"');
    expect(render({ ...snapshot, backgroundProcesses: [] })).toBe("");
    const noPorts = { ...snapshot, backgroundProcesses: snapshot.backgroundProcesses!.map(process => ({ ...process, ports: [] })) };
    expect(render(noPorts)).not.toContain("has-ports");
    expect(backgroundSummary(snapshot, snapshot.run.rootNodeId).count).toBe(1);
  });
  it("shows safe commands, port links, attribution, folded children and exited details", async () => {
    const client = new DemoClient(() => now); const snapshot = await client.run("run-background");
    const html = renderToStaticMarkup(<BackgroundList snapshot={snapshot} client={client} now={now} />);
    for (const text of ["npm run dev", "推断", "子进程 1 个", "node node_modules/vite/bin/vite.js", "pid 4202", "复制 cwd", "复制命令", "不是本会话启动的", "已退出 5 个", "已停止 · 人工", "自行退出", "进程树归属", "推断归属", 'href="http://localhost:5173"', 'href="http://localhost:8000"', 'target="_blank" rel="noopener noreferrer"']) expect(html).toContain(text);
    expect(html).toContain("×3"); expect(html).toContain("全部隐藏"); expect(html).toContain(":55218</span>");
    expect(html).not.toContain("localhost:55218"); expect(html).toMatch(/<button [^>]*class="exited-toggle"[^>]*aria-expanded="false"/);
    expect(html).toContain('<details class="background-children"><summary>');
    expect(html).not.toContain('<details class="background-children" open');
    const stopping = { ...snapshot, backgroundProcesses: snapshot.backgroundProcesses!.map(process => process.status === "running" ? { ...process, status: "stopping" as const } : process) };
    const pending = renderToStaticMarkup(<BackgroundList snapshot={stopping} client={client} now={now} />);
    expect(pending).toContain("停止中…"); expect(pending).not.toContain('class="text-button danger-text">停止</button>');
    const unsafe = { ...snapshot, backgroundProcesses: [{ ...snapshot.backgroundProcesses![0]!, command: "<script>bad()</script>", ports: [-1, 1234, 99999] }] };
    const safe = renderToStaticMarkup(<BackgroundList snapshot={unsafe} now={now} />);
    expect(safe).not.toContain("<script>"); expect(safe).toContain("&lt;script&gt;"); expect(safe).not.toContain("localhost:-1"); expect(safe).not.toContain("localhost:99999");
  });
  it("limits the preview to the most recently exited 20 groups, not individual processes", async () => {
    const client = new DemoClient(() => now); const snapshot = await client.run("run-background");
    const latest = backgroundSummary(snapshot).exited.at(-1)!;
    const rows = Array.from({ length: 23 }, (_, index) => ({ ...latest, id: String(index), command: `command-${index}`, exitedAt: new Date(now - index * 1000).toISOString() }));
    const html = renderToStaticMarkup(<BackgroundList snapshot={{ ...snapshot, backgroundProcesses: [...rows, { ...rows[0]!, id: "repeat" }] }} client={client} now={now} />);
    expect(html).toContain("已退出 24 个"); expect(html).toContain("显示全部 23 条"); expect(html).toContain("×2");
    expect(html.match(/class="exited-toggle"/g)).toHaveLength(20); expect(html).toContain('title="command-19"'); expect(html).not.toContain('title="command-20"');
  });
  it("preserves each occurrence's own facts and actions in expanded details", async () => {
    const snapshot = await new DemoClient(() => now).run("run-background");
    const { records } = groupExitedProcesses(backgroundSummary(snapshot).exited)[0]!;
    const node = snapshot.nodes.find(node => node.id === records[0].nodeId)!;
    const html = renderToStaticMarkup(<ExitedGroupDetails records={records} node={node} now={now} inspect={() => undefined} dismiss={() => undefined} canDismiss />);
    expect(html).toContain(`${node.title} ↗</button>`);
    const occurrences = html.split('<li class="exited-record">').slice(1);
    expect(occurrences).toHaveLength(3);
    records.forEach((record, index) => {
      for (const text of [`${record.pid}</code>`, `存活 ${duration(record.startedAt, record.exitedAt!)}`, exitTimeLabel(record.exitedAt, now), record.cwd, `:${record.ports[0]}`, 'aria-label="复制 PID"', "复制 cwd", "不是本会话启动的"]) expect(occurrences[index]).toContain(text);
    });
    expect(html).not.toContain('href="http://localhost:');
  });
  it("offers stopping services as an unchecked cancellation choice", async () => {
    const snapshot = await new DemoClient(() => now).run("run-background");
    const html = renderToStaticMarkup(<CancelRunDialog snapshot={snapshot} busy={false} close={() => undefined} submit={() => undefined} />);
    expect(html).toContain("同时停止 2 个后台进程"); expect(html).toContain('type="checkbox"'); expect(html).not.toContain('checked=""'); expect(html).toContain("确认取消 Run");
  });
});
