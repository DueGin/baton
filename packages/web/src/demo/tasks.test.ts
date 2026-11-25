import { describe, expect, it, vi } from "vitest";
import { DemoClient } from "./client.js";

const base = Date.parse("2026-11-20T10:00:00Z");
const projectId = "project-atlas";
describe("demo collected tasks", () => {
  it("seeds todo and started tasks; filters, validates and clears optional fields", async () => {
    const client = new DemoClient(() => base);
    const seeds = await client.tasks(); expect(seeds).toHaveLength(3); expect(seeds.at(-1)?.runId).toBeTruthy();
    expect((await client.tasks(projectId)).every(task => task.projectId === projectId)).toBe(true);
    for (const title of [" ", "a".repeat(201)]) await expect(client.createTask({ projectId, title })).rejects.toMatchObject({ status: 400 });
    await expect(client.createTask({ projectId: "project-archive", title: "归档" })).rejects.toThrow();
    await expect(client.createTask({ projectId: "missing", title: "未知项目" })).rejects.toMatchObject({ status: 404 });
    const task = await client.createTask({ projectId, title: "  改名  ", model: "model", agent: "codex" });
    expect(task).toMatchObject({ title: "改名", prompt: "", status: "todo" });
    await expect(client.patchTask(task.id, { title: "新标题", model: null, prompt: "新提示" })).resolves.toMatchObject({ title: "新标题", prompt: "新提示", agent: "codex" });
    expect((await client.tasks()).find(entry => entry.id === task.id)).not.toHaveProperty("model");
    await expect(client.patchTask(task.id, { prompt: null })).resolves.toMatchObject({ prompt: "" });
    await client.deleteTask(task.id); await expect(client.patchTask(task.id, {})).rejects.toMatchObject({ status: 404 });
  });

  it("two concurrent starts create exactly one real demo run with the configured prompt, overrides and defaults", async () => {
    const client = new DemoClient(() => base);
    const task = await client.createTask({ projectId, title: "回归用例", agent: "claude" });
    const count = (await client.runs()).length;
    const [first, second] = await Promise.allSettled([client.startTask(task.id, { agent: "codex", model: "test-model", policy: { mode: "solo", maxDepth: 2 } }), client.startTask(task.id)]);
    expect(second).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect(first.status).toBe("fulfilled"); if (first.status !== "fulfilled") throw first.reason;
    expect(await client.runs()).toHaveLength(count + 1);
    const run = await client.run(first.value.runId!);
    expect(run.run).toMatchObject({ projectId, title: "回归用例", policy: { mode: "solo", maxDepth: 2 } });
    expect(run.nodes[0]).toMatchObject({ agentId: "codex", model: "test-model" });
    expect((await client.items(run.run.rootNodeId)).items[0]?.item).toEqual({ type: "user_message", text: "回归用例" });
    await expect(client.patchTask(task.id, { prompt: "不可改" })).rejects.toMatchObject({ status: 409 });
    await client.patchTask(task.id, { title: "只改任务" }); await client.deleteTask(task.id);
    expect((await client.run(run.run.id)).run.title).toBe("回归用例");
  });

  it("starts batches in order, skipping started/unknown ids and retaining failed todos for retry", async () => {
    const client = new DemoClient(() => base);
    const first = await client.createTask({ projectId, title: "先失败", teamPresetId: "missing" });
    const second = await client.createTask({ projectId, title: "依然启动", prompt: "检查搜索框" });
    const linked = (await client.tasks()).find(task => task.runId)!;
    const result = await client.startTasks({ ids: [linked.id, first.id, "missing-id", second.id], start: { policy: { mode: "solo" } } });
    expect(result.tasks.map(task => task.id)).toEqual([linked.id, first.id, second.id]);
    expect(result.tasks[0]?.runId).toBe(linked.runId);
    expect(result.tasks[1]).toMatchObject({ status: "todo", error: expect.stringContaining("预设") });
    expect(result.errors).toEqual([{ id: first.id, message: result.tasks[1]!.error }, { id: "missing-id", message: "任务不存在" }]);
    const run = await client.run(result.tasks[2]!.runId!);
    expect((await client.items(run.run.rootNodeId)).items[0]?.item).toMatchObject({ text: "检查搜索框" });
    await client.patchTask(first.id, { teamPresetId: null });
    expect(await client.startTask(first.id)).not.toHaveProperty("error");
  });

  it("notifies on task writes and linked run activity, but not after unsubscribe", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = base; const client = new DemoClient(() => now); const changed = vi.fn(); const abort = new AbortController();
    const stream = client.taskEvents(changed, abort.signal);
    try {
      const created = await client.createTask({ projectId, title: "实时报表" }); expect(changed).toHaveBeenCalledTimes(1);
      await client.patchTask(created.id, { title: "更新报表" }); expect(changed).toHaveBeenCalledTimes(2);
      const task = await client.startTask(created.id, { policy: { mode: "solo" } });
      expect(task).toMatchObject({ status: "active", run: { activeNodeCount: 1 } }); changed.mockClear();
      now += 5000; await vi.advanceTimersByTimeAsync(500);
      expect(changed).toHaveBeenCalled(); expect((await client.tasks()).find(entry => entry.id === task.id)).toMatchObject({ status: "idle", run: { activeNodeCount: 0 } });
      changed.mockClear(); await client.pauseRun(task.runId!); expect(changed).toHaveBeenCalled();
      expect((await client.tasks()).find(entry => entry.id === task.id)?.status).toBe("paused");
      changed.mockClear(); await client.deleteTask(task.id); expect(changed).toHaveBeenCalledTimes(1);
    } finally { abort.abort(); await stream; vi.useRealTimers(); }
    changed.mockClear(); await client.createTask({ projectId, title: "不再推送" }); expect(changed).not.toHaveBeenCalled();
  });
});
