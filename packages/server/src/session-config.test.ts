import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEntry, UpdateNodeConfigResponse } from "@baton/protocol";
import { startServer, type BatonServer } from "./api/server.js";
import { FakeDriver, FakeDriverRegistry, type FakeDriverOptions } from "./driver/fake.js";

const servers: BatonServer[] = [], homes: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

class ConfigRegistry extends FakeDriverRegistry {
  override async detect(): Promise<AgentEntry[]> {
    return (await super.detect()).map((agent) => ({ ...agent, models: [
      { id: "fake-model", label: "Default", isDefault: true, thinkingOptions: [{ id: "low", label: "Low" }] },
      { id: "another-model", label: "Another", thinkingOptions: [{ id: "high", label: "High" }] },
      { id: "plain-model", label: "Plain" },
    ] }));
  }
}

async function setup(options: FakeDriverOptions = {}, idleTimeoutMs?: number) {
  const home = await mkdtemp(join(tmpdir(), "baton-session-config-")); homes.push(home);
  const driver = new FakeDriver("root", { script: () => {}, ...options });
  const server = await startServer({ home, port: 0, registry: new ConfigRegistry([driver]), notifier: () => {}, idleTimeoutMs, fileCheckpoints: false });
  servers.push(server);
  const { run } = await server.kernel.createRun({ projectId: (await server.kernel.projects.create({ path: home })).id, agent: "root", prompt: "start", title: "Session config", thinking: "low", policy: { teamApproval: false } });
  const nodeId = run.rootNodeId;
  const patch = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/api/nodes/${nodeId}`, { method: "PATCH", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const status = () => server.store.node(nodeId).status;
  return { server, driver, nodeId, run, patch, status };
}

describe("PATCH /api/nodes/:nodeId", () => {
  it("updates an idle session immediately and resumes it with the new configuration and a new identity", async () => {
    const { server, driver, nodeId, run, patch, status } = await setup();
    await vi.waitFor(() => expect(status()).toBe("idle"));
    const first = driver.sessions[0]!;
    const endpoint = first.spec.mcpServers.baton;
    if (!endpoint || endpoint.type !== "http") throw new Error("Missing baton endpoint");
    const token = new URL(endpoint.url).pathname.split("/").at(-1)!;
    const config = { model: "another-model", modeId: "plan", thinking: "high" };
    const response = await patch(config);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: "now", node: config });
    expect(first.closed).toBe(true);
    expect(server.kernel.identify(token)).toBeUndefined();
    expect(driver.sessions).toHaveLength(1);
    expect(server.store.events(run.id)).toContainEqual(expect.objectContaining({ type: "node.updated", nodeId, patch: expect.objectContaining(config) }));
    expect(server.store.events(run.id)).toContainEqual(expect.objectContaining({ type: "log", nodeId, level: "info", message: expect.stringContaining("another-model") }));

    await server.kernel.message(nodeId, "continue");
    const resumed = driver.sessions[1]!;
    expect(resumed.spec).toMatchObject(config);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.turns).toBe(2);
    expect(resumed.spec.mcpServers.baton).not.toEqual(endpoint);
  });

  it("switches only after a running turn and before draining an already queued message", async () => {
    const finish = new AbortController();
    const { server, driver, nodeId, patch } = await setup({ script: async (context) => {
      const signal = AbortSignal.any([finish.signal, context.signal]);
      if (context.turn === 1 && !signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    } });
    await vi.waitFor(() => expect(driver.sessions[0]?.prompts).toEqual(["start"]));
    const first = driver.sessions[0]!;
    const config = { model: "another-model", modeId: "plan", thinking: "high" };
    expect((await server.kernel.message(nodeId, "queued follow-up")).delivery).toBe("queued");
    const response = await patch(config);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: "next_turn", node: config });
    expect(first.closed).toBe(false);
    expect(driver.sessions).toHaveLength(1);

    finish.abort();
    await vi.waitFor(() => expect(driver.sessions[1]?.prompts).toEqual(["queued follow-up"]));
    expect(first.closed).toBe(true);
    expect(first.prompts).toEqual(["start"]);
    expect(driver.sessions[1]!.spec).toMatchObject(config);
    expect(driver.sessions[1]!.sessionId).toBe(first.sessionId);
  });

  it("waits for the old session to close before starting a concurrently submitted message", async () => {
    const { server, driver, nodeId, status } = await setup();
    await vi.waitFor(() => expect(status()).toBe("idle"));
    const first = driver.sessions[0]!;
    const close = first.close.bind(first), closing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    vi.spyOn(first, "close").mockImplementation(async () => { closing.resolve(); await release.promise; await close(); });
    const update = server.kernel.updateNodeConfig(nodeId, { modeId: "plan" });
    await closing.promise;
    const message = server.kernel.message(nodeId, "continue during close");
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(driver.sessions).toHaveLength(1);
      expect(first.prompts).toEqual(["start"]);
    } finally { release.resolve(); }
    expect(await update).toMatchObject({ applied: "now" });
    expect(await message).toMatchObject({ delivery: "turn" });
    expect(driver.sessions[1]!.spec.modeId).toBe("plan");
    expect(driver.sessions[1]!.prompts).toEqual(["continue during close"]);
  });

  it("rejects invalid values without changing the configuration or closing the session", async () => {
    const { server, driver, nodeId, patch, status } = await setup();
    await vi.waitFor(() => expect(status()).toBe("idle"));
    for (const input of [{ model: "unknown" }, { modeId: "not found" }, { thinking: "high" }, { model: "another-model", thinking: "low" }, { model: false }]) {
      expect((await patch(input)).status).toBe(400);
    }
    expect(server.store.node(nodeId)).toMatchObject({ model: "fake-model", modeId: "default", thinking: "low" });
    expect(driver.sessions[0]!.closed).toBe(false);
  });

  it("rejects a configuration change for a non-resumable open session and preserves the conversation", async () => {
    const { server, driver, nodeId, patch, status } = await setup({ resume: false });
    await vi.waitFor(() => expect(status()).toBe("idle"));
    const first = driver.sessions[0]!;
    const before = server.store.node(nodeId);
    const response = await patch({ modeId: "plan" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { message: "该 agent 不支持续接会话，切换配置会丢失上下文" } });
    expect(server.store.node(nodeId)).toEqual(before);
    expect(first.closed).toBe(false);
    await server.kernel.message(nodeId, "continue in context");
    expect(driver.sessions).toEqual([first]);
    expect(first.prompts).toEqual(["start", "continue in context"]);
  });

  it("accepts a configuration change for a non-resumable session that has not opened", async () => {
    const { server, driver, nodeId, run, status } = await setup({ resume: false });
    await vi.waitFor(() => expect(status()).toBe("idle"));
    await server.kernel.pauseRun(run.id);
    const queued = await server.kernel.delegate(nodeId, { agent: "root", title: "Queued", task: "Start on resume" });
    expect(server.store.delegation(queued.delegationId).status).toBe("queued");
    expect(driver.sessions).toHaveLength(1);
    expect(await server.kernel.updateNodeConfig(queued.nodeId!, { modeId: "plan" })).toMatchObject({ applied: "now", node: { modeId: "plan" } });
    await server.kernel.resumeRun(run.id);
    expect(driver.sessions[1]?.spec.modeId).toBe("plan");
  });

  it("clears incompatible thinking and resets explicitly null fields to provider defaults", async () => {
    const { server, driver, nodeId, patch, status } = await setup();
    await vi.waitFor(() => expect(status()).toBe("idle"));
    const changed = await patch({ model: "plain-model" });
    expect(changed.status).toBe(200);
    const response: UpdateNodeConfigResponse = await changed.json();
    expect(response.node.model).toBe("plain-model");
    expect(response.node.modeId).toBe("default");
    expect(response.node).not.toHaveProperty("thinking");

    expect((await patch({ model: "another-model", modeId: "plan", thinking: "high" })).status).toBe(200);
    const reset = await patch({ model: null, modeId: null, thinking: null });
    expect(reset.status).toBe(200);
    const cleared: UpdateNodeConfigResponse = await reset.json();
    for (const key of ["model", "modeId", "thinking"]) expect(cleared.node).not.toHaveProperty(key);
    await server.kernel.message(nodeId, "use defaults");
    expect(driver.sessions[1]!.spec).toMatchObject({ model: undefined, modeId: undefined, thinking: undefined });
    expect(server.store.node(nodeId)).toMatchObject({ model: "fake-model", modeId: "default" });
  });

  it.each(["failed", "canceled", "replaced"] as const)("rejects %s nodes with 409", async (terminal) => {
    const { server, nodeId, run, patch, status } = await setup({ script: () => { if (terminal === "failed") throw new Error("test failure"); } });
    if (terminal === "failed") await vi.waitFor(() => expect(status()).toBe("failed"));
    else {
      await server.kernel.cancelNode(nodeId);
      if (terminal === "replaced") server.store.append(run.id, { type: "node.updated", nodeId, patch: { status: "replaced" } });
    }
    expect((await patch({ modeId: "plan" })).status).toBe(409);
  });

  it("allows completed nodes to change configuration and reopen on follow-up", async () => {
    const { server, driver, nodeId, patch, status } = await setup({}, 20);
    await vi.waitFor(() => expect(status()).toBe("completed"));
    const response = await patch({ modeId: "plan" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: "now", node: { modeId: "plan", status: "completed" } });
    await server.kernel.message(nodeId, "follow up");
    expect(driver.sessions[1]!.spec.modeId).toBe("plan");
  });
});
