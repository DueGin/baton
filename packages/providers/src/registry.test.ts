import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ACP_AGENT_SPECS } from "./acp-spec.js";
import { ProviderRegistry, versionProbeCommand, probeVersion } from "./registry.js";
const fixture = fileURLToPath(new URL("./test-utils/fake-agent.mjs", import.meta.url));
let home: string;
const disabled = Object.fromEntries(["claude", "codex", "pi", ...ACP_AGENT_SPECS.map(spec => spec.id)].map(id => [id, { enabled: false }]));
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "baton-registry-test-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
describe("provider detection", () => {
    it("merges profiles, caches catalogs and refreshes on request", async () => {
        await writeFile(join(home, "config.json"), JSON.stringify({ agents: { ...disabled, custom: { extends: "codex", command: [process.execPath, fixture, "codex"], env: { BATON_HOME: home }, label: "Custom Codex", notes: "Good at tests", models: [{ id: "override", label: "Override" }] } } }));
        const registry = new ProviderRegistry({ home, timeoutMs: 3000 });
        const first = registry.detect();
        expect(registry.detect()).toBe(first);
        const entries = await first;
        const custom = entries.find(entry => entry.id === "custom");
        expect(custom).toMatchObject({ status: "ready", kind: "native", label: "Custom Codex", notes: "Good at tests", models: [{ id: "override" }], modes: [{ id: "default" }, { id: "read-only", isReadOnly: true }, { id: "full-access", isUnattended: true }] });
        expect(custom?.version).toMatch(/^v\d/);
        expect(registry.get("custom")?.provider).toBe("codex");
        expect(entries.find(entry => entry.id === "claude")).toMatchObject({ status: "unavailable", diagnostic: "Disabled in config.json" });
        await writeFile(join(home, "config.json"), JSON.stringify({ agents: disabled }));
        expect((await registry.detect()).find(entry => entry.id === "custom")).toBeDefined();
        expect((await registry.detect({ force: true })).some(entry => entry.id === "custom")).toBe(false);
        expect(registry.get("custom")).toBeUndefined();
    });
    it("returns diagnostics for missing binaries and invalid profiles without rejecting", async () => {
        await writeFile(join(home, "config.json"), JSON.stringify({ agents: { ...disabled, missing: { extends: "acp", command: ["baton-binary-that-does-not-exist"] }, invalid: { extends: "other" } } }));
        const entries = await new ProviderRegistry({ home }).detect();
        expect(entries.find(entry => entry.id === "missing")).toMatchObject({ status: "unavailable", diagnostic: expect.stringContaining("not found") });
        expect(entries.find(entry => entry.id === "invalid")).toMatchObject({ status: "unavailable", diagnostic: expect.stringContaining("Invalid agent profile") });
    });
    it("bounds version probes and preserves package runner prefixes", async () => {
        expect(versionProbeCommand(["gemini", "--acp"])).toEqual(["gemini", "--version"]);
        expect(versionProbeCommand(["/bin/npx", "-y", "--package", "fake", "agent", "acp"])).toEqual(["/bin/npx", "-y", "--package", "fake", "agent", "--version"]);
        const script = join(home, "slow");
        await writeFile(script, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o700 });
        await expect(probeVersion([script], { ...process.env, BATON_HOME: home }, 30)).rejects.toThrow("Version probe failed");
    });
    it("exposes missing install hints and gates old versions with error status", async () => {
        await writeFile(join(home, "config.json"), JSON.stringify({ agents: { ...disabled, kimi: { enabled: true, command: [process.execPath, fixture, "acp"], env: { FAKE_VERSION: "2.4.0" }, versionArgs: [fixture, "acp", "--version"] }, missing: { extends: "acp", command: ["baton-not-installed"], installHint: "Install the test CLI", homepage: "https://example.test" } } }));
        const entries = await new ProviderRegistry({ home }).detect();
        expect(entries.find(entry => entry.id === "kimi")).toMatchObject({ status: "error", minVersion: "2.5.0", diagnostic: expect.stringContaining("below required") });
        expect(entries.find(entry => entry.id === "missing")).toMatchObject({ status: "unavailable", installHint: "Install the test CLI", source: "config" });
    });
    it("overrides all ACP spec fields and probes without a session", async () => {
        await writeFile(join(home, "config.json"), JSON.stringify({ agents: { ...disabled, custom: { extends: "acp", command: [process.execPath, fixture, "acp"], label: "Custom ACP", minVersion: "1.0.0", versionArgs: [fixture, "acp", "--version"], env: { FAKE_VERSION: "3.0.0", FAKE_CAPTURE: join(home, "frames.jsonl") }, scrubEnv: ["CUSTOM_DANGER"], modelDiscovery: "cursor", modelCatalogRpc: "cursor/list_available_models", modeMap: { unattended: ["auto"], readOnly: ["safe"] }, noScratchSession: true, elicitation: { form: true, url: false }, longToolCalls: true, toolTimeout: { env: "TOOL_TIMEOUT_MS", milliseconds: 3600000 }, dialect: "kimi", mcp: { supported: true, http: true, sse: false, stdio: true }, installHint: "npm install test", homepage: "https://example.test", models: [{ id: "manual", label: "Manual" }], notes: "customized", source: "local profile", verified: "source", npx: ["npx", "test"] } } }));
        const registry = new ProviderRegistry({ home });
        const entry = (await registry.detect()).find(entry => entry.id === "custom");
        expect(entry).toMatchObject({ status: "ready", label: "Custom ACP", installHint: "npm install test", homepage: "https://example.test", minVersion: "1.0.0", models: [{ id: "manual" }], modes: [{ id: "auto", isUnattended: true }, { id: "safe", isReadOnly: true }] });
        const { readFile } = await import("node:fs/promises");
        expect(await readFile(join(home, "frames.jsonl"), "utf8")).not.toContain("session/new");
    });
    it("reports image capability per agent and hands saveImage to every client", async () => {
        await writeFile(join(home, "config.json"), JSON.stringify({ agents: { ...disabled,
            seeing: { extends: "acp", command: [process.execPath, fixture, "acp"], env: { FAKE_IMAGE_INPUT: "1" }, images: true, installHint: "x", homepage: "https://example.test" },
            blind: { extends: "acp", command: [process.execPath, fixture, "acp"], env: { FAKE_IMAGE_INPUT: "1" }, installHint: "x", homepage: "https://example.test" },
            native: { extends: "codex", command: [process.execPath, fixture, "codex"], env: { BATON_HOME: home } } } }));
        const saved: string[] = [];
        const registry = new ProviderRegistry({ home, timeoutMs: 3000, saveImage: async (data, mimeType) => { saved.push(String(data)); return { id: `att_${saved.length}`, mimeType }; } });
        const entries = await registry.detect();
        expect(entries.find(entry => entry.id === "seeing")?.capabilities.images).toBe(true);
        expect(entries.find(entry => entry.id === "blind")?.capabilities.images).toBe(false);
        expect(entries.find(entry => entry.id === "native")?.capabilities.images).toBe(true);
        expect(entries.find(entry => entry.id === "claude")?.capabilities.images).toBe(true);
        const session = await registry.get("native")!.createSession({ cwd: home });
        try {
            const done = new Promise<void>(resolve => session.subscribe(event => { if (event.type === "turn_completed") resolve(); }));
            await session.startTurn("images");
            await done;
            expect(saved.length).toBeGreaterThan(0);
        }
        finally {
            await session.close();
        }
    });

});
