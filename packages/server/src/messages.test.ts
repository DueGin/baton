import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ItemRecord, ReorderQueueResponse, SendMessageResponse } from "@baton/protocol";
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
  it("queues by default while busy without attempting steer", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ script: (c) => hold.wait(c) });
    const steer = vi.spyOn(driver.sessions[0]!, "steer");
    const result = await server.kernel.message(root, "wait for my turn");
    expect(result.delivery).toBe("queued");
    expect(steer).not.toHaveBeenCalled();
    expect(rows().find((r) => r.seq === result.itemSeq)?.item).toMatchObject({ delivery: "queued", text: "wait for my turn" });
  });

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
    const result = await server.kernel.message(root, "change approach", "steer-client", "steer");
    expect(result.delivery).toBe("steered");
    expect(rows().find((r) => r.seq === result.itemSeq)).toMatchObject({
      turnId: run.turns[0]!.id,
      item: { type: "user_message", text: "change approach", clientId: "steer-client", delivery: "steered", escalated: false, steeredAfterSeq: 1 },
    });
    expect(driver.sessions[0]!.steered).toEqual(["change approach"]);
    expect(driver.sessions[0]!.prompts).toEqual(["start"]);
  });

  it.each(["assistant_message", "reasoning"] as const)("anchors a queued steer between %s fragments", async (type) => {
    const streaming = gate(), remaining = gate();
    const firstFragment = Promise.withResolvers<void>();
    const { server, root, rows } = await setup({ script: async (context) => {
      await streaming.wait(context);
      context.item({ type, text: "First fragment." });
      firstFragment.resolve();
      await remaining.wait(context);
      context.item({ type, text: "Second fragment." });
    } });
    const queued = await server.kernel.message(root, "change direction");
    streaming.release();
    await firstFragment.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await server.kernel.deliverHumanMessage(root, queued.itemSeq, "steer")).toMatchObject({ delivery: "steered" });
    const anchor = rows().at(-1)!;
    expect(anchor.item).toEqual({ type, text: "First fragment." });
    expect(anchor.seq).toBeGreaterThan(queued.itemSeq);
    expect(rows().find((row) => row.seq === queued.itemSeq)).toMatchObject({ item: { steeredAfterSeq: anchor.seq } });

    remaining.release();
    await until(() => server.store.node(root).status === "idle");
    const fragments = rows().filter((row) => row.item.type === type);
    expect(fragments.map((row) => row.item)).toEqual([{ type, text: "First fragment." }, { type, text: "Second fragment." }]);
    expect(fragments[0]!.seq).toBe(anchor.seq);
    expect(fragments[1]!.seq).toBeGreaterThan(anchor.seq);
  });

  it("strips displayed prefixes from cumulative snapshots across two steers", async () => {
    const middle = gate(), end = gate();
    const { server, root, rows } = await setup({ script: async (context) => {
      const snapshot = (text: string) => context.item({ type: "assistant_message", text, messageId: "stream" });
      snapshot("Before.");
      await middle.wait(context);
      snapshot("Before.");
      snapshot("Before. After one");
      snapshot("Before. After one.");
      await end.wait(context);
      snapshot("Before. After one. After two.");
    } });
    const fragments = () => rows().filter((row) => row.item.type === "assistant_message");
    await until(() => fragments().length === 1);
    expect(await server.kernel.message(root, "first steer", undefined, "steer")).toMatchObject({ delivery: "steered" });
    middle.release();
    await until(() => fragments().length === 2);
    expect(await server.kernel.message(root, "second steer", undefined, "steer")).toMatchObject({ delivery: "steered" });
    end.release();
    await until(() => server.store.node(root).status === "idle");
    expect(fragments().map(({ item }) => item)).toEqual(["Before.", " After one.", " After two."].map((text) => ({ type: "assistant_message", text, messageId: "stream" })));
  });

  it("starts a new parent output item after steering a delegation result", async () => {
    const remaining = gate();
    const { server, root, rows } = await setup({ script: async (context) => {
      if (context.prompt.includes("<baton-assignment")) { context.text("Child report."); return; }
      context.item({ type: "assistant_message", text: "Parent before.", messageId: "parent" });
      await remaining.wait(context);
      context.item({ type: "assistant_message", text: "Parent before. Parent after.", messageId: "parent" });
    } });
    await until(() => rows().some((row) => row.item.type === "assistant_message"));
    const child = await server.kernel.delegate(root, { agent: "root", title: "child", task: "work" });
    const resultRow = () => rows().find((row) => row.item.type === "user_message" && row.item.text.startsWith("<baton-results>"));
    await until(() => !!resultRow());
    expect(server.store.delegation(child.delegationId).deliveredVia).toBe("steer");
    remaining.release();
    await until(() => server.store.node(root).status === "idle");
    const output = rows().filter((row) => row.item.type === "assistant_message");
    expect(output.map(({ item }) => item)).toEqual(["Parent before.", " Parent after."].map((text) => ({ type: "assistant_message", text, messageId: "parent" })));
    expect(output[0]!.seq).toBeLessThan(resultRow()!.seq);
    expect(output[1]!.seq).toBeGreaterThan(resultRow()!.seq);
  });

  it("persists unsupported steer immediately and updates the same row when drained", async () => {
    const hold = gate();
    const { server, driver, root, rows, run } = await setup({ steer: false, script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const result = await server.kernel.message(root, "queued request", "queued-client", "steer");
    expect(result).toMatchObject({ delivery: "queued", steerUnsupported: true });
    const queued = rows().find((r) => r.seq === result.itemSeq)!;
    expect(queued.item).toEqual({ type: "user_message", text: "queued request", clientId: "queued-client", delivery: "queued", queuePosition: 1 });
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
    const followup = `<baton-followup delegation="${child.delegationId}">\nparent instruction\n</baton-followup>`;
    expect(childRows.at(-1)?.item).toEqual({ type: "user_message", text: followup });
    expect(driver.sessions[1]!.prompts[1]).toBe(`human instruction\n\n${followup}`);
    // Root result/notice prompts remain kernel messages without human delivery metadata.
    await until(() => !!server.store.delegation(child.delegationId).deliveredAt);
    expect(rows().filter((r) => r.item.type === "user_message").every((r) => r.item.type === "user_message" && r.item.delivery === undefined)).toBe(true);
    expect(server.store.snapshot(run.run.id).delegations).toHaveLength(1);
  });

  it("tags a parent follow-up delivered by steer without tagging human messages", async () => {
    const hold = gate();
    const { server, driver, root } = await setup();
    await until(() => server.store.node(root).status === "idle");
    driver.options.script = (c) => hold.wait(c);
    const child = await server.kernel.delegate(root, { agent: "root", title: "child", task: "work" });
    await until(() => server.store.node(child.nodeId!).status === "running");
    await server.kernel.tool(root, "send", { delegationId: child.delegationId, message: "parent instruction" });
    await server.kernel.message(child.nodeId!, "human instruction", undefined, "steer");
    const followup = `<baton-followup delegation="${child.delegationId}">\nparent instruction\n</baton-followup>`;
    expect(driver.sessions[1]!.steered).toEqual([followup, "human instruction"]);
    expect(server.store.items(child.nodeId!).filter((r) => r.item.type === "user_message").map((r) => r.item)).toEqual([
      expect.objectContaining({ text: expect.stringContaining("<baton-assignment") }),
      { type: "user_message", text: followup },
      expect.objectContaining({ text: "human instruction", delivery: "steered" }),
    ]);
  });

  it("starts a new child output item after steering a parent follow-up", async () => {
    const finish = gate();
    const { server, root } = await setup({ script: async (context) => {
      if (!context.prompt.includes("<baton-assignment")) return;
      context.item({ type: "assistant_message", text: "Child before.", messageId: "child" });
      await finish.wait(context);
      context.item({ type: "assistant_message", text: "Child before. Child after.", messageId: "child" });
    } });
    await until(() => server.store.node(root).status === "idle");
    const child = await server.kernel.delegate(root, { agent: "root", title: "child", task: "work" });
    const childNodeId = child.nodeId!;
    const childRows = () => server.store.items(childNodeId);
    await until(() => childRows().some(({ item }) => item.type === "assistant_message"));
    await server.kernel.tool(root, "send", { delegationId: child.delegationId, message: "parent instruction" });
    const followup = childRows().find(({ item }) => item.type === "user_message" && item.text.startsWith("<baton-followup"))!;
    expect(followup.item).not.toHaveProperty("steeredAfterSeq");
    finish.release();
    await until(() => server.store.delegation(child.delegationId).status === "completed");
    const output = childRows().filter(({ item }) => item.type === "assistant_message");
    expect(output.map(({ item }) => item)).toEqual(["Child before.", " Child after."].map((text) => ({ type: "assistant_message", text, messageId: "child" })));
    expect(output[0]!.seq).toBeLessThan(followup.seq);
    expect(output[1]!.seq).toBeGreaterThan(followup.seq);
    expect(server.store.delegation(child.delegationId).result?.finalText).toBe("Child before. Child after.");
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
    const sending = server.kernel.message(root, "cancel while steering", "racing-client", "steer");
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
    const sending = server.kernel.message(root, "late refusal", "late-client", "steer");
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
    const queued = await server.kernel.message(root, "refused steer", "refused-client", "steer");
    expect(queued).toMatchObject({ delivery: "queued", steerUnsupported: true });
    expect(rows().find((r) => r.seq === queued.itemSeq)?.item).toMatchObject({ delivery: "queued" });
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    expect(rows().find((r) => r.seq === queued.itemSeq)?.item).toMatchObject({ delivery: "turn" });
  });

  it("interrupts only the active turn and drains other queued messages after the replacement turn", async () => {
    const first = gate(), replacement = gate();
    const { server, driver, root, rows, run } = await setup({ script: async (c) => {
      if (c.turn === 1) await first.wait(c);
      if (c.turn === 2) await replacement.wait(c);
    } });
    const waiting = await server.kernel.message(root, "deliver later", "later");
    const sent = await server.kernel.message(root, "redirect now", "interrupt-client", "interrupt");
    expect(sent.delivery).toBe("turn");
    expect(driver.sessions[0]!.prompts).toEqual(["start", "redirect now"]);
    expect(rows().find((r) => r.seq === sent.itemSeq)?.item).toMatchObject({ text: "redirect now", delivery: "turn", interrupted: true, clientId: "interrupt-client" });
    expect(rows().find((r) => r.seq === waiting.itemSeq)?.item).toMatchObject({ delivery: "queued" });
    expect(server.store.node(root).status).toBe("running");
    const turns = server.store.snapshot(run.run.id).turns;
    expect(turns[0]).toMatchObject({ status: "canceled", error: "interrupted by human message" });
    expect(turns[1]).toMatchObject({ status: "running", trigger: "user" });
    expect(rows().filter((r) => r.item.type === "notice")).toHaveLength(0);
    replacement.release();
    await until(() => server.store.node(root).turns === 3 && server.store.node(root).status === "idle");
    expect(driver.sessions[0]!.prompts).toEqual(["start", "redirect now", "deliver later"]);
    expect(rows().find((r) => r.seq === waiting.itemSeq)?.item).toMatchObject({ delivery: "turn" });
  });

  it("does not capture interrupted delegate results or cancel its children", async () => {
    const hold = gate();
    const { server, driver, root, run } = await setup();
    await until(() => server.store.node(root).status === "idle");
    driver.options.script = async (c) => { c.text("partial response, not a result"); await hold.wait(c); };
    const child = await server.kernel.delegate(root, { agent: "root", title: "child", task: "work" });
    await until(() => driver.sessions.length === 2 && driver.sessions[1]!.turns === 1);
    const grandchild = await server.kernel.delegate(child.nodeId!, { agent: "root", title: "grandchild", task: "keep working" });
    await until(() => driver.sessions.length === 3 && driver.sessions[2]!.turns === 1);
    await server.kernel.tool(child.nodeId!, "report_result", { status: "success", summary: "Old report must be discarded" });
    const sent = await server.kernel.message(child.nodeId!, "take a new approach", undefined, "interrupt");
    expect(sent.delivery).toBe("turn");
    expect(server.store.delegation(child.delegationId)).toMatchObject({ status: "running", round: 1 });
    expect(server.store.delegation(child.delegationId).result).toBeUndefined();
    expect(server.store.delegation(child.delegationId).deliveredAt).toBeUndefined();
    expect(server.store.node(child.nodeId!).status).toBe("running");
    expect(server.store.node(grandchild.nodeId!).status).toBe("running");
    expect(server.store.delegation(grandchild.delegationId).status).toBe("running");
    expect(driver.sessions[1]!.closed).toBe(false);
    expect(driver.sessions[2]!.closed).toBe(false);
    expect(driver.sessions[0]!.prompts).toEqual(["start"]);
    expect(driver.sessions[0]!.steered).toEqual([]);
    expect(server.store.snapshot(run.run.id).turns.filter((t) => t.nodeId === child.nodeId)[0]).toMatchObject({ status: "canceled", error: "interrupted by human message" });
  });

  it("does not mark a late steer accepted by an interrupted turn as delivered", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ script: (c) => hold.wait(c) });
    let resolveSteer: () => void = () => {};
    driver.sessions[0]!.steer = () => new Promise((resolve) => { resolveSteer = () => resolve("steered"); });
    const steering = server.kernel.message(root, "late old steer", "late-old-steer", "steer");
    const redirect = await server.kernel.message(root, "interrupt first", undefined, "interrupt");
    expect(redirect.delivery).toBe("turn");
    resolveSteer();
    const pending = await steering;
    expect(pending.delivery).toBe("queued");
    expect(rows().find((r) => r.seq === pending.itemSeq)?.item).toMatchObject({ delivery: "queued" });
    hold.release();
    await until(() => server.store.node(root).turns === 3 && server.store.node(root).status === "idle");
    expect(driver.sessions[0]!.prompts).toEqual(["start", "interrupt first", "late old steer"]);
  });

  it("preserves a successful steer if its turn completes before the steer response returns", async () => {
    const hold = gate();
    const { server, driver, root, rows, run } = await setup({ script: (c) => hold.wait(c) });
    let resolveSteer: () => void = () => {};
    driver.sessions[0]!.steer = () => new Promise((resolve) => { resolveSteer = () => resolve("steered"); });
    const steering = server.kernel.message(root, "accepted before completion", undefined, "steer");
    hold.release();
    await until(() => server.store.node(root).status === "idle");
    resolveSteer();
    const sent = await steering;
    expect(sent.delivery).toBe("steered");
    expect(rows().find((r) => r.seq === sent.itemSeq)).toMatchObject({ turnId: run.turns[0]!.id, item: { delivery: "steered", escalated: false } });
    expect(driver.sessions[0]!.prompts).toEqual(["start"]);
  });

  it("starts the replacement even when the driver emits no canceled event", async () => {
    const hold = gate();
    const { server, driver, root, run } = await setup({ script: (c) => hold.wait(c) });
    const open = driver.open.bind(driver);
    driver.open = async (spec) => {
      const session = await open(spec), subscribe = session.subscribe.bind(session);
      session.subscribe = (listener) => subscribe((event) => { if (event.type !== "turn_canceled") listener(event); });
      return session;
    };
    const child = await server.kernel.delegate(root, { agent: "root", title: "quiet cancel", task: "work" });
    await until(() => driver.sessions.length === 2 && driver.sessions[1]!.turns === 1);
    await server.kernel.message(child.nodeId!, "restart after quiet cancel", undefined, "interrupt");
    expect(driver.sessions[1]!.prompts).toHaveLength(2);
    expect(server.store.snapshot(run.run.id).turns.filter((t) => t.nodeId === child.nodeId)[0]).toMatchObject({ status: "canceled", error: "interrupted by human message" });
    expect(server.store.delegation(child.delegationId).result).toBeUndefined();
  });

  it("can start an idle node with a previously steered row, without another transcript row", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const sent = await server.kernel.message(root, "steered then idle", "idle-escalation", "steer");
    hold.release();
    await until(() => server.store.node(root).status === "idle");
    expect(await server.kernel.deliverHumanMessage(root, sent.itemSeq, "interrupt")).toEqual({ delivery: "turn", itemSeq: sent.itemSeq });
    expect(driver.sessions[0]!.prompts).toEqual(["start", "steered then idle"]);
    expect(rows().find((r) => r.seq === sent.itemSeq)?.item).toMatchObject({ delivery: "turn", escalated: false });
    expect(rows().filter((r) => r.item.type === "user_message")).toHaveLength(2);
  });

  it("escalates a queued row to steer and removes it from the drain", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const first = await server.kernel.message(root, "steer this", "escalated");
    const second = await server.kernel.message(root, "still queued");
    expect(await server.kernel.deliverHumanMessage(root, first.itemSeq, "steer")).toEqual({ delivery: "steered", itemSeq: first.itemSeq });
    expect(rows().find((r) => r.seq === first.itemSeq)?.item).toMatchObject({ delivery: "steered", escalated: true, clientId: "escalated" });
    expect(driver.sessions[0]!.steered).toEqual(["steer this"]);
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    expect(driver.sessions[0]!.prompts).toEqual(["start", "still queued"]);
    expect(rows().find((r) => r.seq === second.itemSeq)?.item).toMatchObject({ delivery: "turn" });
    expect(rows().filter((r) => r.item.type === "user_message")).toHaveLength(3);
  });

  it("keeps an unsupported escalation queued, and interrupt reuses its row", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ steer: false, script: (c) => hold.wait(c) });
    const queued = await server.kernel.message(root, "urgent", "same-row");
    expect(await server.kernel.deliverHumanMessage(root, queued.itemSeq, "steer")).toEqual({ delivery: "queued", itemSeq: queued.itemSeq, steerUnsupported: true });
    expect(await server.kernel.deliverHumanMessage(root, queued.itemSeq, "interrupt")).toEqual({ delivery: "turn", itemSeq: queued.itemSeq });
    expect(rows().find((r) => r.seq === queued.itemSeq)?.item).toEqual({ type: "user_message", text: "urgent", clientId: "same-row", delivery: "turn", interrupted: true });
    expect(driver.sessions[0]!.prompts).toEqual(["start", "urgent"]);
    expect(rows().filter((r) => r.item.type === "user_message")).toHaveLength(2);
  });

  it.each([false, true])("interrupts a steered message on the same row (escalated=%s)", async (escalated) => {
    const hold = gate();
    const { server, driver, root, rows, run } = await setup({ script: (c) => hold.wait(c) });
    const message = await server.kernel.message(root, "urgent steer", "steered-then-interrupted", escalated ? "queue" : "steer");
    if (escalated) await server.kernel.deliverHumanMessage(root, message.itemSeq, "steer");
    const result = await server.kernel.deliverHumanMessage(root, message.itemSeq, "interrupt");
    expect(result).toEqual({ delivery: "turn", itemSeq: message.itemSeq });
    expect(rows().find((r) => r.seq === message.itemSeq)).toMatchObject({
      turnId: server.store.snapshot(run.run.id).turns[1]!.id,
      item: { delivery: "turn", interrupted: true, escalated, clientId: "steered-then-interrupted" },
    });
    expect(driver.sessions[0]!.prompts).toEqual(["start", "urgent steer"]);
    expect(driver.sessions[0]!.steered).toEqual(["urgent steer"]);
    expect(rows().filter((r) => r.item.type === "user_message")).toHaveLength(2);
  });

  it("retracts only a queued message, leaving its row visible and skipping drain", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const retracted = await server.kernel.message(root, "withdraw this", "withdraw");
    const waiting = await server.kernel.message(root, "send this");
    server.kernel.retractMessage(root, retracted.itemSeq);
    expect(rows().find((r) => r.seq === retracted.itemSeq)?.item).toEqual({ type: "user_message", text: "withdraw this", delivery: "retracted", clientId: "withdraw" });
    await expect(server.kernel.deliverHumanMessage(root, retracted.itemSeq, "interrupt")).rejects.toMatchObject({ status: 409 });
    expect(() => server.kernel.retractMessage(root, retracted.itemSeq)).toThrow("Only queued");
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    expect(driver.sessions[0]!.prompts).toEqual(["start", "send this"]);
    expect(rows().find((r) => r.seq === waiting.itemSeq)?.item).toMatchObject({ delivery: "turn" });
    expect(rows().filter((r) => r.item.type === "notice")).toHaveLength(0);
  });

  it.each(["steer", "interrupt"] as const)("starts one turn if an escalated %s is reserved while the old turn ends", async (mode) => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const queued = await server.kernel.message(root, "race to deliver", "race");
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => { release = resolve; });
    if (mode === "steer") driver.sessions[0]!.steer = async () => { await ready; return "no_active_turn"; };
    else {
      const interrupt = driver.sessions[0]!.interrupt.bind(driver.sessions[0]);
      driver.sessions[0]!.interrupt = async () => { await ready; await interrupt(); };
    }
    const delivering = server.kernel.deliverHumanMessage(root, queued.itemSeq, mode);
    hold.release();
    await until(() => server.store.node(root).status === "idle");
    release();
    expect(await delivering).toEqual({ delivery: "turn", itemSeq: queued.itemSeq });
    await until(() => server.store.node(root).status === "idle");
    expect(driver.sessions[0]!.prompts).toEqual(["start", "race to deliver"]);
    expect(rows().filter((r) => r.item.type === "user_message")).toHaveLength(2);
  });

  it("exposes delivery/retract controls and rejects invalid states and modes over HTTP", async () => {
    const hold = gate();
    const { server, root } = await setup({ script: (c) => hold.wait(c) });
    const request = (path: string, method: string, input?: unknown) => fetch(`${server.url}/api/nodes/${root}/messages${path}`, {
      method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const posted = await request("", "POST", { text: "HTTP queue", clientId: "http-queue" });
    expect(posted.status).toBe(202);
    const queued = await posted.json() as SendMessageResponse;
    expect(queued).toMatchObject({ accepted: true, delivery: "queued" });
    const steered = await request(`/${queued.itemSeq}/deliver`, "POST", { mode: "steer" });
    expect(steered.status).toBe(202);
    expect(await steered.json()).toEqual({ accepted: true, delivery: "steered", itemSeq: queued.itemSeq });
    expect((await request(`/${queued.itemSeq}/deliver`, "POST", { mode: "steer" })).status).toBe(409);
    expect((await request(`/${queued.itemSeq}`, "DELETE")).status).toBe(409);
    const interrupted = await request(`/${queued.itemSeq}/deliver`, "POST", { mode: "interrupt" });
    expect(interrupted.status).toBe(202);
    expect(await interrupted.json()).toEqual({ accepted: true, delivery: "turn", itemSeq: queued.itemSeq });
    const duplicate = await request(`/${queued.itemSeq}/deliver`, "POST", { mode: "interrupt" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toContain("already delivered");
    const withdrawn = await (await request("", "POST", { text: "retract over HTTP" })).json() as SendMessageResponse;
    expect((await request(`/${withdrawn.itemSeq}`, "DELETE")).status).toBe(200);
    expect((await request(`/${withdrawn.itemSeq}`, "DELETE")).status).toBe(409);
    expect((await request("/1/deliver", "POST", { mode: "interrupt" })).status).toBe(409); // initial kernel prompt
    expect((await request("/999/deliver", "POST", { mode: "steer" })).status).toBe(409);
    expect((await request("/0/deliver", "POST", { mode: "steer" })).status).toBe(400);
    expect((await request(`/${withdrawn.itemSeq}/deliver`, "POST", { mode: "queue" })).status).toBe(400);
    expect((await request("", "POST", { text: "bad mode", mode: "unknown" })).status).toBe(400);
  });

  it.each(["turn", "steered", "queued"] as const)("returns the 202 API response for %s delivery", async (delivery) => {
    const hold = gate();
    const { server, root, rows } = await setup({ steer: delivery !== "queued", script: async (c) => { if (delivery !== "turn") await hold.wait(c); } });
    if (delivery === "turn") await until(() => server.store.node(root).status === "idle");
    const response = await fetch(`${server.url}/api/nodes/${root}/messages`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "API request", clientId: "api-client", ...(delivery === "steered" ? { mode: "steer" } : {}) }) });
    expect(response.status).toBe(202);
    const body = await response.json() as SendMessageResponse;
    expect(body).toEqual({ accepted: true, delivery, itemSeq: expect.any(Number) });
    expect(rows().find((r) => r.seq === body.itemSeq)?.item).toEqual({ type: "user_message", text: "API request", clientId: "api-client", delivery, ...(delivery === "steered" ? { escalated: false, steeredAfterSeq: 1 } : {}), ...(delivery === "queued" ? { queuePosition: 1 } : {}) });
  });
});

describe("human queue order", () => {
  const position = (row: ItemRecord | undefined): number | undefined => row?.item.type === "user_message" ? row.item.queuePosition : undefined;

  it("persists deliveryOrder for a reordered batch and omits it for a single delivery", async () => {
    const firstTurn = gate(), batchTurn = gate();
    const { server, driver, root, rows, run } = await setup({ script: async (c) => {
      if (c.turn === 1) await firstTurn.wait(c);
      if (c.turn === 2) await batchTurn.wait(c);
    } });
    const first = await server.kernel.message(root, "first");
    const second = await server.kernel.message(root, "second");
    server.kernel.reorderQueue(root, [second.itemSeq, first.itemSeq]);
    firstTurn.release();
    await until(() => driver.sessions[0]!.prompts.length === 2);
    const batchId = server.store.snapshot(run.run.id).turns[1]!.id;
    expect(driver.sessions[0]!.prompts[1]).toBe("second\n\nfirst");
    for (const [index, sent] of [second, first].entries()) {
      expect(rows().find((row) => row.seq === sent.itemSeq)).toMatchObject({ turnId: batchId, item: { delivery: "turn", deliveryOrder: index + 1 } });
      expect(server.store.events(run.run.id).findLast((event) => event.type === "item" && event.itemSeq === sent.itemSeq)).toMatchObject({ item: { deliveryOrder: index + 1 } });
    }
    const single = await server.kernel.message(root, "alone");
    batchTurn.release();
    await until(() => server.store.node(root).turns === 3 && server.store.node(root).status === "idle");
    const row = rows().find((item) => item.seq === single.itemSeq)!;
    expect(row).toMatchObject({ turnId: server.store.snapshot(run.run.id).turns[2]!.id, item: { delivery: "turn" } });
    expect(row.item).not.toHaveProperty("deliveryOrder");
  });

  it("assigns ascending positions, appends after the current maximum, and clears removed rows", async () => {
    const hold = gate();
    const { server, root, rows } = await setup({ script: (c) => hold.wait(c) });
    const first = await server.kernel.message(root, "first");
    const second = await server.kernel.message(root, "second");
    const third = await server.kernel.message(root, "third");
    expect([first, second, third].map((r) => position(rows().find((row) => row.seq === r.itemSeq)))).toEqual([1, 2, 3]);
    await server.kernel.deliverHumanMessage(root, second.itemSeq, "steer");
    server.kernel.retractMessage(root, first.itemSeq);
    const fourth = await server.kernel.message(root, "fourth");
    expect(position(rows().find((r) => r.seq === fourth.itemSeq))).toBe(4);
    expect(position(rows().find((r) => r.seq === second.itemSeq))).toBeUndefined();
    expect(position(rows().find((r) => r.seq === first.itemSeq))).toBeUndefined();
    await server.kernel.deliverHumanMessage(root, third.itemSeq, "interrupt");
    expect(position(rows().find((r) => r.seq === third.itemSeq))).toBeUndefined();
    expect(position(rows().find((r) => r.seq === fourth.itemSeq))).toBe(4);
  });

  it("reorders through HTTP, emits only changed rows, and drains to one turn in the requested order", async () => {
    const hold = gate();
    const { server, driver, root, run, rows } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const first = await server.kernel.message(root, "first", "first-id");
    const second = await server.kernel.message(root, "second", "second-id");
    const third = await server.kernel.message(root, "third", "third-id");
    const after = server.store.events(run.run.id).at(-1)!.seq;
    const order = [third.itemSeq, second.itemSeq, first.itemSeq];
    const response = await fetch(`${server.url}/api/nodes/${root}/queue`, {
      method: "PUT", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ order }),
    });
    expect(response.status).toBe(200);
    expect(await response.json() as ReorderQueueResponse).toEqual({ order });
    const changed = server.store.events(run.run.id, after).filter((event) => event.type === "item");
    expect(changed.map((event) => event.type === "item" ? event.itemSeq : null)).toEqual([third.itemSeq, first.itemSeq]);
    const unchangedAfter = server.store.events(run.run.id).at(-1)!.seq;
    expect(server.kernel.reorderQueue(root, order)).toEqual({ order });
    expect(server.store.events(run.run.id, unchangedAfter)).toEqual([]);
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    expect(driver.sessions[0]!.prompts).toEqual(["start", "third\n\nsecond\n\nfirst"]);
    const turn = server.store.snapshot(run.run.id).turns[1]!;
    for (const sent of [first, second, third]) {
      const row = rows().find((r) => r.seq === sent.itemSeq)!;
      expect(row).toMatchObject({ turnId: turn.id, item: { delivery: "turn" } });
      expect(position(row)).toBeUndefined();
    }
    expect(rows().filter((r) => r.item.type === "user_message")).toHaveLength(4);
  });

  it("rejects stale, partial, duplicate, and foreign sequences without changing any rows", async () => {
    const hold = gate();
    const { server, root, rows, run } = await setup({ script: (c) => hold.wait(c) });
    const first = await server.kernel.message(root, "first");
    const second = await server.kernel.message(root, "second");
    const before = rows(), after = server.store.events(run.run.id).at(-1)!.seq;
    for (const order of [[], [first.itemSeq], [first.itemSeq, first.itemSeq], [first.itemSeq, 999], [first.itemSeq, second.itemSeq, 999]]) {
      const response = await fetch(`${server.url}/api/nodes/${root}/queue`, {
        method: "PUT", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ order }),
      });
      expect(response.status).toBe(409);
    }
    expect(rows()).toEqual(before);
    expect(server.store.events(run.run.id, after).filter((event) => event.type === "item")).toEqual([]);
    server.kernel.retractMessage(root, first.itemSeq);
    expect(() => server.kernel.reorderQueue(root, [second.itemSeq, first.itemSeq])).toThrow("Queue changed");
  });

  it("retains kernel prompt slots when human messages are reordered", async () => {
    const hold = gate();
    const { server, driver, root } = await setup({ steer: false });
    await until(() => server.store.node(root).status === "idle");
    driver.options.script = async (c) => { if (c.turn === 1) await hold.wait(c); };
    const child = await server.kernel.delegate(root, { agent: "root", title: "child", task: "work" }), id = child.nodeId!;
    await until(() => server.store.node(id).status === "running");
    const first = await server.kernel.message(id, "human first");
    await server.kernel.tool(root, "send", { delegationId: child.delegationId, message: "kernel middle" });
    const second = await server.kernel.message(id, "human second");
    server.kernel.reorderQueue(id, [second.itemSeq, first.itemSeq]);
    hold.release();
    await until(() => server.store.node(id).turns === 2 && server.store.node(id).status === "completed");
    expect(driver.sessions[1]!.prompts[1]).toBe(`human second\n\n<baton-followup delegation="${child.delegationId}">\nkernel middle\n</baton-followup>\n\nhuman first`);
  });

  it("uses item sequence as fallback for older queued rows without positions", async () => {
    const hold = gate();
    const { server, driver, root, rows, run } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const first = await server.kernel.message(root, "legacy first");
    const second = await server.kernel.message(root, "legacy second");
    for (const sent of [first, second]) {
      const row = rows().find((r) => r.seq === sent.itemSeq)!;
      if (row.item.type !== "user_message") throw new Error("Expected user message");
      const { queuePosition: _position, ...item } = row.item;
      server.store.appendItem(run.run.id, { ...row, item });
    }
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    expect(driver.sessions[0]!.prompts[1]).toBe("legacy first\n\nlegacy second");
    expect(() => server.kernel.reorderQueue(root, [second.itemSeq, first.itemSeq])).toThrow("Queue changed");
    expect(server.kernel.reorderQueue(root, [])).toEqual({ order: [] });
  });

  it("accepts a reorder during an in-flight drain before the next turn starts", async () => {
    const hold = gate();
    const { server, driver, root, run } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const first = await server.kernel.message(root, "first in flight");
    const second = await server.kernel.message(root, "second in flight");
    let reordered = false;
    const unsubscribe = server.store.subscribe((event) => {
      if (event.runId === run.run.id && event.type === "turn.updated" && event.patch.status === "completed" && !reordered) {
        reordered = true;
        // finishTurn will enter drainMessages and await session() before this microtask.
        queueMicrotask(() => server.kernel.reorderQueue(root, [second.itemSeq, first.itemSeq]));
      }
    });
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    unsubscribe();
    expect(reordered).toBe(true);
    expect(driver.sessions[0]!.prompts).toEqual(["start", "second in flight\n\nfirst in flight"]);
  });

  it("rejects a stale reorder while the driver is still starting the drained turn", async () => {
    const hold = gate(), next = gate();
    const { server, driver, root, rows } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); else await next.wait(c); } });
    const first = await server.kernel.message(root, "first");
    const second = await server.kernel.message(root, "second");
    let entered = false, release = (): void => {};
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const session = driver.sessions[0]!, start = session.startTurn.bind(session);
    session.startTurn = async (prompt) => { entered = true; await ready; return start(prompt); };
    hold.release();
    await until(() => entered);
    expect(() => server.kernel.reorderQueue(root, [second.itemSeq, first.itemSeq])).toThrow("Queue changed");
    expect(server.kernel.reorderQueue(root, [])).toEqual({ order: [] });
    for (const sent of [first, second]) {
      expect(rows().find((row) => row.seq === sent.itemSeq)?.item).toMatchObject({ delivery: "turn" });
      expect(position(rows().find((row) => row.seq === sent.itemSeq))).toBeUndefined();
    }
    release();
    await until(() => session.prompts.length === 2);
    expect(session.prompts[1]).toBe("first\n\nsecond");
  });
});

describe("editing queued human messages", () => {
  it("replaces text in place and drains the edited text with its position and metadata intact", async () => {
    const hold = gate();
    const { server, driver, root, rows, run } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const first = await server.kernel.message(root, "original first", "edit-client");
    const second = await server.kernel.message(root, "second");
    server.kernel.reorderQueue(root, [second.itemSeq, first.itemSeq]);
    const before = rows().find((row) => row.seq === first.itemSeq)!;
    const response = await fetch(`${server.url}/api/nodes/${root}/messages/${first.itemSeq}`, {
      method: "PATCH", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "  edited first  " }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    const edited = rows().find((row) => row.seq === first.itemSeq)!;
    expect(edited).toEqual({ ...before, item: { ...before.item, text: "  edited first  ", editedAt: expect.any(String) } });
    if (edited.item.type !== "user_message") throw new Error("Expected user message");
    expect(Number.isNaN(Date.parse(edited.item.editedAt!))).toBe(false);
    expect(rows().filter((row) => row.item.type === "user_message")).toHaveLength(3);
    expect(server.store.events(run.run.id).findLast((event) => event.type === "item" && event.itemSeq === first.itemSeq)).toMatchObject({ item: { text: "  edited first  ", editedAt: edited.item.editedAt } });
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    expect(driver.sessions[0]!.prompts[1]).toBe("second\n\n  edited first  ");
    expect(rows().find((row) => row.seq === first.itemSeq)).toMatchObject({
      seq: before.seq, ts: before.ts, turnId: server.store.snapshot(run.run.id).turns[1]!.id,
      item: { text: "  edited first  ", delivery: "turn", deliveryOrder: 2, clientId: "edit-client", editedAt: edited.item.editedAt },
    });
  });

  it.each(["steered", "delivered", "retracted", "kernel", "missing"] as const)("rejects editing a %s message with 409", async (state) => {
    const hold = gate();
    const { server, root, rows } = await setup({ script: (c) => hold.wait(c) });
    const queued = await server.kernel.message(root, "original");
    let seq = queued.itemSeq;
    if (state === "steered") await server.kernel.deliverHumanMessage(root, seq, "steer");
    if (state === "delivered") await server.kernel.deliverHumanMessage(root, seq, "interrupt");
    if (state === "retracted") server.kernel.retractMessage(root, seq);
    if (state === "kernel") seq = 1;
    if (state === "missing") seq = 999;
    const before = rows();
    const response = await fetch(`${server.url}/api/nodes/${root}/messages/${seq}`, {
      method: "PATCH", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "unwanted edit" }),
    });
    expect(response.status).toBe(409);
    expect(rows().filter((row) => row.item.type === "user_message")).toEqual(before.filter((row) => row.item.type === "user_message"));
  });

  it("rejects empty and invalid text with 400 without changing the queued row", async () => {
    const hold = gate();
    const { server, root, rows } = await setup({ script: (c) => hold.wait(c) });
    const queued = await server.kernel.message(root, "original"), before = rows();
    for (const text of ["", " \n\t ", null, 123, undefined]) {
      const response = await fetch(`${server.url}/api/nodes/${root}/messages/${queued.itemSeq}`, {
        method: "PATCH", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ text }),
      });
      expect(response.status).toBe(400);
    }
    expect(rows()).toEqual(before);
  });

  it("rejects an edit after the drain reserved the row but before starting a turn", async () => {
    const hold = gate();
    const { server, driver, root, run, rows } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const queued = await server.kernel.message(root, "reserved original");
    let checked = false, failure: unknown, observedDelivery: unknown;
    const unsubscribe = server.store.subscribe((event) => {
      if (event.runId === run.run.id && event.type === "turn.updated" && event.patch.status === "completed" && !checked) {
        checked = true;
        queueMicrotask(() => {
          observedDelivery = rows().find((row) => row.seq === queued.itemSeq)?.item;
          try { server.kernel.editMessage(root, queued.itemSeq, "too late"); }
          catch (error) { failure = error; }
        });
      }
    });
    hold.release();
    await until(() => server.store.node(root).turns === 2 && server.store.node(root).status === "idle");
    unsubscribe();
    expect(observedDelivery).toMatchObject({ delivery: "queued" });
    expect(failure).toMatchObject({ status: 409, message: "Message delivery is already in progress" });
    expect(driver.sessions[0]!.prompts[1]).toBe("reserved original");
    expect(rows().find((row) => row.seq === queued.itemSeq)?.item).not.toHaveProperty("editedAt");
  });

  it("rejects editing a queued message reserved by a pending steer", async () => {
    const hold = gate();
    const { server, driver, root, rows } = await setup({ script: (c) => hold.wait(c) });
    const queued = await server.kernel.message(root, "being steered");
    let resolveSteer: () => void = () => {};
    driver.sessions[0]!.steer = () => new Promise((resolve) => { resolveSteer = () => resolve("unsupported"); });
    const sending = server.kernel.deliverHumanMessage(root, queued.itemSeq, "steer");
    expect(() => server.kernel.editMessage(root, queued.itemSeq, "racing edit")).toThrow("already in progress");
    resolveSteer(); await sending;
    server.kernel.editMessage(root, queued.itemSeq, "after refusal");
    expect(rows().find((row) => row.seq === queued.itemSeq)?.item).toMatchObject({ delivery: "queued", text: "after refusal", editedAt: expect.any(String) });
  });
});
