import { describe, expect, it } from "vitest";
import type { TaskStatus, TaskSummary } from "@baton/protocol";
import { activityAge, compareTasks, groupTasks, taskAgentDefaults, taskLabels, taskStartBatches } from "./tasks.js";
import { demoAgents } from "../demo/agents.js";
import { summarize } from "./derive.js";
import { createScenario } from "../demo/scenario.js";

function row(status: TaskStatus, time: number, id: string = status): TaskSummary {
  const ts = new Date(time).toISOString();
  return { id, status, title: id, projectId: "p", prompt: "", createdAt: ts, updatedAt: ts, ...(status === "todo" ? {} : { startedAt: ts, runId: id }) };
}
describe("task board", () => {
  it("groups by authoritative task status, with FIFO todos and newest starts first", () => {
    const tasks = [row("paused", 10), row("todo", 20, "later"), row("completed", 30), row("active", 20), row("idle", 40), row("failed", 10), row("canceled", 20), row("todo", 10, "first")];
    const groups = groupTasks(tasks);
    expect(groups.todo.map(task => task.id)).toEqual(["first", "later"]);
    expect(groups.progress.map(task => task.id)).toEqual(["active"]);
    expect(groups.attention.map(task => task.id)).toEqual(["paused"]);
    expect(groups.ended.map(task => task.id)).toEqual(["idle", "completed", "canceled", "failed"]);
    expect(tasks[0]?.status).toBe("paused");
    expect([...tasks].sort(compareTasks).map(task => task.id).slice(0, 3)).toEqual(["first", "later", "idle"]);
    expect(taskLabels.paused).toBe("已暂停");
  });
  it("prioritizes pending work over active/idle, but never over terminal statuses", () => {
    const run = { ...summarize(createScenario(0).initial), pendingTotal: 2 };
    const statuses: TaskStatus[] = ["active", "idle", "paused", "completed", "failed", "canceled"];
    const tasks = statuses.map((status, time) => ({ ...row(status, time), run }));
    expect(groupTasks(tasks).attention.map(task => task.id)).toEqual(["paused", "idle", "active"]);
    expect(groupTasks(tasks).ended.map(task => task.id)).toEqual(["canceled", "failed", "completed"]);
  });
  it("resolves project-specific defaults without overriding pinned agents, models or presets", () => {
    const task = row("todo", 0); const saved = { agentId: "codex", model: "remembered" };
    expect(taskAgentDefaults(task, demoAgents, saved)).toEqual({ agent: "codex", model: "remembered" });
    expect(taskAgentDefaults(task, demoAgents, { ...saved, agentId: "gemini" })).toEqual({ agent: "claude" });
    expect(taskAgentDefaults({ ...task, model: "pinned" }, demoAgents, saved)).toEqual({ agent: "codex" });
    expect(taskAgentDefaults({ ...task, agent: "pi" }, demoAgents, saved)).toEqual({});
    expect(taskAgentDefaults({ ...task, teamPresetId: "team" }, demoAgents, saved)).toEqual({});
    expect(taskAgentDefaults(task, [], saved)).toEqual({});
    const tasks = ["one", "two", "two", "one"].map((projectId, index) => ({ ...task, id: String(index), projectId }));
    expect(taskStartBatches(tasks, entry => taskAgentDefaults(entry, demoAgents, entry.projectId === "two" ? saved : undefined))).toEqual([
      { ids: ["0"], start: { agent: "claude" } }, { ids: ["1", "2"], start: { agent: "codex", model: "remembered" } }, { ids: ["3"], start: { agent: "claude" } },
    ]);
  });
  it("shows activity in the past, handles small clock skew and never displays NaN", () => {
    const at = new Date(0).toISOString();
    expect([-1000, 119999, 3600000, 86400000].map(now => activityAge(at, now))).toEqual(["刚刚", "1 分钟前", "1 小时前", "1 天前"]);
    expect(activityAge("", 0)).toBe("—");
  });
});
