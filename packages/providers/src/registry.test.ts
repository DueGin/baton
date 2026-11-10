import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ProviderRegistry, versionProbeCommand, probeVersion } from "./registry.js";
const fixture = fileURLToPath(new URL("./test-utils/fake-agent.mjs", import.meta.url));
let home: string;
const disabled = Object.fromEntries(["claude", "codex", "pi", "gemini", "qwen", "kimi", "opencode", "copilot", "cursor", "goose", "droid", "hermes", "openclaw", "kiro"].map(id => [id, { enabled: false }]));
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
});
