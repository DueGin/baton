import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiClient } from "../api.js";
import { DemoClient } from "../demo/client.js";
import { AddProject, DirectoryBrowser, ProjectGroups, ProjectLink, ProjectsEmpty } from "./Projects.js";
import { NewRun } from "./NewRun.js";
import { projectRunPayload } from "../lib/projects.js";
const now = Date.parse("2026-11-15T01:00:00Z");
afterEach(() => vi.unstubAllGlobals());
describe("project screens", () => {
  it("provides a mandatory empty-state CTA and add-project directory browser", async () => {
    const client = new DemoClient(() => now); const dirs = await client.dirs("~");
    const empty = renderToStaticMarkup(<ProjectsEmpty add={() => undefined} />); expect(empty).toContain("添加项目（工作目录）后才能开始会话");
    const dialog = renderToStaticMarkup(<AddProject client={client} close={() => undefined} added={async () => undefined} />);
    for (const text of ["项目路径", "项目名称", "添加项目", "Home", "上级", "选择当前文件夹"]) expect(dialog).toContain(text);
    const browser = renderToStaticMarkup(<DirectoryBrowser value={dirs} loading={false} browse={() => undefined} select={() => undefined} />);
    for (const text of ["atlas", "git-badge", "已是项目", "进入 atlas", "目录路径", "选择当前文件夹"]) expect(browser).toContain(text);
  });
  it("renders grouped runs, project actions, counters and archived access", async () => {
    const client = new DemoClient(() => now); const projects = await client.projects(true); const runs = await client.runs();
    const html = renderToStaticMarkup(<ProjectGroups projects={projects} runs={runs} runId={null} currentId="project-atlas" page="runs" reveal={null} choose={() => undefined} selectProject={() => undefined} newRun={() => undefined} add={() => undefined} canCreate mutate={async () => undefined} loading={false} />);
    for (const text of ["Atlas", "研究笔记", "已归档项目", "添加项目", "重命名", "复制路径", "归档", "活跃", "待处理", "在 Atlas 新建 Run", "后台服务"]) expect(html).toContain(text);
    expect(html).toContain('<details class="project-menu" data-menu="true">');
    expect(html).not.toContain("旧版原型");
    const legacy = renderToStaticMarkup(<ProjectGroups projects={projects} runs={[{ ...runs[0]!, projectId: undefined, title: "Legacy run" }]} runId={null} currentId={null} page="runs" reveal={null} choose={() => undefined} selectProject={() => undefined} newRun={() => undefined} add={() => undefined} canCreate mutate={async () => undefined} loading={false} />);
    expect(legacy).toContain("未归属"); expect(legacy).toContain("Legacy run");
    const link = renderToStaticMarkup(<ProjectLink project={projects[0]!} open={() => undefined} details />); expect(link).toContain(projects[0]!.path); expect(link).toContain(projects[0]!.name);
  });
  it("requires a project picker and retains payload defaults in New Run", async () => {
    const storage = { getItem: () => null, setItem: () => undefined }; vi.stubGlobal("localStorage", storage);
    const client = new DemoClient(() => now); const projects = await client.projects(true);
    const html = renderToStaticMarkup(<NewRun agents={await client.agents()} presets={await client.teams()} projects={projects} initialProjectId="project-atlas" defaults={{ mode: "solo", maxDepth: 3, maxActiveChildren: 6, autoApprove: false }} close={() => undefined} create={async () => true} busy={false} demo error={null} selectProject={() => undefined} addProject={() => undefined} />);
    for (const text of ["搜索项目", "选择项目", "项目（工作目录）", "Atlas", "/workspace/atlas", "添加项目…", "项目内子目录"]) expect(html).toContain(text);
    expect(html).not.toContain("旧版原型"); expect(html).not.toContain('pattern="/.*"');
  });
  it("follows the mocked directory/add/archive/restore/create API flow", async () => {
    const client = new ApiClient("token"); const demo = new DemoClient(() => now); const project = await demo.project("project-atlas");
    const fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (url.startsWith("/api/fs/dirs")) return Response.json(await demo.dirs(new URL(url, "http://localhost").searchParams.get("path") ?? "~"));
      if (url === "/api/projects" && init.method === "POST") return Response.json(project);
      if (url.startsWith("/api/projects/")) return Response.json({ ...project, ...JSON.parse(init.body as string) });
      return Response.json({ run: { id: "run-created" } });
    }); vi.stubGlobal("fetch", fetch);
    expect((await client.dirs("~")).dirs.some(dir => dir.name === "atlas")).toBe(true);
    const added = await client.createProject({ path: "~/atlas", name: "Atlas" });
    await client.patchProject(added.id, { archived: true }); await client.patchProject(added.id, { archived: false });
    await client.createRun(projectRunPayload(project, "", { agent: "claude", prompt: "检查" }));
    expect(fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([["/api/fs/dirs?path=~", "GET"], ["/api/projects", "POST"], ["/api/projects/project-atlas", "PATCH"], ["/api/projects/project-atlas", "PATCH"], ["/api/runs", "POST"]]);
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body as string)).toEqual({ agent: "claude", prompt: "检查", projectId: "project-atlas" });
  });
});
