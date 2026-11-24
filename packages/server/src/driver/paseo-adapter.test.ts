import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACP_AGENT_SPECS, ProviderRegistry, type AgentClient, type AgentSession } from "@baton/providers";
import { createPaseoDriverRegistry, mapProviderEvent } from "./paseo-adapter.js";
import type { DriverEvent, DriverRegistry, DriverSession } from "./types.js";
let home: string;
let registry: DriverRegistry;
const fixture = fileURLToPath(new URL("../../../providers/src/test-utils/fake-agent.mjs", import.meta.url));
const disabled = Object.fromEntries(["claude", "codex", "pi", ...ACP_AGENT_SPECS.map(spec => spec.id)].map(id => [id, { enabled: false }]));
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "baton-driver-test-"));
    const profiles = Object.fromEntries(["acp", "codex"].map(provider => [`fake-${provider}`, { extends: provider, command: [process.execPath, fixture, provider], env: { BATON_HOME: home } }]));
    Object.assign(profiles, Object.fromEntries(["builtin", "adapter"].map(mcp => [`fake-pi-${mcp}`, { extends: "pi", command: [process.execPath, fixture, "pi"], env: { BATON_HOME: home, FAKE_MCP: mcp } }])));
    await writeFile(join(home, "config.json"), JSON.stringify({ agents: { ...disabled, ...profiles } }));
    registry = createPaseoDriverRegistry({ home });
});
afterEach(async () => { await registry.shutdown(); await rm(home, { recursive: true, force: true }); });
function collect(session: DriverSession): DriverEvent[] { const events: DriverEvent[] = []; session.subscribe(event => events.push(event)); return events; }
async function until(events: DriverEvent[], type: DriverEvent["type"]): Promise<void> { await expect.poll(() => events.some(event => event.type === type), { interval: 10 }).toBe(true); }
describe("Paseo driver registry", () => {
    it.each([true, false])("forwards command listings only when the provider implements them (supported=%s)", async supported => {
        const scan = vi.fn(async (cwd: string) => [{ name: "scan", description: cwd }]);
        const live = vi.fn(async () => [{ name: "live", argumentHint: "<file>" }]);
        const session: AgentSession = {
            sessionId: "live", getPersistence: () => null, startTurn: async () => ({ turnId: "turn" }),
            interrupt: async () => {}, respondToPermission: async () => {}, pendingPermissions: () => [],
            subscribe: () => () => {}, runtimeInfo: async () => ({}), close: async () => {},
            ...(supported ? { listCommands: live, hasBackgroundWork: () => true } : {}),
        };
        const client: AgentClient = {
            provider: "codex", capabilities: { steer: true, resume: true, reasoning: true, mcp: true, images: true },
            fetchCatalog: async () => ({ models: [], modes: [] }), createSession: vi.fn(async () => session), resumeSession: async () => session,
            ...(supported ? { listCommands: scan } : {}),
        };
        vi.spyOn(ProviderRegistry.prototype, "get").mockReturnValue(client);
        vi.spyOn(ProviderRegistry.prototype, "detect").mockResolvedValue([{ id: "fixture", label: "Fixture", status: "ready", enabled: true, kind: "native", checkedAt: "now", capabilities: client.capabilities, models: [], modes: [] }]);
        try {
            await registry.detect();
            const driver = registry.get("fixture")!;
            expect(await driver.listCommands?.(home)).toEqual(supported ? [{ name: "scan", description: home }] : undefined);
            expect(client.createSession).not.toHaveBeenCalled();
            const wrapped = await driver.open({ cwd: home, mcpServers: {} });
            expect(wrapped.hasBackgroundWork?.()).toBe(supported);
            expect(await wrapped.listCommands?.()).toEqual(supported ? [{ name: "live", argumentHint: "<file>" }] : undefined);
        } finally { vi.restoreAllMocks(); }
    });
    it("detects drivers and maps a complete turn through the real fake-process adapters", async () => {
        expect(registry.get("fake-codex")).toBeUndefined();
        const entries = await registry.detect();
        expect(entries.find(entry => entry.id === "fake-codex")?.status).toBe("ready");
        const driver = registry.get("fake-codex")!;
        const session = await driver.open({ cwd: home, mcpServers: { baton: { type: "http", url: "http://127.0.0.1:7433/test" } } });
        const events = collect(session);
        expect(session.supportsLongToolCalls?.()).toBe(true);
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
        // Codex rewinds natively: the driver exposes the provider's rewind point and fork.
        expect(session.rewindPoint?.()).toEqual({ threadId: "fake-session", turnId: null, index: -1 });
        expect(typeof session.rewindConversation).toBe("function");
        const persistence = session.persistence()!;
        await session.close();
        expect(session.processIds?.()).toEqual([]);
        const resumed = await driver.resume(persistence, { cwd: home, mcpServers: {} });
        expect(resumed.supportsLongToolCalls?.()).toBe(false);
        expect(resumed.persistence()).toEqual(persistence);
        await expect(driver.resume({ provider: "pi", sessionId: "invalid" }, { cwd: home, mcpServers: {} })).rejects.toThrow("Invalid provider persistence");
    });
    it("returns steer outcomes for ACP and native sessions, and closes all processes on shutdown", async () => {
        await registry.detect();
        const acp = await registry.get("fake-acp")!.open({ cwd: home, mcpServers: {} });
        expect(acp.supportsLongToolCalls?.()).toBe(false);
        expect(await acp.steer("idle")).toBe("unsupported");
        // ACP agents have no native rewind: rollback replays the transcript into a fresh session.
        expect(acp.rewindConversation).toBeUndefined();
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
        expect(mapProviderEvent({ type: "turn_started", turnId: "wake", origin: "agent" })).toEqual({ type: "turn_started", turnId: "wake", origin: "agent" });
        expect(mapProviderEvent({ type: "timeline", timestamp: "now", item: { type: "notification", level: "warning", message: "hello" } })).toMatchObject({ type: "item", item: { type: "notice", message: "hello" } });
        expect(mapProviderEvent({ type: "timeline", timestamp: "now", item: { type: "tool_call", callId: "x", name: "worktree", status: "completed", error: null, detail: { type: "worktree_setup", worktreePath: home, branchName: "x", log: "", commands: [] } } })).toBeNull();
    });
    it("advertises long tool calls only for builtin pi MCP with an injected timeout", async () => {
        await registry.detect();
        const spec = { cwd: home, env: { MCP_TOOL_TIMEOUT: "3660000" }, mcpServers: { baton: { type: "http" as const, url: "http://127.0.0.1:7433/test" } } };
        const builtin = await registry.get("fake-pi-builtin")!.open(spec);
        const adapter = await registry.get("fake-pi-adapter")!.open(spec);
        expect(builtin.supportsLongToolCalls?.()).toBe(true);
        expect(adapter.supportsLongToolCalls?.()).toBe(false);
        const providersHome = (await readdir(home)).filter(name => name.startsWith("pi-runtime-"));
        const extensions = await Promise.all(providersHome.map(async name => { try { return await readFile(join(home, name, "baton.mjs"), "utf8"); } catch { return ""; } }));
        expect(extensions.some(value => value.includes('"timeout":3660'))).toBe(true);
    });
});
