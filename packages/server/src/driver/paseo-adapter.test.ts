import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPaseoDriverRegistry, mapProviderEvent } from "./paseo-adapter.js";
import type { DriverEvent, DriverRegistry, DriverSession } from "./types.js";
let home: string;
let registry: DriverRegistry;
const fixture = fileURLToPath(new URL("../../../providers/src/test-utils/fake-agent.mjs", import.meta.url));
const disabled = Object.fromEntries(["claude", "codex", "pi", "gemini", "qwen", "kimi", "opencode", "copilot", "cursor", "goose", "droid", "hermes", "openclaw", "kiro"].map(id => [id, { enabled: false }]));
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "baton-driver-test-"));
    const profiles = Object.fromEntries(["acp", "codex"].map(provider => [`fake-${provider}`, { extends: provider, command: [process.execPath, fixture, provider], env: { BATON_HOME: home } }]));
    await writeFile(join(home, "config.json"), JSON.stringify({ agents: { ...disabled, ...profiles } }));
    registry = createPaseoDriverRegistry({ home });
});
afterEach(async () => { await registry.shutdown(); await rm(home, { recursive: true, force: true }); });
function collect(session: DriverSession): DriverEvent[] { const events: DriverEvent[] = []; session.subscribe(event => events.push(event)); return events; }
async function until(events: DriverEvent[], type: DriverEvent["type"]): Promise<void> { await expect.poll(() => events.some(event => event.type === type), { interval: 10 }).toBe(true); }
describe("Paseo driver registry", () => {
    it("detects drivers and maps a complete turn through the real fake-process adapters", async () => {
        expect(registry.get("fake-codex")).toBeUndefined();
        const entries = await registry.detect();
        expect(entries.find(entry => entry.id === "fake-codex")?.status).toBe("ready");
        const driver = registry.get("fake-codex")!;
        const session = await driver.open({ cwd: home, mcpServers: { baton: { type: "http", url: "http://127.0.0.1:7433/test" } } });
        const events = collect(session);
        expect(session.processIds?.()).toEqual([expect.any(Number)]);
        session.subscribe(() => { throw new Error("bad listener"); });
        expect(await session.steer("idle")).toBe("no_active_turn");
        const { turnId } = await session.startTurn("permission");
        await until(events, "permission_requested");
        const request = session.pendingPermissions()[0]!;
        await session.respondToPermission(request.id, { behavior: "allow" });
        await until(events, "turn_completed");
        expect(events.find(event => event.type === "permission_resolved")).toMatchObject({ turnId, response: { behavior: "allow" } });
        expect(events.find(event => event.type === "item" && event.item.type === "tool_call" && event.item.status === "completed")).toMatchObject({ turnId, item: { detail: { type: "shell", command: "echo hello" } } });
        expect(events.find(event => event.type === "turn_completed")).toMatchObject({ usage: { inputTokens: 10 } });
        expect(await session.runtimeInfo()).toEqual({ model: "fake-model", modeId: "default" });
        const persistence = session.persistence()!;
        await session.close();
        expect(session.processIds?.()).toEqual([]);
        const resumed = await driver.resume(persistence, { cwd: home, mcpServers: {} });
        expect(resumed.persistence()).toEqual(persistence);
        await expect(driver.resume({ provider: "pi", sessionId: "invalid" }, { cwd: home, mcpServers: {} })).rejects.toThrow("Invalid provider persistence");
    });
    it("returns steer outcomes for ACP and native sessions, and closes all processes on shutdown", async () => {
        await registry.detect();
        const acp = await registry.get("fake-acp")!.open({ cwd: home, mcpServers: {} });
        expect(await acp.steer("idle")).toBe("unsupported");
        const codex = await registry.get("fake-codex")!.open({ cwd: home, mcpServers: {} });
        const events = collect(codex);
        await codex.startTurn("hold");
        expect(await codex.steer("finish")).toBe("steered");
        await until(events, "turn_completed");
        await registry.shutdown();
        expect(registry.get("fake-codex")).toBeUndefined();
        await expect(codex.startTurn("closed")).rejects.toThrow("closed");
    });
    it("maps notices and drops worktree rows without changing the contract", () => {
        expect(mapProviderEvent({ type: "timeline", timestamp: "now", item: { type: "notification", level: "warning", message: "hello" } })).toMatchObject({ type: "item", item: { type: "notice", message: "hello" } });
        expect(mapProviderEvent({ type: "timeline", timestamp: "now", item: { type: "tool_call", callId: "x", name: "worktree", status: "completed", error: null, detail: { type: "worktree_setup", worktreePath: home, branchName: "x", log: "", commands: [] } } })).toBeNull();
    });
});
