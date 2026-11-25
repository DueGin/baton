import { describe, expect, it } from "vitest";
import { DemoClient } from "../demo/client.js";
import { groupProjects, liveProjectSummaries, projectRunPayload, readCollapsedProjects, readCurrentProject, readProjectAgent, saveCollapsedProjects, saveCurrentProject, saveProjectAgent, subdirectoryPath } from "./projects.js";
const now = Date.parse("2026-11-15T01:00:00Z");
describe("project derivations and preferences", () => {
  it("groups and sorts by activity, falling back to updatedAt for legacy runs", async () => {
    const client = new DemoClient(() => now); const projects = await client.projects(true); const runs = await client.runs();
    const target = projects[0]!; const newer = { ...runs[0]!, id: "newer", projectId: target.id, lastActivityAt: undefined, lastEventAt: undefined, updatedAt: "2026-11-15T03:00:00Z" };
    const older = { ...newer, id: "older", updatedAt: "2026-11-15T02:00:00Z" };
    const groups = groupProjects(projects, [older, ...runs, newer]);
    expect(groups[0]!.project.id).toBe(target.id); expect(groups[0]!.runs.slice(0, 2).map(run => run.id)).toEqual(["newer", "older"]);
    expect(groups.flatMap(group => group.runs)).toHaveLength(runs.length + 2);
    const summary = liveProjectSummaries(projects, [newer, older]).find(project => project.id === target.id)!;
    expect(summary.runCount).toBe(2); expect(summary.lastRunAt).toBe(newer.updatedAt);
  });
  it("keeps title changes in place and moves sessions and projects when work resumes", async () => {
    const client = new DemoClient(() => now);
    const atlas = { ...(await client.project("project-atlas")), lastRunAt: "2026-11-15T04:00:00Z" };
    const notes = await client.project("project-notes");
    const base = (await client.runs())[0]!;
    const older = { ...base, id: "older", projectId: atlas.id, lastActivityAt: "2026-11-15T01:00:00Z" };
    const newer = { ...older, id: "newer", lastActivityAt: "2026-11-15T02:00:00Z" };
    const other = { ...older, id: "other", projectId: notes.id, lastActivityAt: "2026-11-15T03:00:00Z" };
    const renamed = { ...older, title: "Renamed", lastEventAt: "2026-11-15T04:00:00Z", updatedAt: "2026-11-15T04:00:00Z" };
    const projects = [atlas, notes];
    const groups = groupProjects(projects, [renamed, newer, other]);
    expect(groups.map(group => group.project.id)).toEqual([notes.id, atlas.id]);
    expect(groups[1]!.runs.map(run => run.id)).toEqual([newer.id, older.id]);
    expect(liveProjectSummaries(projects, [renamed, newer])[0]!.lastRunAt).toBe(newer.lastActivityAt);
    const resumed = { ...renamed, lastActivityAt: "2026-11-15T05:00:00Z" };
    const resumedGroups = groupProjects(projects, [resumed, newer, other]);
    expect(resumedGroups.map(group => group.project.id)).toEqual([atlas.id, notes.id]);
    expect(resumedGroups[0]!.runs.map(run => run.id)).toEqual([older.id, newer.id]);
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
  it("excludes paused sessions from project active counts even with stale active nodes", async () => {
    const client = new DemoClient(() => now); const project = await client.project("project-atlas"); const run = (await client.runs())[0]!;
    const paused = { ...run, projectId: project.id, status: "paused" as const, activeNodeCount: 2 };
    expect(liveProjectSummaries([project], [paused])[0]!.activeRunCount).toBe(0);
  });
});
