import type { CreateRunRequest, CreateTaskRequest, PatchTaskRequest, RunSnapshot, RunSummary, StartTaskRequest, StartTasksRequest, StartTasksResponse, TaskRecord, TaskSummary } from "@baton/protocol";
import { HttpError } from "../api.js";
import { compareTasks } from "../lib/tasks.js";

interface TaskEnvironment {
  now: () => number;
  checkProject: (id: string) => void;
  run: (id: string) => RunSummary | undefined;
  createRun: (request: CreateRunRequest) => Promise<RunSnapshot>;
  advance: () => void;
}

function titleOf(input: string): string {
  const title = input.trim();
  if (!title || title.length > 200) throw new HttpError(400, "任务标题须为 1–200 字");
  return title;
}

export class DemoTasks {
  private records = new Map<string, TaskRecord>();
  private starting = new Set<string>();
  private listeners = new Set<() => void>();
  private serial = 0;
  private scheduled = false;
  constructor(private readonly env: TaskEnvironment) {}

  seed(run: RunSummary): void {
    const time = (offset: number) => new Date(this.env.now() - offset).toISOString();
    for (const task of [
      { title: "补齐搜索结果的键盘导航", prompt: "检查上下键选择与回车确认，补充回归测试。", projectId: "project-atlas", agent: "codex", createdAt: time(3_600_000) },
      { title: "整理本周的研究笔记", prompt: "", projectId: "project-notes", createdAt: time(900_000) },
      { title: run.title, prompt: "", projectId: run.projectId!, agent: run.rootAgentId, createdAt: run.createdAt, startedAt: run.createdAt, runId: run.id },
    ]) {
      const id = `task-${++this.serial}`;
      this.records.set(id, { ...task, id, updatedAt: task.createdAt });
    }
  }

  private changed(): void {
    if (this.scheduled || !this.listeners.size) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.listeners.forEach(listener => listener()); });
  }
  runChanged(runId: string): void {
    if (this.listeners.size && [...this.records.values()].some(task => task.runId === runId)) this.changed();
  }
  async events(changed: () => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.listeners.add(changed);
    const timer = setInterval(this.env.advance, 500);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { clearInterval(timer); this.listeners.delete(changed); resolve(); }, { once: true }));
  }

  private summary(task: TaskRecord): TaskSummary {
    const run = task.runId ? this.env.run(task.runId) : undefined;
    return structuredClone({ ...task, status: run?.status ?? (task.runId ? "canceled" : "todo"), ...(run ? { run } : {}) });
  }
  private get(id: string): TaskRecord {
    const task = this.records.get(id);
    if (!task) throw new HttpError(404, "任务不存在");
    return task;
  }
  async list(projectId?: string): Promise<TaskSummary[]> {
    this.env.advance();
    return [...this.records.values()].filter(task => !projectId || task.projectId === projectId).map(task => this.summary(task)).sort(compareTasks);
  }
  async create(input: CreateTaskRequest): Promise<TaskSummary> {
    this.env.checkProject(input.projectId);
    const now = new Date(this.env.now()).toISOString();
    const task = { ...input, id: `task-${++this.serial}`, title: titleOf(input.title), prompt: input.prompt ?? "", createdAt: now, updatedAt: now };
    this.records.set(task.id, task); this.changed(); return this.summary(task);
  }
  async patch(id: string, patch: PatchTaskRequest): Promise<TaskSummary> {
    const task = this.get(id);
    if (this.starting.has(id) || (task.runId && Object.keys(patch).some(key => key !== "title"))) throw new HttpError(409, "任务已开始，只能修改标题");
    if (patch.projectId !== undefined) this.env.checkProject(patch.projectId);
    if (patch.title !== undefined) task.title = titleOf(patch.title);
    if (patch.projectId !== undefined) task.projectId = patch.projectId;
    if (patch.prompt !== undefined) task.prompt = patch.prompt ?? "";
    for (const key of ["agent", "model", "teamPresetId"] as const) {
      if (patch[key] === null) delete task[key]; else if (patch[key] !== undefined) task[key] = patch[key];
    }
    task.updatedAt = new Date(this.env.now()).toISOString(); this.changed(); return this.summary(task);
  }
  async remove(id: string): Promise<void> {
    if (this.starting.has(id)) throw new HttpError(409, "任务正在开始");
    if (!this.records.delete(id)) throw new HttpError(404, "任务不存在");
    this.changed();
  }
  async start(id: string, overrides?: StartTaskRequest): Promise<TaskSummary> {
    const task = this.get(id);
    if (task.runId || this.starting.has(id)) throw new HttpError(409, "任务已开始");
    this.starting.add(id);
    try {
      const { projectId, title, prompt, agent, model, teamPresetId } = task;
      const { run } = await this.env.createRun({ projectId, title, prompt: prompt.trim() || title, agent, model, teamPresetId, ...overrides });
      task.runId = run.id; task.startedAt = run.createdAt; delete task.error;
    } catch (cause) {
      task.error = cause instanceof Error ? cause.message : String(cause);
      throw new HttpError(400, task.error);
    } finally { this.starting.delete(id); task.updatedAt = new Date(this.env.now()).toISOString(); this.changed(); }
    return this.summary(task);
  }
  async startMany({ ids, start }: StartTasksRequest): Promise<StartTasksResponse> {
    const result: StartTasksResponse = { tasks: [], errors: [] };
    for (const id of ids) {
      const task = this.records.get(id);
      if (!task) { result.errors.push({ id, message: "任务不存在" }); continue; }
      if (!task.runId) {
        try { await this.start(id, start); }
        catch (cause) { result.errors.push({ id, message: task.error ?? (cause instanceof Error ? cause.message : String(cause)) }); }
      }
    }
    result.tasks = ids.flatMap(id => { const task = this.records.get(id); return task ? [this.summary(task)] : []; });
    return result;
  }
}
