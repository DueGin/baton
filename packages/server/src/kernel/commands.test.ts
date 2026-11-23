import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCommand } from "@baton/protocol";
import { FakeDriverRegistry, type FakeDriverOptions } from "../driver/fake.js";
import { Store } from "../store/index.js";
import { Kernel } from "./index.js";

let home: string, store: Store, kernel: Kernel;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "baton-commands-"));
  store = new Store(join(home, "baton.db"));
});
afterEach(async () => {
  vi.useRealTimers();
  await kernel.shutdown(); store.close(); await rm(home, { recursive: true, force: true });
});

async function setup(options: FakeDriverOptions) {
  const registry = new FakeDriverRegistry({ root: { script: () => {}, ...options }, second: options });
  kernel = new Kernel(store, registry, { baseUrl: "http://127.0.0.1:1" });
  const project = await kernel.projects.create({ path: home });
  const { run } = await kernel.createRun({ projectId: project.id, agent: "root", prompt: "start", title: "Test commands" });
  await vi.waitFor(() => expect(store.node(run.rootNodeId).status).toBe("idle"));
  return { nodeId: run.rootNodeId, cwd: project.path, driver: registry.get("root")! };
}

const none = { source: "none", commands: [] };
describe("kernel command discovery", () => {
  it("prefers fresh live commands, normalizes names, then scans after close without reopening", async () => {
    const live = vi.fn(async () => [{ name: "//review", description: "live" }, { name: "review" }, { name: " / " }]);
    const scan = vi.fn(async () => [{ name: "/skill:docs" }]);
    const { nodeId, cwd, driver } = await setup({ sessionCommands: live, scanCommands: scan });
    expect(await kernel.commands(nodeId)).toEqual({ source: "session", commands: [{ name: "review", description: "live" }] });
    expect(scan).not.toHaveBeenCalled();
    live.mockResolvedValueOnce([{ name: "new" }]);
    expect(await kernel.commands(nodeId)).toMatchObject({ commands: [{ name: "new" }] });
    await kernel.cancelNode(nodeId);
    expect(await kernel.commands(nodeId)).toEqual({ source: "scan", commands: [{ name: "skill:docs" }] });
    expect(scan).toHaveBeenCalledWith(cwd);
    expect(driver.sessions).toHaveLength(1); expect(driver.sessions[0]!.closed).toBe(true);
  });

  it("shares scans by (agentId, cwd) across requests and refreshes them after 30s", async () => {
    const scan = vi.fn(async () => [{ name: "scanned" }]);
    const { nodeId, cwd } = await setup({ scanCommands: scan });
    vi.useFakeTimers({ toFake: ["Date"] });
    await Promise.all([kernel.commands(nodeId), kernel.commandsFor("root", cwd)]);
    vi.setSystemTime(Date.now() + 29_000);
    await kernel.commandsFor("root", cwd);
    expect(scan).toHaveBeenCalledTimes(1);
    await kernel.commandsFor("second", cwd); await kernel.commandsFor("root", tmpdir());
    expect(scan).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + 2_000);
    await kernel.commandsFor("root", cwd); expect(scan).toHaveBeenCalledTimes(4);
  });

  it.each(["reject", "timeout"])("falls back after session and scan %s", async failure => {
    const fail = (): Promise<AgentCommand[]> => failure === "reject" ? Promise.reject(new Error("unavailable")) : new Promise(() => {});
    const scan = vi.fn(fail).mockResolvedValueOnce([{ name: "disk" }]);
    const { nodeId, cwd, driver } = await setup({ sessionCommands: fail, scanCommands: scan });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const pending = kernel.commands(nodeId);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await pending).toMatchObject({ source: "scan", commands: [{ name: "disk" }] });
    const failedScan = kernel.commandsFor("second", cwd);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await failedScan).toEqual(none); expect(driver.sessions).toHaveLength(1);
  });

  it("uses the scan when a provider signals unsupported or timeout with an empty live list", async () => {
    const { nodeId } = await setup({ sessionCommands: async () => [], scanCommands: async () => [{ name: "skill" }] });
    expect(await kernel.commands(nodeId)).toEqual({ source: "scan", commands: [{ name: "skill" }] });
  });

  it("returns none instead of an error when nothing is discoverable", async () => {
    const { nodeId, cwd } = await setup({ sessionCommands: async () => [], scanCommands: async () => [{ name: "///" }] });
    expect(await kernel.commands(nodeId)).toEqual(none);
    expect(await kernel.commandsFor("missing", cwd)).toEqual(none);
    await expect(kernel.commands("missing")).rejects.toThrow(/node not found/i);
  });
});
