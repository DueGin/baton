import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoClient } from "../demo/client.js";
import { NewSession } from "./NewRun.js";

const noop = (): void => undefined;
const projectsFixture = async () => {
  const client = new DemoClient(() => Date.parse("2026-11-15T01:00:00Z"));
  const props: ComponentProps<typeof NewSession> = {
    client, agents: await client.agents(), projects: await client.projects(true), presets: await client.teams(),
    defaults: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false }, projectId: "project-atlas",
    create: vi.fn(async () => true), addProject: noop, selectProject: noop, busy: false, error: null,
  };
  return { props, render: (overrides: Partial<typeof props> = {}) => renderToStaticMarkup(<NewSession {...props} {...overrides} />) };
};
beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => null }); });
afterEach(() => vi.unstubAllGlobals());

describe("blank session", () => {
  it("does not open a dialog or create a Run; configuration is separate from the first-message composer", async () => {
    const { props, render } = await projectsFixture();
    const html = render();
    expect(html).toContain("新会话 · Atlas");
    expect(html).not.toContain("<dialog"); expect(html).not.toContain('role="tablist"');
    const [config, composer] = html.split('<form class="composer"');
    for (const caption of ["选择项目", "动态组队", "预设团队", "单独完成", "主导者 Lead", "预先指定成员", "候选成员", "组队后需要我确认", "自动批准权限请求", "项目内子目录", "高级策略"]) expect(config).toContain(caption);
    expect(config).not.toContain("<textarea"); expect(composer).toContain('aria-label="任务"');
    expect(composer).toContain("/ 命令 · @ 文件"); expect(composer).toMatch(/<button[^>]*aria-label="发送"[^>]*disabled/);
    expect(props.create).not.toHaveBeenCalled();
  });

  it("reports invalid workspace, missing preset, and unavailable lead above the composer", async () => {
    const { props, render } = await projectsFixture();
    for (const [html, issue] of [
      [render({ projects: props.projects.map(project => ({ ...project, exists: false })) }), "项目目录不存在"],
      [render({ projectId: "project-archive" }), "请选择项目"],
      [render({ presets: [], defaults: { ...props.defaults, mode: "preset" } }), "请选择团队预设"],
      [render({ agents: [] }), "所选 Agent 当前不可用"],
    ] as const) {
      expect(html).toContain('aria-describedby="new-session-issues"');
      expect(html.indexOf(issue)).toBeGreaterThan(-1); expect(html.indexOf(issue)).toBeLessThan(html.indexOf('<form class="composer"'));
    }
  });

  it("exposes creation progress and failures in the draft, without a modal", async () => {
    const { render } = await projectsFixture();
    const busy = render({ busy: true });
    expect(busy).toContain('aria-busy="true"'); expect(busy).toContain("创建中…"); expect(busy).toMatch(/<textarea[^>]*disabled/);
    const failed = render({ error: "目录不存在" });
    expect(failed).toContain('role="alert">目录不存在'); expect(failed).toContain('aria-label="任务"'); expect(failed).not.toContain("<dialog");
  });
});
