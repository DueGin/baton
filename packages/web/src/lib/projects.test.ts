import { describe, expect, it } from "vitest";
import { DemoClient } from "../demo/client.js";
import { groupProjects, liveProjectSummaries, projectRunPayload, readCollapsedProjects, readCurrentProject, readProjectAgent, saveCollapsedProjects, saveCurrentProject, saveProjectAgent, subdirectoryPath } from "./projects.js";
const now = Date.parse("2026-11-15T01:00:00Z");
describe("project derivations and preferences", () => {
  it("groups by project, sorts projects by run activity and runs by updatedAt", async () => {
    const client = new DemoClient(() => now); const projects = await client.projects(true); const runs = await client.runs();
    const target = projects[0]!; const newer = { ...runs[0]!, id: "newer", projectId: target.id, updatedAt: "2026-11-15T03:00:00Z" };
    const older = { ...newer, id: "older", updatedAt: "2026-11-15T02:00:00Z" };
    const groups = groupProjects(projects, [older, ...runs, newer]);
    expect(groups[0]!.project.id).toBe(target.id); expect(groups[0]!.runs.slice(0, 2).map(run => run.id)).toEqual(["newer", "older"]);
    expect(groups.flatMap(group => group.runs)).toHaveLength(runs.length + 2);
    const summary = liveProjectSummaries(projects, [newer, older]).find(project => project.id === target.id)!;
    expect(summary.runCount).toBe(2); expect(summary.lastRunAt).toBe(newer.updatedAt);
  });
  it("persists current project, collapsed groups and agent fields independently per project", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readCurrentProject(storage)).toBeNull(); saveCurrentProject(storage, "atlas"); expect(readCurrentProject(storage)).toBe("atlas");
    saveCollapsedProjects(storage, new Set(["atlas", "notes"])); expect([...readCollapsedProjects(storage)]).toEqual(["atlas", "notes"]);
    saveProjectAgent(storage, "atlas", { agentId: "codex", model: "model-a", modeId: "plan", thinking: "high" });
    expect(readProjectAgent(storage, "atlas")).toEqual({ agentId: "codex", model: "model-a", modeId: "plan", thinking: "high" }); expect(readProjectAgent(storage, "notes")).toBeUndefined();
    expect(readCurrentProject({ getItem: () => { throw new Error("denied"); } })).toBeNull();
  });
  it("requires a live project, omits default cwd and safely resolves a relative subdir", async () => {
    const client = new DemoClient(() => now); const project = await client.project("project-atlas"); const body = { agent: "claude", prompt: "检查" };
    expect(projectRunPayload(project, "", body)).toEqual({ ...body, projectId: project.id });
    expect(projectRunPayload(project, "packages/web", body)).toEqual({ ...body, projectId: project.id, cwd: "/workspace/atlas/packages/web" });
    expect(subdirectoryPath(project.path, "src/../docs")).toEqual({ cwd: "/workspace/atlas/docs" });
    expect(subdirectoryPath(project.path, "src/..")).toEqual({});
    for (const path of ["../other", "src/../../outside", "/tmp", "~", "C:/tmp", "src\\other", "src\n"]) expect(subdirectoryPath(project.path, path).error).toBeDefined();
    expect(() => projectRunPayload(undefined, "", body)).toThrow("请选择"); expect(() => projectRunPayload({ ...project, archived: true }, "", body)).toThrow("未归档"); expect(() => projectRunPayload({ ...project, exists: false }, "", body)).toThrow("目录不存在");
  });
});
