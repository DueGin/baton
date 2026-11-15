import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SendMessageResponse } from "@baton/protocol";
import { startServer, type BatonServer } from "./api/server.js";
import { FakeDriver, FakeDriverRegistry, type FakeContext, type FakeDriverOptions } from "./driver/fake.js";
import type { DriverEvent } from "./driver/types.js";

const servers: BatonServer[] = [], homes: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
function gate(): { release(): void; wait(c: FakeContext): Promise<void> } {
  let release = (): void => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait: async (c) => {
    c.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(c.signal.reason);
      c.signal.addEventListener("abort", abort, { once: true });
      void ready.then(() => { c.signal.removeEventListener("abort", abort); resolve(); });
    });
  } };
}
async function setup(options: FakeDriverOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "baton-messages-")); homes.push(home);
  const driver = new FakeDriver("root", { script: (c) => c.text("Done"), ...options });
  const server = await startServer({ home, port: 0, registry: new FakeDriverRegistry([driver]), notifier: () => {}, deliveryDebounceMs: 10 });
  servers.push(server);
  const run = await server.kernel.createRun({ projectId: (await server.kernel.projects.create({ path: tmpdir() })).id, agent: "root", cwd: tmpdir(), prompt: "start", policy: { teamApproval: false } });
  const root = run.run.rootNodeId;
  return { server, driver, run, root, rows: () => server.store.items(root) };
}
async function until(test: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!test()) { if (Date.now() > end) throw new Error("Timed out waiting for condition"); await delay(5); }
}

describe("human message delivery", () => {
  it("records an idle message as a new turn with its client id and item seq", async () => {
    const { server, driver, root, rows, run } = await setup();
    await until(() => server.store.node(root).status === "idle");
    const result = await server.kernel.message(root, "continue", "idle-client");
    expect(result.delivery).toBe("turn");
    const row = rows().find((r) => r.seq === result.itemSeq)!;
    expect(row.item).toEqual({ type: "user_message", text: "continue", clientId: "idle-client", delivery: "turn" });
    expect(row.turnId).toBe(server.store.snapshot(run.run.id).turns[1]!.id);
    expect(driver.sessions[0]!.prompts).toEqual(["start", "continue"]);
    expect(rows().filter((r) => r.item.type === "user_message" && r.item.text === "continue")).toHaveLength(1);
  });

  it("records a message steered into a running turn", async () => {
    const hold = gate();
    const { server, driver, root, rows, run } = await setup({ script: (c) => hold.wait(c) });
    const result = await server.kernel.message(root, "change approach", "steer-client");
    expect(result.delivery).toBe("steered");
    expect(rows().find((r) => r.seq === result.itemSeq)).toMatchObject({
      turnId: run.turns[0]!.id,
      item: { type: "user_message", text: "change approach", clientId: "steer-client", delivery: "steered" },
    });
    expect(driver.sessions[0]!.steered).toEqual(["change approach"]);
    expect(driver.sessions[0]!.prompts).toEqual(["start"]);
  });

  it("persists unsupported steer immediately and updates the same row when drained", async () => {
    const hold = gate();
    const { server, driver, root, rows, run } = await setup({ steer: false, script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const result = await server.kernel.message(root, "queued request", "queued-client");
    expect(result.delivery).toBe("queued");
    const queued = rows().find((r) => r.seq === result.itemSeq)!;
    expect(queued.item).toEqual({ type: "user_message", text: "queued request", clientId: "queued-client", delivery: "queued" });
    expect(queued.turnId).toBeUndefined();
    expect(driver.sessions[0]!.prompts).toEqual(["start"]);
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    expect(rows().find((r) => r.seq === result.itemSeq)).toMatchObject({
      turnId: server.store.snapshot(run.run.id).turns[1]!.id,
      item: { delivery: "turn", clientId: "queued-client" },
    });
    expect(rows().filter((r) => r.item.type === "user_message")).toHaveLength(2);
    const updates = server.store.events(run.run.id).filter((e) => e.type === "item" && e.itemSeq === result.itemSeq);
    expect(updates.map((e) => e.type === "item" && e.item.type === "user_message" ? e.item.delivery : null)).toEqual(["queued", "turn"]);
  });

  it("drains two queued rows into one turn without a joined duplicate", async () => {
    const hold = gate();
    const { server, driver, root, rows, run } = await setup({ steer: false, script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const first = await server.kernel.message(root, "first request", "first");
    const second = await server.kernel.message(root, "second request", "second");
    expect(rows().filter((r) => r.item.type === "user_message" && r.item.delivery === "queued")).toHaveLength(2);
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    expect(driver.sessions[0]!.prompts).toEqual(["start", "first request\n\nsecond request"]);
    const turn = server.store.snapshot(run.run.id).turns[1]!;
    for (const result of [first, second]) expect(rows().find((r) => r.seq === result.itemSeq)).toMatchObject({ turnId: turn.id, item: { delivery: "turn" } });
    expect(rows().filter((r) => r.item.type === "user_message")).toHaveLength(3);
    expect(rows().some((r) => r.item.type === "user_message" && r.item.text === "first request\n\nsecond request")).toBe(false);
  });

  it("keeps kernel followups distinct when sharing a turn with a human message", async () => {
    const hold = gate();
    const { server, root, driver, rows, run } = await setup({ steer: false });
    await until(() => server.store.node(root).status === "idle");
    driver.options.script = async (c) => { if (c.turn === 1) await hold.wait(c); };
    // A delegated child uses the same driver but gets its own session.
    const child = await server.kernel.delegate(root, { agent: "root", title: "child", task: "work" });
    const childId = child.nodeId!;
    await until(() => server.store.node(childId).status === "running");
    const human = await server.kernel.message(childId, "human instruction", "mixed-client");
    await server.kernel.tool(root, "send", { delegationId: child.delegationId, message: "parent instruction" });
    hold.release();
    await until(() => server.store.node(childId).turns === 2 && server.store.node(childId).status === "completed");
    const childRows = server.store.items(childId).filter((r) => r.item.type === "user_message");
    expect(childRows).toHaveLength(3);
    expect(childRows.find((r) => r.seq === human.itemSeq)?.item).toMatchObject({ text: "human instruction", delivery: "turn", clientId: "mixed-client" });
    expect(childRows.at(-1)?.item).toEqual({ type: "user_message", text: "parent instruction" });
    expect(driver.sessions[1]!.prompts[1]).toBe("human instruction\n\nparent instruction");
    // Root result/notice prompts remain kernel messages without human delivery metadata.
    await until(() => !!server.store.delegation(child.delegationId).deliveredAt);
    expect(rows().filter((r) => r.item.type === "user_message").every((r) => r.item.type === "user_message" && r.item.delivery === undefined)).toBe(true);
    expect(server.store.snapshot(run.run.id).delegations).toHaveLength(1);
  });

  it("leaves canceled queued messages visible and appends a warning exactly once", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ steer: false, script: (c) => hold.wait(c) });
    const result = await server.kernel.message(root, "never delivered", "cancel-client");
    await server.kernel.cancelNode(root);
    expect(rows().find((r) => r.seq === result.itemSeq)?.item).toMatchObject({ delivery: "queued", clientId: "cancel-client" });
    expect(rows().at(-1)?.item).toEqual({ type: "notice", level: "warning", message: "未送达：节点已结束" });
    expect(rows().filter((r) => r.item.type === "notice")).toHaveLength(1);
    expect(driver.sessions[0]!.prompts).toEqual(["start"]);
    expect(driver.sessions[0]!.closed).toBe(true);
  });

  it("abandons queued messages before processing a driver session close", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ steer: false, script: (c) => hold.wait(c) });
    let eventListener: ((event: DriverEvent) => void) | undefined;
    // Capture the child's actual subscriber without exposing fake session internals.
    const open = driver.open.bind(driver);
    driver.open = async (spec) => {
      const next = await open(spec), subscribe = next.subscribe.bind(next);
      next.subscribe = (listener) => { eventListener = listener; return subscribe(listener); };
      return next;
    };
    const child = await server.kernel.delegate(root, { agent: "root", title: "child", task: "work" });
    await until(() => !!eventListener && server.store.node(child.nodeId!).status === "running");
    const result = await server.kernel.message(child.nodeId!, "queued before close", "close-client");
    eventListener!({ type: "closed", error: "process exited" });
    await until(() => server.store.node(child.nodeId!).status === "failed");
    const childRows = server.store.items(child.nodeId!);
    expect(childRows.find((r) => r.seq === result.itemSeq)?.item).toMatchObject({ delivery: "queued" });
    expect(childRows.at(-1)?.item).toEqual({ type: "notice", level: "warning", message: "未送达：节点已结束" });
    expect(driver.sessions[1]!.prompts).toHaveLength(1);
    expect(rows().some((r) => r.item.type === "user_message" && r.item.text === "queued before close")).toBe(false);
    hold.release();
  });

  it("persists a message before steer finishes and does not revive it after cancellation", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ script: (c) => hold.wait(c) });
    let resolveSteer: (outcome: "unsupported") => void = () => {};
    driver.sessions[0]!.steer = () => new Promise((resolve) => { resolveSteer = resolve; });
    const sending = server.kernel.message(root, "cancel while steering", "racing-client");
    const row = rows().find((r) => r.item.type === "user_message" && r.item.clientId === "racing-client")!;
    expect(row.item).toMatchObject({ delivery: "queued" });
    await server.kernel.cancelNode(root);
    resolveSteer("unsupported");
    expect(await sending).toEqual({ delivery: "queued", itemSeq: row.seq });
    expect(driver.sessions[0]!.prompts).toEqual(["start"]);
    expect(rows().filter((r) => r.item.type === "notice")).toHaveLength(1);
  });

  it("starts a new turn if the current turn finishes before steer is refused", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    let resolveSteer: (outcome: "no_active_turn") => void = () => {};
    driver.sessions[0]!.steer = () => new Promise((resolve) => { resolveSteer = resolve; });
    const sending = server.kernel.message(root, "late refusal", "late-client");
    expect(rows().find((r) => r.item.type === "user_message" && r.item.clientId === "late-client")?.item).toMatchObject({ delivery: "queued" });
    hold.release();
    await until(() => server.store.node(root).status === "idle");
    resolveSteer("no_active_turn");
    expect(await sending).toMatchObject({ delivery: "turn" });
    expect(driver.sessions[0]!.prompts).toEqual(["start", "late refusal"]);
    expect(rows().filter((r) => r.item.type === "user_message")).toHaveLength(2);
  });

  it("warns about queued messages when a child is replaced", async () => {
    const hold = gate();
    const { server, driver, root, run } = await setup({ steer: false });
    await until(() => server.store.node(root).status === "idle");
    driver.options.script = async (c) => { if (c.spec.title === "child") await hold.wait(c); };
    const child = await server.kernel.delegate(root, { agent: "root", title: "child", task: "work" });
    await until(() => server.store.node(child.nodeId!).status === "running");
    const queued = await server.kernel.message(child.nodeId!, "old task instruction", "replace-client");
    const successor = await server.kernel.teams.reassign(child.delegationId, { agentId: "root", reason: "new owner" });
    expect(server.store.node(child.nodeId!).status).toBe("replaced");
    const oldRows = server.store.items(child.nodeId!);
    expect(oldRows.find((r) => r.seq === queued.itemSeq)?.item).toMatchObject({ delivery: "queued", clientId: "replace-client" });
    expect(oldRows.at(-1)?.item).toEqual({ type: "notice", level: "warning", message: "未送达：节点已结束" });
    expect(oldRows.filter((r) => r.item.type === "notice")).toHaveLength(1);
    expect(server.store.delegation(successor.delegationId).replaces).toBe(child.delegationId);
    expect(server.store.snapshot(run.run.id).turns.filter((t) => t.nodeId === child.nodeId)).toHaveLength(1);
  });

  it("marks pending human messages undelivered during daemon shutdown", async () => {
    const hold = gate();
    const { server, root, rows } = await setup({ steer: false, script: (c) => hold.wait(c) });
    const queued = await server.kernel.message(root, "shutdown request", "shutdown-client");
    await server.kernel.shutdown();
    expect(rows().find((r) => r.seq === queued.itemSeq)?.item).toMatchObject({ delivery: "queued" });
    expect(rows().at(-1)?.item).toEqual({ type: "notice", level: "warning", message: "未送达：节点已结束" });
  });

  it("queues a human message after a driver rejects steer with an error", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    driver.sessions[0]!.steer = async () => { throw new Error("steer refused"); };
    const queued = await server.kernel.message(root, "refused steer", "refused-client");
    expect(queued.delivery).toBe("queued");
    expect(rows().find((r) => r.seq === queued.itemSeq)?.item).toMatchObject({ delivery: "queued" });
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    expect(rows().find((r) => r.seq === queued.itemSeq)?.item).toMatchObject({ delivery: "turn" });
  });

  it.each(["turn", "steered", "queued"] as const)("returns the 202 API response for %s delivery", async (delivery) => {
    const hold = gate();
    const { server, root, rows } = await setup({ steer: delivery !== "queued", script: async (c) => { if (delivery !== "turn") await hold.wait(c); } });
    if (delivery === "turn") await until(() => server.store.node(root).status === "idle");
    const response = await fetch(`${server.url}/api/nodes/${root}/messages`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "API request", clientId: "api-client" }) });
    expect(response.status).toBe(202);
    const body = await response.json() as SendMessageResponse;
    expect(body).toEqual({ accepted: true, delivery, itemSeq: expect.any(Number) });
    expect(rows().find((r) => r.seq === body.itemSeq)?.item).toEqual({ type: "user_message", text: "API request", clientId: "api-client", delivery });
  });
});
