import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoClient } from "../demo/client.js";
import { BackgroundList, BackgroundPill, CancelRunDialog } from "./BackgroundProcesses.js";
import { backgroundSummary } from "../lib/background.js";
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
    for (const text of ["npm run dev", "推断", "子进程 1 个", "node node_modules/vite/bin/vite.js", "pid 4202", "复制 cwd", "复制命令", "不是本会话启动的", "已退出 1 个", "由你停止", "进程树归属", "进程组归属", "推断归属", 'href="http://localhost:5173"', 'href="http://localhost:8000"', 'target="_blank" rel="noopener noreferrer"']) expect(html).toContain(text);
    expect(html).toContain('<details class="background-children"><summary>');
    expect(html).not.toContain('<details class="background-children" open');
    const stopping = { ...snapshot, backgroundProcesses: snapshot.backgroundProcesses!.map(process => process.status === "running" ? { ...process, status: "stopping" as const } : process) };
    const pending = renderToStaticMarkup(<BackgroundList snapshot={stopping} client={client} now={now} />);
    expect(pending).toContain("停止中…"); expect(pending).not.toContain('class="text-button danger-text">停止</button>');
    const unsafe = { ...snapshot, backgroundProcesses: [{ ...snapshot.backgroundProcesses![0]!, command: "<script>bad()</script>", ports: [-1, 1234, 99999] }] };
    const safe = renderToStaticMarkup(<BackgroundList snapshot={unsafe} now={now} />);
    expect(safe).not.toContain("<script>"); expect(safe).toContain("&lt;script&gt;"); expect(safe).not.toContain("localhost:-1"); expect(safe).not.toContain("localhost:99999");
  });
  it("offers stopping services as an unchecked cancellation choice", async () => {
    const snapshot = await new DemoClient(() => now).run("run-background");
    const html = renderToStaticMarkup(<CancelRunDialog snapshot={snapshot} busy={false} close={() => undefined} submit={() => undefined} />);
    expect(html).toContain("同时停止 2 个后台进程"); expect(html).toContain('type="checkbox"'); expect(html).not.toContain('checked=""'); expect(html).toContain("确认取消 Run");
  });
});
