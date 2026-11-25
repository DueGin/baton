import { randomUUID } from "node:crypto";
import type { CreateRunRequest, RunSnapshot, RunSummary, StartTaskRequest, StartTasksResponse, TaskRecord, TaskSummary } from "@baton/protocol";
import type { Store } from "../store/index.js";

export class TaskError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const optionalFields = ["agent", "model", "teamPresetId"] as const;

function title(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 200) throw new TaskError(400, "Task title must contain 1–200 characters");
  return trimmed;
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== "string") throw new TaskError(400, `${key} must be a string`);
  return value;
}

function startOptions(value: unknown): StartTaskRequest {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskError(400, "Expected a task start options object");
  const input = value as Record<string, unknown>, overrides: StartTaskRequest = {};
  for (const key of [...optionalFields, "modeId", "thinking"] as const) {
    if (input[key] !== undefined) overrides[key] = stringField(input[key], key);
  }
  if (input.policy !== undefined) {
    if (!input.policy || typeof input.policy !== "object" || Array.isArray(input.policy)) throw new TaskError(400, "policy must be an object");
    overrides.policy = input.policy as StartTaskRequest["policy"];
  }
  return overrides;
}

export class Tasks {
  private readonly inFlight = new Set<string>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly store: Store, private readonly createRun: (input: CreateRunRequest) => Promise<RunSnapshot>) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch {}
    }
  }

  private save(task: TaskRecord): void {
    this.store.saveTask(task);
    this.changed();
  }

  private projectId(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) throw new TaskError(400, "projectId is required");
    if (this.store.project(value).archived) throw new TaskError(400, "Project is archived");
    return value;
  }

  private ensureNotStarting(id: string): void {
    if (this.inFlight.has(id)) throw new TaskError(409, "Task is already starting");
  }

  create(input: Record<string, unknown>): TaskSummary {
    const timestamp = new Date().toISOString();
    const task: TaskRecord = {
      id: randomUUID(), title: title(input.title), projectId: this.projectId(input.projectId),
      prompt: input.prompt === undefined ? "" : stringField(input.prompt, "prompt"), createdAt: timestamp, updatedAt: timestamp,
    };
    for (const key of optionalFields) if (input[key] !== undefined) task[key] = stringField(input[key], key);
    this.save(task);
    return this.summary(task);
  }

  patch(id: string, input: Record<string, unknown>): TaskSummary {
    const task = this.store.task(id);
    this.ensureNotStarting(id);
    if (task.runId && Object.keys(input).some((key) => key !== "title")) throw new TaskError(409, "Only title may be changed after starting a task");
    if (input.title !== undefined) task.title = title(input.title);
    if (input.projectId !== undefined) task.projectId = this.projectId(input.projectId);
    if (input.prompt !== undefined) task.prompt = input.prompt === null ? "" : stringField(input.prompt, "prompt");
    for (const key of optionalFields) {
      if (input[key] === null) delete task[key];
      else if (input[key] !== undefined) task[key] = stringField(input[key], key);
    }
    task.updatedAt = new Date().toISOString();
    this.save(task);
    return this.summary(task);
  }

  delete(id: string): void {
    this.ensureNotStarting(id);
    this.store.deleteTask(id);
    this.changed();
  }

  async start(id: string, input?: Record<string, unknown>): Promise<TaskSummary> {
    const task = this.store.task(id);
    if (task.runId) throw new TaskError(409, "Task has already started");
    this.ensureNotStarting(id);
    return this.summary(await this.startTask(task, startOptions(input)));
  }

  private async startTask(task: TaskRecord, overrides: StartTaskRequest): Promise<TaskRecord> {
    this.ensureNotStarting(task.id);
    this.inFlight.add(task.id);
    try {
      let snapshot: RunSnapshot;
      try {
        const projectId = this.projectId(task.projectId);
        snapshot = await this.createRun({
          projectId, title: task.title, prompt: task.prompt.trim() || task.title,
          agent: task.agent, model: task.model, teamPresetId: task.teamPresetId, ...overrides,
        });
      } catch (error) {
        task.error = error instanceof Error ? error.message : String(error);
        task.updatedAt = new Date().toISOString();
        this.save(task);
        throw new TaskError(400, task.error);
      }
      task.runId = snapshot.run.id;
      task.startedAt = task.updatedAt = new Date().toISOString();
      delete task.error;
      this.save(task);
      return task;
    } finally { this.inFlight.delete(task.id); }
  }

  async startMany(input: Record<string, unknown>): Promise<StartTasksResponse> {
    const { ids, start } = input;
    if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string" && !!id.trim())) throw new TaskError(400, "ids must be an array of task IDs");
    const overrides = startOptions(start), errors: StartTasksResponse["errors"] = [];
    for (const id of ids) {
      try {
        const task = this.store.task(id);
        if (!task.runId) await this.startTask(task, overrides);
      } catch (error) { errors.push({ id, message: error instanceof Error ? error.message : String(error) }); }
    }
    const byId = new Map(this.store.tasks().map((task) => [task.id, task]));
    const summaries = new Map<string, RunSummary | undefined>();
    return { tasks: ids.flatMap((id) => { const task = byId.get(id); return task ? [this.summary(task, summaries)] : []; }), errors };
  }

  list(projectId?: string): TaskSummary[] {
    const tasks = this.store.tasks().filter((task) => projectId === undefined || task.projectId === projectId);
    const summaries = new Map<string, RunSummary | undefined>();
    return tasks.sort((first, second) => {
      if (!first.runId && !second.runId) return first.createdAt.localeCompare(second.createdAt);
      if (!first.runId) return -1;
      if (!second.runId) return 1;
      return (second.startedAt ?? second.createdAt).localeCompare(first.startedAt ?? first.createdAt);
    }).map((task) => this.summary(task, summaries));
  }

  summary(task: TaskRecord, summaries = new Map<string, RunSummary | undefined>()): TaskSummary {
    if (!task.runId) return { ...task, status: "todo" };
    if (!summaries.has(task.runId)) summaries.set(task.runId, this.store.runSummary(task.runId));
    const run = summaries.get(task.runId);
    return run ? { ...task, status: run.status, run } : { ...task, status: "canceled" };
  }
}
