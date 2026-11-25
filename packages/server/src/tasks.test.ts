import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, emptyUsage, type RunSnapshot, type RunSummary, type StartTasksResponse, type TaskSummary } from "@baton/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, type BatonServer } from "./api/server.js";
import { FakeDriverRegistry } from "./driver/fake.js";

const servers: BatonServer[] = [], homes: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

it("projects the same lastActivityAt as replay and ignores rename and archive events", async () => {
  const { server, projectId } = await setup();
  const { store } = server, runId = "activity-run", path = `/api/runs/${runId}`;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const firstTs = "2026-01-01T00:00:00.000Z", activityTs = "2026-01-01T00:01:00.000Z";
    const renameTs = "2026-01-01T00:02:00.000Z", archiveTs = "2026-01-01T00:03:00.000Z";
    vi.setSystemTime(new Date(firstTs));
    store.append(runId, { type: "run.created", run: { id: runId, projectId, rootNodeId: "activity-root", title: "Original", cwd: server.home, status: "active", policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false }, createdAt: firstTs, updatedAt: firstTs, usage: emptyUsage() } });
    vi.setSystemTime(new Date(activityTs));
    store.append(runId, { type: "run.updated", patch: { status: "idle", updatedAt: activityTs } });
    vi.setSystemTime(new Date(renameTs));
    expect(await api<RunSnapshot>(server, path, "PATCH", { title: "Renamed" })).toMatchObject({ lastActivityAt: activityTs, lastEventAt: renameTs });
    vi.setSystemTime(new Date(archiveTs));
    expect(await api<RunSnapshot>(server, path, "PATCH", { archived: true })).toMatchObject({ lastActivityAt: activityTs, lastEventAt: archiveTs });
    const snapshot = store.snapshot(runId);
    const replay = store.events(runId).reduce(applyEvent, { ...snapshot, lastSeq: 0, lastActivityAt: undefined, lastEventAt: undefined });
    expect(snapshot.lastActivityAt).toBe(replay.lastActivityAt);
    expect(await api<RunSummary[]>(server, "/api/runs")).toMatchObject([{ id: runId, lastActivityAt: activityTs, lastEventAt: archiveTs }]);
  } finally { vi.useRealTimers(); }
});

async function setup(existingHome?: string) {
  const home = existingHome ?? await mkdtemp(join(tmpdir(), "baton-tasks-"));
  if (!existingHome) homes.push(home);
  const registry = new FakeDriverRegistry({ root: (context) => context.sleep(10000) });
  const server = await startServer({ home, port: 0, fake: true, registry, notifications: "off", background: { platform: "win32" }, fileCheckpoints: false });
  servers.push(server);
  return { server, registry, projectId: server.store.projects()[0]!.id };
}

function request(server: BatonServer, path: string, method = "GET", input?: unknown): Promise<Response> {
  return fetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`, ...(input === undefined ? {} : { "content-type": "application/json" }) }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(3000) });
}

async function api<Result>(server: BatonServer, path: string, method = "GET", input?: unknown, status = 200): Promise<Result> {
  const response = await request(server, path, method, input), result: unknown = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  return result as Result;
}

function create(server: BatonServer, projectId: string, title: string, fields: object = {}): Promise<TaskSummary> {
  return api(server, "/api/tasks", "POST", { title, projectId, agent: "root", ...fields }, 201);
}

describe("tasks API", () => {
  it("collects, edits, filters and deletes todo tasks", async () => {
    const { server, projectId } = await setup();
    const task = await create(server, projectId, "  Collect feedback  ", { prompt: "read notes", model: "model", teamPresetId: "preset" });
    expect(task).toMatchObject({ title: "Collect feedback", projectId, status: "todo" });
    expect(task).not.toHaveProperty("run");
    expect(server.store.task(task.id)).not.toHaveProperty("status");

    const otherPath = join(server.home, "other"); await mkdir(otherPath);
    const other = await server.kernel.projects.create({ path: otherPath });
    const path = `/api/tasks/${task.id}`;
    const edited = await api<TaskSummary>(server, path, "PATCH", { title: "  Review feedback  ", projectId: other.id, prompt: null, agent: null, model: null, teamPresetId: null });
    expect(edited).toMatchObject({ title: "Review feedback", projectId: other.id, prompt: "", status: "todo" });
    for (const key of ["agent", "model", "teamPresetId"]) expect(edited).not.toHaveProperty(key);
    expect(await api(server, `/api/tasks?projectId=${projectId}`)).toEqual([]);
    expect(await api(server, `/api/tasks?projectId=${other.id}`)).toEqual([edited]);

    expect(await api(server, path, "DELETE")).toEqual({ ok: true });
    expect(await api(server, "/api/tasks")).toEqual([]);
    await api(server, path, "PATCH", { title: "Missing" }, 404);
    await api(server, path, "DELETE", undefined, 404);
    await api(server, `${path}/start`, "POST", undefined, 404);
  });

  it("rejects invalid titles and missing or archived projects", async () => {
    const { server, projectId } = await setup();
    for (const title of [" ", "a".repeat(201), 42]) await api(server, "/api/tasks", "POST", { title, projectId }, 400);
    await api(server, "/api/tasks", "POST", { title: "No project" }, 400);
    await api(server, "/api/tasks", "POST", { title: "Unknown project", projectId: "missing" }, 404);
    const task = await create(server, projectId, "a".repeat(200));
    const path = `/api/tasks/${task.id}`;
    await api(server, path, "PATCH", { title: "" }, 400);
    await api(server, path, "PATCH", { projectId: "missing" }, 404);
    server.kernel.projects.patch(projectId, { archived: true });
    await api(server, "/api/tasks", "POST", { title: "Archived project", projectId }, 400);
    await api(server, path, "PATCH", { projectId }, 400);
    await api(server, `${path}/start`, "POST", undefined, 400);
    expect(await api(server, "/api/tasks")).toMatchObject([{ id: task.id, status: "todo", error: "Project is archived" }]);
  });

  it("persists collected tasks across daemon restarts", async () => {
    const { server, projectId } = await setup();
    const task = await create(server, projectId, "Remember this");
    await server.close();
    const restarted = await setup(server.home);
    expect(await api(restarted.server, "/api/tasks")).toEqual([task]);
  });

  it("starts only one run for concurrent calls and only allows renaming afterwards", async () => {
    const { server, registry, projectId } = await setup();
    const task = await create(server, projectId, "Run title", { prompt: " \n ", agent: "unavailable", model: "old" });
    const path = `/api/tasks/${task.id}`;
    const detect = registry.detect.bind(registry), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    registry.detect = async () => { entered.resolve(); await release.promise; return detect(); };
    const first = api<TaskSummary>(server, `${path}/start`, "POST", { agent: "root", model: "override", modeId: "plan", thinking: "high", policy: { mode: "solo" }, title: "Ignored", prompt: "Ignored", projectId: "missing" });
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error("The start did not reach agent discovery"); })]);
      await api(server, `${path}/start`, "POST", { agent: "root" }, 409);
      await api(server, path, "PATCH", { title: "Too soon" }, 409);
      await api(server, path, "DELETE", undefined, 409);
    } finally { release.resolve(); }
    const started = await first;
    expect(started).toMatchObject({ status: "active", run: { id: started.runId, title: task.title, projectId, rootAgentId: "root" } });
    expect(started.startedAt).toBeTruthy();
    expect(server.store.list()).toHaveLength(1);
    const runId = started.runId!;
    expect(server.kernel.firstPrompt(runId)).toBe(task.title);
    expect(server.store.snapshot(runId)).toMatchObject({ run: { policy: { mode: "solo" } }, nodes: [{ model: "override", modeId: "plan", thinking: "high" }] });
    await api(server, `${path}/start`, "POST", undefined, 409);
    await api(server, path, "PATCH", { title: "Updated", model: null }, 409);
    expect(await api(server, path, "PATCH", { title: " Updated " })).toMatchObject({ id: task.id, title: "Updated", run: { title: task.title } });
    await api(server, path, "DELETE");
    expect(server.store.list()).toMatchObject([{ id: runId, title: task.title, status: "active" }]);
  });

  it("persists start failures as todo and clears the error on retry", async () => {
    const { server, projectId } = await setup();
    const task = await create(server, projectId, "Retry me", { agent: "unavailable", prompt: "  first message \n" });
    const path = `/api/tasks/${task.id}`;
    expect(await api(server, `${path}/start`, "POST", undefined, 400)).toMatchObject({ error: { message: "Agent unavailable: unavailable" } });
    expect(await api(server, "/api/tasks")).toMatchObject([{ id: task.id, status: "todo", error: "Agent unavailable: unavailable" }]);
    expect(server.store.list()).toHaveLength(0);
    await api(server, path, "PATCH", { agent: "root" });
    const started = await api<TaskSummary>(server, `${path}/start`, "POST");
    expect(started).not.toHaveProperty("error");
    expect(server.store.task(task.id)).not.toHaveProperty("error");
    expect(server.kernel.firstPrompt(started.runId!)).toBe("first message");
  });

  it("starts batches in order, skips started tasks and reports per-task failures", async () => {
    const { server, projectId } = await setup();
    const first = await create(server, projectId, "First success");
    const bad = await create(server, projectId, "Failure", { teamPresetId: "missing" });
    const earlier = await create(server, projectId, "Already started");
    const last = await create(server, projectId, "Last success");
    const earlierRun = await api<TaskSummary>(server, `/api/tasks/${earlier.id}/start`, "POST");
    await api(server, "/api/tasks/start", "POST", { ids: [first.id, 42] }, 400);

    const response = await api<StartTasksResponse>(server, "/api/tasks/start", "POST", { ids: [first.id, bad.id, earlier.id, "unknown", last.id, first.id], start: { model: "batch-model" } });
    expect(response.tasks.map(({ id }) => id)).toEqual([first.id, bad.id, earlier.id, last.id, first.id]);
    expect(response.tasks.map(({ status }) => status)).toEqual(["active", "todo", "active", "active", "active"]);
    expect(response.tasks[2]?.runId).toBe(earlierRun.runId);
    expect(response.tasks[0]?.runId).toBe(response.tasks[4]?.runId);
    expect(response.errors).toEqual([{ id: bad.id, message: "Team preset not found: missing" }, { id: "unknown", message: "Task not found" }]);
    expect(server.store.list().map(({ title }) => title)).toEqual([last.title, first.title, earlier.title]);
    expect(server.store.snapshot(response.tasks[3]!.runId!).nodes[0]?.model).toBe("batch-model");
  });

  it("follows the linked run, including when it no longer exists", async () => {
    const { server, projectId } = await setup();
    const task = await create(server, projectId, "Follow the run");
    const started = await api<TaskSummary>(server, `/api/tasks/${task.id}/start`, "POST"), runId = started.runId!;
    expect(started.run).toMatchObject({ status: "active", activeNodeCount: 1, pendingTotal: 0, usage: { costUsd: 0 } });
    await api(server, `/api/runs/${runId}/cancel`, "POST");
    expect(await api(server, "/api/tasks")).toMatchObject([{ id: task.id, status: "canceled", run: { status: "canceled", activeNodeCount: 0 } }]);
    server.store.saveTask({ ...server.store.task(task.id), id: "orphan", runId: "missing-run" });
    const missing = (await api<TaskSummary[]>(server, "/api/tasks")).find(({ id }) => id === "orphan");
    expect(missing).toMatchObject({ id: "orphan", runId: "missing-run", status: "canceled" });
    expect(missing).not.toHaveProperty("run");
  });

  it("orders todo by creation ascending and started by start time descending", async () => {
    const { server, projectId } = await setup();
    const base = { projectId, prompt: "", updatedAt: "2026-01-01T00:00:00.000Z" };
    const task = (id: string, createdAt: string, startedAt?: string) => ({ ...base, id, title: id, createdAt, ...(startedAt ? { startedAt, runId: `run-${id}` } : {}) });
    server.store.saveTask(task("started-first", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"));
    server.store.saveTask(task("todo-newer", "2026-01-03T00:00:00.000Z"));
    server.store.saveTask(task("todo-older", "2026-01-02T00:00:00.000Z"));
    server.store.saveTask(task("started-last", "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z"));
    expect((await api<TaskSummary[]>(server, "/api/tasks")).map(({ id }) => id)).toEqual(["todo-older", "todo-newer", "started-last", "started-first"]);
  });

  it("emits changed for mutations and linked run events without requiring a summary change", async () => {
    const { server, projectId } = await setup();
    const controller = new AbortController();
    const response = await fetch(`${server.url}/api/tasks/events?token=${server.token}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffered = "";
    async function changed() {
      while (!buffered.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Task event stream ended early");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffered.indexOf("\n\n");
      expect(buffered.slice(0, end)).toBe("event: changed\ndata: {}");
      buffered = buffered.slice(end + 2);
    }
    try {
      const task = await create(server, projectId, "Watch me"); await changed();
      const path = `/api/tasks/${task.id}`;
      await api(server, path, "PATCH", { title: "Renamed" }); await changed();
      const started = await api<TaskSummary>(server, `${path}/start`, "POST"); await changed();
      for (let index = 0; index < 5; index++) server.store.append(started.runId!, { type: "log", level: "info", message: "Linked update" });
      await changed();
      await api(server, path, "DELETE"); await changed();
    } finally { controller.abort(); }
  });
});
