import type { AgentEntry, CreateTaskRequest, PatchTaskRequest, StartTaskRequest, TaskStatus, TaskSummary } from "@baton/protocol";
import { agentReady } from "./agents.js";
import type { ProjectAgent } from "./projects.js";

export const taskLabels: Record<TaskStatus, string> = {
  todo: "待开始", active: "运行中", paused: "已暂停", idle: "空闲", completed: "已完成", failed: "失败", canceled: "已取消",
};

export function compareTasks(left: TaskSummary, right: TaskSummary): number {
  const leftTodo = left.status === "todo"; const rightTodo = right.status === "todo";
  if (leftTodo !== rightTodo) return leftTodo ? -1 : 1;
  return (leftTodo ? left.createdAt.localeCompare(right.createdAt) : (right.startedAt ?? "").localeCompare(left.startedAt ?? "")) || left.id.localeCompare(right.id);
}

function taskColumn({ status, run }: TaskSummary) {
  if (status === "todo") return "todo";
  if (status === "completed" || status === "failed" || status === "canceled") return "ended";
  if (status === "paused" || (run?.pendingTotal ?? 0) > 0) return "attention";
  return status === "active" ? "progress" : "ended";
}

export function groupTasks(tasks: readonly TaskSummary[]) {
  const groups: Record<ReturnType<typeof taskColumn>, TaskSummary[]> = { todo: [], progress: [], attention: [], ended: [] };
  for (const task of [...tasks].sort(compareTasks)) {
    groups[taskColumn(task)].push(task);
  }
  return groups;
}

export function taskAgentDefaults(task: Pick<CreateTaskRequest, "agent" | "model" | "teamPresetId">, agents: AgentEntry[], saved?: ProjectAgent): Pick<StartTaskRequest, "agent" | "model"> {
  if (task.agent || task.teamPresetId) return {};
  const remembered = saved && agents.find(agent => agent.id === saved.agentId && agentReady(agent));
  const agent = remembered ?? agents.find(agentReady);
  const model = !task.model && remembered ? saved?.model : undefined;
  return agent ? { agent: agent.id, ...(model ? { model } : {}) } : {};
}

export function taskChanges(original: TaskSummary, next: CreateTaskRequest): PatchTaskRequest {
  const patch: PatchTaskRequest = {};
  if (original.title !== next.title) patch.title = next.title;
  if (original.prompt !== (next.prompt ?? "")) patch.prompt = next.prompt ?? "";
  if (original.projectId !== next.projectId) patch.projectId = next.projectId;
  for (const key of ["agent", "model", "teamPresetId"] as const) {
    if (original[key] !== next[key]) patch[key] = next[key] ?? null;
  }
  return patch;
}

export function taskStartBatches(tasks: readonly TaskSummary[], resolve: (task: TaskSummary) => ReturnType<typeof taskAgentDefaults>) {
  const batches: { ids: string[]; start: ReturnType<typeof taskAgentDefaults> }[] = [];
  for (const task of tasks) {
    const start = resolve(task); const previous = batches.at(-1);
    if (previous && previous.start.agent === start.agent && previous.start.model === start.model) previous.ids.push(task.id);
    else batches.push({ ids: [task.id], start });
  }
  return batches;
}

export function activityAge(at: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (!Number.isFinite(minutes)) return "—";
  return minutes === 0 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
}
