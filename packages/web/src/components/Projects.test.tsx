import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiClient, HttpError } from "../api.js";
import { DemoClient } from "../demo/client.js";
import { AddProject, DirectoryBrowser, ProjectGroups, ProjectLink, ProjectsEmpty, type ProjectGroupsProps } from "./Projects.js";
import { NewSession } from "./NewRun.js";
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
  it("renders independent project name and branch labels with a full tooltip", async () => {
    const client = new DemoClient(() => now);
    const project = { ...(await client.project("project-atlas")), name: "Atlas workspace with a long name", gitBranch: "fix/agent-initiated-turns" };
    const link = renderToStaticMarkup(<ProjectLink project={project} open={() => undefined} />);
    expect(link).toContain(`title="${project.name}\n${project.path}\n${project.gitBranch}"`);
    expect(link).toContain(`<span class="project-link-name">${project.name}</span><code class="project-link-branch">${project.gitBranch}</code>`);
    expect(renderToStaticMarkup(<ProjectLink project={project} open={() => undefined} details />)).toContain(`<small>${project.path}</small>`);
    expect(renderToStaticMarkup(<ProjectLink project={{ ...project, gitBranch: undefined }} open={() => undefined} />)).not.toContain("project-link-branch");
  });
  it("shows four model marks and an overflow chip, with agent fallbacks and a full tooltip", async () => {
    const client = new DemoClient(() => now);
    const base = (await client.runs()).find(run => run.id === "run-demo")!;
    const noop = () => undefined;
    const props: ProjectGroupsProps = { projects: [], runs: [], runId: null, currentId: null, page: "runs", reveal: null, choose: noop, selectProject: noop, newRun: noop, add: noop, canCreate: true, mutate: async () => {}, loading: false };
    const models = [
      { agentId: "pi", model: "gemini-2.5-pro" },
      { agentId: "codex", model: "local-custom" },
      { agentId: "claude" },
      { agentId: "pi", model: "qwen3-max" },
      { agentId: "pi", model: "deepseek-v4" },
      { agentId: "codex", model: "gpt-5.2" },
    ];
    const html = renderToStaticMarkup(<ProjectGroups {...props} runs={[{ ...base, models, nodeCount: 9 }]} />);
    expect(html.match(/data-agent-vendor="[^"]+"/g)).toEqual(["google", "codex", "claude", "qwen"].map(vendor => `data-agent-vendor="${vendor}"`));
    expect(html).toContain('<span class="run-model-chip run-model-overflow">+2</span>');
    expect(html).toContain("title=\"pi · gemini-2.5-pro\ncodex · local-custom\nclaude · 未知模型\npi · qwen3-max\npi · deepseek-v4\ncodex · gpt-5.2\"");
    expect(html).toContain("<span>9 agents</span>");

    const legacy = renderToStaticMarkup(<ProjectGroups {...props} runs={[{ ...base, models: undefined, agents: ["pi", "codex"], rootAgentId: "codex" }]} />);
    expect(legacy.match(/data-agent-vendor="[^"]+"/g)).toEqual(['data-agent-vendor="codex"', 'data-agent-vendor="pi"']);
    expect(legacy).toContain('title="codex · 未知模型\npi · 未知模型"');
    expect(legacy).not.toContain("run-model-overflow");
  });
  it("hides archived runs in each group and shows the new-session draft first", async () => {
    const client = new DemoClient(() => now); const projects = await client.projects(true);
    const run = (await client.runs())[0]!;
    const runs = [
      { ...run, id: "archived-project-run", title: "Hidden under Atlas", projectId: "project-atlas", archived: true },
      { ...run, id: "archived-legacy-run", title: "Hidden under unassigned", projectId: undefined, archived: true },
      { ...run, id: "legacy-run", title: "Visible legacy run", projectId: undefined },
    ];
    const noop = () => undefined;
    const props: ProjectGroupsProps = { projects, runs, runId: null, currentId: "project-atlas", page: "runs", reveal: null, choose: noop, selectProject: noop, newRun: noop, add: noop, canCreate: true, mutate: async () => {}, loading: false };
    const atlasGroup = (markup: string) => markup.match(/data-project-id="project-atlas".*?<\/section>/s)?.[0] ?? "";
    const html = renderToStaticMarkup(<ProjectGroups {...props} draftProjectId="project-atlas" />);
    expect(html.match(/aria-expanded="false"><span aria-hidden="true">▸<\/span>已归档会话 1/g)).toHaveLength(2);
    expect(html).not.toContain("Hidden under");
    expect(html).toContain("Visible legacy run");
    expect(html).toContain('aria-haspopup="menu"');
    const atlas = atlasGroup(html);
    expect(atlas).toMatch(/<div class="run-list-item selected run-draft" aria-current="page">.*新会话.*草稿.*已归档会话 1/s);
    expect(atlas).not.toContain("＋ 开始第一个会话");
    const withoutDraft = atlasGroup(renderToStaticMarkup(<ProjectGroups {...props} />));
    expect(withoutDraft).toContain("＋ 开始第一个会话");
  });
  it("models run archive conflicts and preserves timestamps on unarchive in demo mode", async () => {
    const client = new DemoClient(() => now);
    const runs = await client.runs();
    const active = runs.find(run => run.status === "active")!;
    const inactive = runs.find(run => run.status !== "active")!;
    const original = (await client.run(inactive.id)).run;
    const conflict = await client.patchRun(active.id, { archived: true }).catch((cause: unknown) => cause);
    expect(conflict).toBeInstanceOf(HttpError);
    expect(conflict).toMatchObject({ status: 409 });
    expect((await client.run(active.id)).run.archived).toBeUndefined();
    await client.patchRun(inactive.id, { archived: true });
    expect((await client.runs()).find(run => run.id === inactive.id)).toMatchObject({ archived: true, archivedAt: new Date(now).toISOString() });
    await client.patchRun(inactive.id, { archived: false });
    expect((await client.run(inactive.id)).run).toMatchObject({ archived: false, archivedAt: new Date(now).toISOString(), status: original.status, policy: original.policy });
  });
  it("requires a project picker and retains payload defaults in New Run", async () => {
    const storage = { getItem: () => null, setItem: () => undefined }; vi.stubGlobal("localStorage", storage);
    const client = new DemoClient(() => now); const projects = await client.projects(true);
    const html = renderToStaticMarkup(<NewSession agents={await client.agents()} presets={await client.teams()} projects={projects} projectId="project-atlas" defaults={{ mode: "solo", maxDepth: 3, maxActiveChildren: 6, autoApprove: false }} create={async () => true} busy={false} client={client} error={null} selectProject={() => undefined} addProject={() => undefined} />);
    for (const text of ["选择项目", "项目（工作目录）", "Atlas", "/workspace/atlas", "添加项目…", "项目内子目录"]) expect(html).toContain(text);
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
