import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applyEvent, type RunRecord, type RunSnapshot, type SettingsResponse, type TestTitleModelResponse } from "@baton/protocol";
import { startServer, type BatonServer, type StartServerOptions } from "./api/server.js";
import { FakeDriverRegistry } from "./driver/fake.js";
import type { StoredTitleModel } from "./settings/index.js";

const servers: BatonServer[] = [], homes: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const model = { enabled: true, baseUrl: "https://title.example/v1", model: "title-model", apiKey: "api-test-secret" };
async function setup(options: Partial<StartServerOptions> = {}, config?: unknown): Promise<BatonServer> {
  const home = options.home ?? await mkdtemp(join(tmpdir(), "baton-titles-"));
  if (!homes.includes(home)) homes.push(home);
  if (config) await writeFile(join(home, "config.json"), JSON.stringify(config));
  const server = await startServer({ home, port: 0, registry: new FakeDriverRegistry({ root: (c) => c.text("Done") }), notifier: () => {}, titleGenerator: async () => "Generated title", ...options });
  servers.push(server); return server;
}
async function request(server: BatonServer, path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api<T>(server: BatonServer, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await request(server, path, method, body); if (!response.ok) throw new Error(await response.text()); return await response.json() as T;
}
async function until(test: () => boolean): Promise<void> {
  const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw new Error("Timed out"); await delay(5); }
}
async function create(server: BatonServer, prompt = "Build a pixel football game"): Promise<RunSnapshot> {
  return api(server, "/api/runs", "POST", { agent: "root", cwd: tmpdir(), prompt });
}

describe("run titles over HTTP", () => {
  it("persists settings without returning API keys and preserves unrelated config", async () => {
    const server = await setup({}, { notifications: { desktop: false }, custom: "preserved" });
    expect(await api(server, "/api/settings")).toEqual({});
    const settings = await api<SettingsResponse>(server, "/api/settings", "PUT", { titleModel: model });
    expect(settings).toEqual({ titleModel: { enabled: true, baseUrl: model.baseUrl, model: model.model, hasApiKey: true } });
    const read = await request(server, "/api/settings"); expect(await read.text()).not.toContain(model.apiKey);
    expect((await stat(join(server.home, "config.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(server.home, "config.json"), "utf8"))).toMatchObject({ notifications: { desktop: false }, custom: "preserved", titleModel: model });
    expect((await request(server, "/api/settings", "PUT", { titleModel: { baseUrl: "file:///tmp/title" } })).status).toBe(400);
    expect(await api(server, "/api/settings", "PUT", { titleModel: null })).toEqual({});
    expect((await request(server, "/api/settings", "PUT", { titleModel: { enabled: "yes" } })).status).toBe(400);
  });

  it("creates a provisional title and later emits a replayable generated title", async () => {
    let finish: (title: string) => void = () => {}, started = false;
    const server = await setup({ titleGenerator: async (_settings, prompt) => { started = true; expect(prompt).toBe("Build a pixel football game"); return new Promise((resolve) => { finish = resolve; }); } }, { titleModel: model });
    const snapshot = await create(server);
    expect(snapshot.run).toMatchObject({ title: "Build a pixel football game", titleSource: "prompt" });
    await until(() => started); finish('"标题：双人像素足球。"');
    await until(() => server.store.snapshot(snapshot.run.id).run.titleSource === "generated");
    expect(server.store.list()[0]).toMatchObject({ title: "双人像素足球", titleSource: "generated" });
    expect(server.store.events(snapshot.run.id).some((e) => e.type === "run.updated" && e.patch.title === "双人像素足球" && e.patch.titleSource === "generated")).toBe(true);
    const final = server.store.snapshot(snapshot.run.id);
    expect(server.store.events(snapshot.run.id).reduce(applyEvent, { ...final, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], questions: [], escalations: [], lastSeq: 0 })).toEqual(final);
  });

  it("never overwrites a human rename with an in-flight automatic title", async () => {
    let finish: (title: string) => void = () => {}, started = false;
    const server = await setup({ titleGenerator: async () => { started = true; return new Promise((resolve) => { finish = resolve; }); } }, { titleModel: model });
    const snapshot = await create(server); await until(() => started);
    const renamed = await api<RunSnapshot>(server, `/api/runs/${snapshot.run.id}`, "PATCH", { title: "Human choice" });
    expect(renamed.run.titleSource).toBe("human");
    finish("Ignored generated title"); await delay(20);
    expect(server.store.snapshot(snapshot.run.id).run).toMatchObject({ title: "Human choice", titleSource: "human" });
    expect(server.store.events(snapshot.run.id).some((e) => e.type === "run.updated" && e.patch.titleSource === "generated")).toBe(false);
  });

  it("keeps the provisional title on failure and records a warning without leaking the key", async () => {
    const server = await setup({ titleGenerator: async (config) => { throw new Error(`Rejected ${config.apiKey}`); } }, { titleModel: model });
    const snapshot = await create(server);
    await until(() => server.store.events(snapshot.run.id).some((e) => e.type === "log" && e.level === "warn"));
    expect(server.store.snapshot(snapshot.run.id).run).toMatchObject({ title: "Build a pixel football game", titleSource: "prompt" });
    expect(JSON.stringify(server.store.events(snapshot.run.id))).not.toContain(model.apiKey);
    expect(server.store.events(snapshot.run.id)).toContainEqual(expect.objectContaining({ type: "log", level: "warn", message: "Title generation failed: Rejected [redacted]" }));
  });

  it("forces regeneration of a human title and returns RunRecord or a 502 error", async () => {
    let shouldFail = false;
    const server = await setup({ titleGenerator: async () => { if (shouldFail) throw new Error("Gateway down"); return "Regenerated title"; } }, { titleModel: { ...model, enabled: false } });
    const snapshot = await create(server);
    await api(server, `/api/runs/${snapshot.run.id}`, "PATCH", { title: "Human title" });
    const regenerated = await api<RunRecord>(server, `/api/runs/${snapshot.run.id}/title/regenerate`, "POST", {});
    expect(regenerated).toMatchObject({ id: snapshot.run.id, title: "Regenerated title", titleSource: "generated" });
    expect(regenerated).not.toHaveProperty("run");
    shouldFail = true;
    const failed = await request(server, `/api/runs/${snapshot.run.id}/title/regenerate`, "POST", {});
    expect(failed.status).toBe(502); expect(await failed.json()).toMatchObject({ error: { code: "HTTP_502", message: "Gateway down" } });
    expect(server.store.snapshot(snapshot.run.id).run.title).toBe("Regenerated title");
  });

  it("tests saved or unsaved settings using explicit, latest run or fixed samples", async () => {
    const calls: Array<{ settings: StoredTitleModel; prompt: string }> = [];
    const server = await setup({ titleGenerator: async (settings, prompt) => { calls.push({ settings, prompt }); return "Sample title"; } }, { titleModel: { ...model, enabled: false } });
    const fixed = await api<TestTitleModelResponse>(server, "/api/settings/title-model/test", "POST", {});
    expect(fixed).toMatchObject({ ok: true, title: "Sample title", latencyMs: expect.any(Number) });
    expect(calls[0]?.prompt).toBe("Build a simple task management app.");
    await create(server, "Latest request text");
    await api(server, "/api/settings/title-model/test", "POST", {});
    expect(calls.at(-1)?.prompt).toBe("Latest request text");
    await api(server, "/api/settings/title-model/test", "POST", { titleModel: { model: "unsaved-model", apiKey: "unsaved-key" }, sample: "Explicit sample" });
    expect(calls.at(-1)).toMatchObject({ prompt: "Explicit sample", settings: { model: "unsaved-model", apiKey: "unsaved-key" } });
    expect(await api(server, "/api/settings")).toMatchObject({ titleModel: { model: model.model, hasApiKey: true } });
    expect(JSON.stringify(await api(server, "/api/settings"))).not.toContain("unsaved-key");
    expect((await request(server, "/api/settings/title-model/test", "POST", { sample: 1 })).status).toBe(400);
    expect((await request(server, "/api/settings/title-model/test", "POST", { titleModel: { baseUrl: "ftp://bad" } })).status).toBe(400);
    const unconfigured = await setup();
    expect(await api(unconfigured, "/api/settings/title-model/test", "POST", {})).toMatchObject({ ok: false, error: "Title model is not configured", latencyMs: expect.any(Number) });
  });

  it("does not auto-name old runs on restart but allows explicit regeneration", async () => {
    const original = await setup();
    const snapshot = await create(original, "Legacy title");
    const { titleSource: _old, ...legacy } = original.store.snapshot(snapshot.run.id).run;
    original.store.append(snapshot.run.id, { type: "run.created", run: legacy });
    await original.close(); servers.splice(servers.indexOf(original), 1);
    let calls = 0;
    const restarted = await setup({ home: original.home, titleGenerator: async () => { calls++; return "Explicit legacy title"; } }, { titleModel: model });
    await delay(20);
    expect(calls).toBe(0); expect(restarted.store.snapshot(snapshot.run.id).run).not.toHaveProperty("titleSource");
    expect(await api(restarted, `/api/runs/${snapshot.run.id}/title/regenerate`, "POST", {})).toMatchObject({ title: "Explicit legacy title", titleSource: "generated" });
    expect(calls).toBe(1);
  });

  it("honors an explicit createRun title and does not name after shutdown", async () => {
    let calls = 0, finish: (title: string) => void = () => {};
    const server = await setup({ titleGenerator: async () => { calls++; return new Promise((resolve) => { finish = resolve; }); } }, { titleModel: model });
    const custom = await server.kernel.createRun({ agent: "root", cwd: tmpdir(), prompt: "Prompt", title: "Provided by human" });
    await delay(10); expect(calls).toBe(0); expect(custom.run.titleSource).toBe("human");
    const pending = await create(server); await until(() => calls === 1);
    await server.kernel.shutdown(); finish("Must not update"); await delay(10);
    expect(server.store.snapshot(pending.run.id).run.titleSource).toBe("prompt");
  });
});
