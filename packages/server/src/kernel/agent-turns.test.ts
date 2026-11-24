import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startServer, type BatonServer, type StartServerOptions } from "../api/server.js";
import { FakeDriverRegistry, type FakeContext, type FakeScript } from "../driver/fake.js";

let server: BatonServer, home: string;
afterEach(async () => { vi.useRealTimers(); await server?.close(); if (home) await rm(home, { recursive: true, force: true }); });
const idle: FakeScript = () => {};
function gate() {
  const controller = new AbortController();
  return { release: () => controller.abort(), wait: async (ctx: FakeContext) => {
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  } };
}
const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { interval: 5, timeout: 2500 });
async function setup(scripts: Record<string, FakeScript> = {}, options: Partial<StartServerOptions> = {}) {
  home = await mkdtemp(join(tmpdir(), "baton-agent-turns-"));
  const registry = new FakeDriverRegistry({ root: idle, worker: idle, ...scripts });
  const notify = vi.fn();
  server = await startServer({ home, registry, port: 0, fileCheckpoints: false, notifier: notify, notificationCoalesceMs: 1, deliveryDebounceMs: 10, ...options });
  const project = await server.kernel.projects.create({ path: home });
  const { run } = await server.kernel.createRun({ projectId: project.id, agent: "root", prompt: "start", title: "Agent turns", policy: { teamApproval: false } });
  const root = run.rootNodeId;
  await until(() => server.store.node(root).status === "idle");
  return { root, registry, session: registry.get("root")!.sessions[0]!, snapshot: () => server.store.snapshot(run.id), notify };
}

it("adopts a root wake-up, records its activity and sends the usual human completion notification", async () => {
  const { root, session, snapshot, notify } = await setup();
  await until(() => notify.mock.calls.length === 1); notify.mockClear();
  const hold = gate();
  const { turnId } = await session.agentTurn(async ctx => { ctx.reasoning("inspect"); ctx.text("background task finished"); await hold.wait(ctx); });
  await until(() => snapshot().turns.at(-1)?.trigger === "agent");
  const adopted = snapshot().turns.at(-1)!;
  expect(adopted).toMatchObject({ status: "running", driverTurnId: turnId });
  expect(server.store.node(root).status).toBe("running"); expect(snapshot().run.status).toBe("active");
  hold.release(); await until(() => notify.mock.calls.length === 1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "run_completed" }));
  expect(server.store.node(root).status).toBe("idle"); expect(snapshot().run.status).toBe("idle");
  expect(snapshot().turns.at(-1)).toMatchObject({ id: adopted.id, status: "completed", usage: { inputTokens: 200 } });
  expect(server.store.items(root).filter(row => row.turnId === adopted.id).map(row => row.item.type)).toEqual(["reasoning", "assistant_message"]);
  expect(session.prompts).toEqual(["start"]);
});

it("records wake-ups while paused but holds human prompts until resume", async () => {
  const { root, session, snapshot } = await setup();
  const runId = snapshot().run.id; await server.kernel.pauseRun(runId);
  const hold = gate(); await session.agentTurn(hold.wait);
  await until(() => snapshot().turns.at(-1)?.trigger === "agent");
  expect(snapshot().run.status).toBe("paused");
  expect(await server.kernel.message(root, "later")).toMatchObject({ delivery: "queued" });
  hold.release(); await until(() => snapshot().turns.at(-1)?.status === "completed");
  expect(session.prompts).toEqual(["start"]); expect(snapshot().run.status).toBe("paused");
  await server.kernel.resumeRun(runId); expect(session.prompts).toEqual(["start", "later"]);
});

it("records a side turn without reopening or redelivering a finished delegation", async () => {
  const { root, registry, snapshot } = await setup({ worker: ctx => ctx.text("original result") });
  const { delegationId, nodeId } = await server.kernel.delegate(root, { agent: "worker", title: "worker", task: "job" });
  await until(() => !!server.store.delegation(delegationId).deliveredAt);
  const before = server.store.delegation(delegationId), hold = gate();
  await registry.get("worker")!.sessions[0]!.agentTurn(async ctx => { ctx.text("late output"); await hold.wait(ctx); });
  await until(() => server.store.node(nodeId!).status === "running");
  expect(server.store.delegation(delegationId)).toEqual(before);
  await expect(server.kernel.tool(nodeId!, "report_result", { status: "success", summary: "replacement" })).rejects.toThrow(/already reported/);
  hold.release(); await until(() => server.store.node(nodeId!).status === "completed");
  const after = server.store.delegation(delegationId);
  expect({ ...after, subtreeUsage: before.subtreeUsage }).toEqual(before);
  expect(snapshot().turns.find(turn => turn.trigger === "agent")).toMatchObject({ nodeId, delegationId, status: "completed" });
});

it("accepts an in-progress delegate's background report even when every global slot is taken", async () => {
  const hold = gate();
  const { root, registry, session } = await setup({ worker: async ctx => { await ctx.call("delegate", { agent: "leaf", title: "leaf", task: "wait" }); }, leaf: hold.wait }, { maxActiveNodes: 2 });
  const child = await server.kernel.delegate(root, { agent: "worker", title: "worker", task: "wait for leaf" });
  await until(() => server.store.node(child.nodeId!).status === "idle");
  await session.agentTurn(hold.wait); await until(() => server.store.node(root).status === "running");
  await registry.get("worker")!.sessions[0]!.agentTurn(async ctx => { await ctx.call("report_result", { status: "success", summary: "background result" }); });
  await until(() => !!server.store.delegation(child.delegationId).deliveredVia);
  expect(server.store.delegation(child.delegationId)).toMatchObject({ status: "completed", result: { summary: "background result", reported: true } });
  expect(session.steered.join("\n")).toContain("background result");
});

it.each(["event first", "rejection first"])("queues a colliding prompt exactly once (%s)", async order => {
  const { root, session, snapshot } = await setup();
  const entered = Promise.withResolvers<void>(), reject = Promise.withResolvers<void>(), hold = gate();
  vi.spyOn(session, "startTurn").mockImplementationOnce(async () => { entered.resolve(); await reject.promise; throw new Error("A turn is already active"); });
  const submission = server.kernel.message(root, "please continue", "request-1");
  await entered.promise;
  const next = await server.kernel.message(root, "and check the output", "request-2");
  const wake = () => session.agentTurn(async ctx => { ctx.text("wake output"); await hold.wait(ctx); });
  if (order === "event first") { await wake(); await new Promise<void>(resolve => setImmediate(resolve)); }
  reject.resolve();
  const result = await submission; expect(result.delivery).toBe("queued");
  expect(server.store.items(root).find(row => row.seq === result.itemSeq)).toMatchObject({ item: { delivery: "queued", clientId: "request-1", queuePosition: 1 } });
  expect(server.store.items(root).find(row => row.seq === next.itemSeq)).toMatchObject({ item: { delivery: "queued", queuePosition: 2 } });
  expect(server.kernel.rollbacks.list(root).checkpoints).toHaveLength(1);
  if (order === "rejection first") await wake();
  await until(() => snapshot().turns.some(turn => turn.trigger === "agent" && turn.status === "running"));
  hold.release();
  await until(() => session.prompts.length === 2 && server.store.node(root).status === "idle");
  const turns = snapshot().turns, wakeTurn = turns.find(turn => turn.trigger === "agent")!, last = turns.at(-1)!;
  expect(last).toMatchObject({ trigger: "user", status: "completed" });
  expect(session.prompts).toEqual(["start", "please continue\n\nand check the output"]); expect(turns.some(turn => turn.status === "failed")).toBe(false);
  expect(server.store.items(root).filter(row => row.item.type === "user_message" && row.item.text === "please continue")).toMatchObject([{ seq: result.itemSeq, turnId: last.id, item: { delivery: "turn" } }]);
  expect(server.store.items(root).find(row => row.item.type === "assistant_message" && row.item.text === "wake output")?.turnId).toBe(wakeTurn.id);
  expect(server.kernel.rollbacks.list(root).checkpoints).toHaveLength(2);
});

it("extends the idle timeout until the session's background work ends", async () => {
  const { root, session } = await setup({}, { idleTimeoutMs: 60_000 });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  session.backgroundWork = true; await server.kernel.message(root, "launch background task");
  await new Promise<void>(resolve => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(120_000); expect(session.closed).toBe(false);
  session.backgroundWork = false; await vi.advanceTimersByTimeAsync(60_000);
  expect(session.closed).toBe(true);
});

it("also preserves a resumable delegate's session while it waits for its children and background work", async () => {
  const hold = gate();
  const { root, registry } = await setup({ worker: async ctx => { await ctx.call("delegate", { agent: "leaf", title: "leaf", task: "wait" }); }, leaf: hold.wait }, { idleTimeoutMs: 60_000 });
  const child = await server.kernel.delegate(root, { agent: "worker", title: "worker", task: "wait for leaf" });
  await until(() => server.store.node(child.nodeId!).status === "idle");
  const session = registry.get("worker")!.sessions[0]!;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  session.backgroundWork = true; await session.agentTurn(ctx => ctx.text("still waiting"));
  await new Promise<void>(resolve => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(120_000); expect(session.closed).toBe(false);
  expect(server.store.node(child.nodeId!).status).toBe("idle");
  session.backgroundWork = false; await vi.advanceTimersByTimeAsync(60_000); expect(session.closed).toBe(true);
});
