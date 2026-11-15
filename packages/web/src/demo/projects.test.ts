import { describe, expect, it } from "vitest";
import { DemoClient } from "./client.js";
const now = Date.parse("2026-11-15T01:00:00Z");
describe("project demo", () => {
  it("distributes every run among three projects and browses a fake directory tree", async () => {
    const client = new DemoClient(() => now); const projects = await client.projects(true); const runs = await client.runs();
    expect(projects).toHaveLength(3); expect(await client.projects()).toHaveLength(2);
    expect(projects.some(project => project.gitBranch === "main")).toBe(true);
    expect(runs.every(run => projects.some(project => project.id === run.projectId))).toBe(true);
    expect((await client.runs("project-notes")).every(run => run.projectId === "project-notes")).toBe(true);
    const dirs = await client.dirs("~"); expect(dirs.path).toBe("/workspace"); expect(dirs.dirs.find(dir => dir.name === "atlas")).toMatchObject({ isGitRepo: true, isProject: true });
    expect((await client.dirs("/workspace/atlas/src")).parent).toBe("/workspace/atlas");
    await expect(client.dirs("/missing")).rejects.toThrow("目录不存在");
  });
  it("registers paths once, renames, archives, restores and auto-restores an existing project", async () => {
    const client = new DemoClient(() => now); const project = await client.createProject({ path: "~/playground" });
    expect(project.name).toBe("playground"); expect((await client.createProject({ path: "/workspace/playground" })).id).toBe(project.id);
    await client.patchProject(project.id, { name: "实验" }); expect((await client.project(project.id)).name).toBe("实验");
    await client.patchProject(project.id, { archived: true }); expect((await client.projects()).some(entry => entry.id === project.id)).toBe(false);
    expect((await client.projects(true)).find(entry => entry.id === project.id)?.archived).toBe(true);
    expect((await client.createProject({ path: "~/playground" })).archived).toBe(false);
    await client.patchProject(project.id, { archived: true }); await client.patchProject(project.id, { archived: false }); expect((await client.project(project.id)).archived).toBe(false);
    await expect(client.patchProject("project-atlas", { archived: true })).rejects.toThrow("409");
    await expect(client.createProject({ path: "/workspace/file.txt" })).rejects.toThrow("不是目录");
  });
  it("refuses missing or archived projects and outside cwd, and defaults cwd to the project", async () => {
    const client = new DemoClient(() => now); const body = { agent: "claude", prompt: "检查", policy: { mode: "solo" as const } };
    await expect(client.createRun({ ...body, projectId: "missing" })).rejects.toThrow("项目不存在");
    await expect(client.createRun({ ...body, projectId: "project-archive" })).rejects.toThrow("归档");
    await expect(client.createRun({ ...body, projectId: "project-atlas", cwd: "/tmp/demo" })).rejects.toThrow("越出");
    expect((await client.createRun({ ...body, projectId: "project-atlas" })).run).toMatchObject({ projectId: "project-atlas", cwd: "/workspace/atlas" });
    expect((await client.createRun({ ...body, projectId: "project-atlas", cwd: "/workspace/atlas/packages/web" })).run.cwd).toBe("/workspace/atlas/packages/web");
  });
});
