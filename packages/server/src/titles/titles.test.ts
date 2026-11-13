import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../settings/index.js";
import { Titles, createTitleGenerator, sanitizeTitle } from "./index.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function setup(): Promise<Settings> {
  const home = await mkdtemp(join(tmpdir(), "baton-title-settings-")); homes.push(home); return new Settings(home);
}
const model = { enabled: true, baseUrl: "https://title.example/v1", model: "naming-model", apiKey: "secret-for-test" };

describe("title cleanup", () => {
  it.each([
    ["2.5D双人像素足球对战", "2.5D双人像素足球对战"],
    ["步骤 双人像素足球游戏设计\n爸爸，[害羞]先定核心…", "步骤 双人像素足球游戏设计"],
    ['"标题：双人足球游戏。"', "双人足球游戏"],
    ["“**Title: Pixel Football**.”", "Pixel Football"],
    ["```markdown\n# 双人像素足球！\n```", "双人像素足球"],
    ["```双人像素足球```", "双人像素足球"],
    ["<think>First reason\nthrough the task.</think>\nTitle: Pixel Football\nExplanation", "Pixel Football"],
    ["<THINK>Hidden analysis.</THINK>\n爸爸，双人足球。", "双人足球"],
    ["爸爸, Title: Pixel Football!", "Pixel Football"],
    ["**主人，标题：足球游戏！**", "足球游戏"],
    ["- [Pixel Football](https://example.test)\r\nMore text", "Pixel Football"],
    ["1. Pixel Football...", "Pixel Football"],
    ["<b>Pixel Football</b>\nMore", "Pixel Football"],
    ["Build **Pixel** _Football_", "Build Pixel Football"],
    ["```Pixel Football```\nExplanation", "Pixel Football"],
    ["「足球游戏」", "足球游戏"],
    ["😀".repeat(40), "😀".repeat(40)],
  ])("sanitizes %j", (input, expected) => { expect(sanitizeTitle(input)).toBe(expected); });
  it.each([null, undefined, {}, "", "   ", "```\n```", "<think>analysis only</think>", "<think>unterminated", "Title:", "x".repeat(41)])("rejects empty or invalid output %j", (input) => {
    expect(() => sanitizeTitle(input)).toThrow();
  });
});

describe("settings persistence", () => {
  it("atomically preserves unknown configuration, serializes partial updates and hides keys", async () => {
    const settings = await setup();
    expect(await settings.get()).toEqual({});
    await writeFile(settings.path, JSON.stringify({ notifications: { desktop: false }, agents: { root: { enabled: true } }, custom: [1, 2] }), { mode: 0o644 });
    const result = await settings.update({ titleModel: model });
    expect(result).toEqual({ titleModel: { enabled: true, baseUrl: model.baseUrl, model: model.model, hasApiKey: true } });
    expect(JSON.stringify(result)).not.toContain(model.apiKey);
    await Promise.all([settings.update({ titleModel: { model: "new-model" } }), settings.update({ titleModel: { apiKeyEnv: "BATON_TITLE_TEST_KEY" } })]);
    const saved = JSON.parse(await readFile(settings.path, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ notifications: { desktop: false }, agents: { root: { enabled: true } }, custom: [1, 2], titleModel: { model: "new-model", apiKey: model.apiKey, apiKeyEnv: "BATON_TITLE_TEST_KEY" } });
    expect((await stat(settings.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(homes[0]!)).toEqual(["config.json"]);
    const reopened = new Settings(homes[0]!);
    expect(await reopened.get()).toMatchObject({ titleModel: { model: "new-model", hasApiKey: true, apiKeyEnv: "BATON_TITLE_TEST_KEY" } });
    await reopened.update({ titleModel: { apiKey: "", apiKeyEnv: null } });
    expect(await reopened.get()).toMatchObject({ titleModel: { hasApiKey: false } });
    expect(await reopened.model()).not.toHaveProperty("apiKeyEnv");
    await reopened.update({ titleModel: null });
    expect(await reopened.get()).toEqual({});
    expect(JSON.parse(await readFile(settings.path, "utf8"))).toMatchObject({ notifications: { desktop: false }, custom: [1, 2] });
  });
  it.each(["file:///tmp/model", "javascript:alert(1)", "not a URL", "https://user:password@example.test", "https://example.test/?key=secret"]) ("rejects invalid or credential-bearing base URL %j without changing the file", async (baseUrl) => {
    const settings = await setup(); await settings.update({ titleModel: model });
    const before = await readFile(settings.path, "utf8");
    await expect(settings.update({ titleModel: { baseUrl } })).rejects.toThrow(/http\(s\)/);
    expect(await readFile(settings.path, "utf8")).toBe(before);
  });
  it("resolves env keys in preference to stored keys, and allows unsaved test settings", async () => {
    const settings = await setup(); await settings.update({ titleModel: { ...model, apiKeyEnv: "TITLE_KEY" } });
    const calls: Array<{ apiKey?: string; model: string; prompt: string }> = [];
    const titles = new Titles(settings, async (config, prompt) => { calls.push({ apiKey: config.apiKey, model: config.model, prompt }); return '"Title: Named request."'; }, { TITLE_KEY: "environment-secret" });
    expect(await titles.generate("prompt")).toBe("Named request");
    expect(calls[0]).toEqual({ apiKey: "environment-secret", model: model.model, prompt: "prompt" });
    expect(await titles.test({ titleModel: { model: "unsaved", enabled: false, apiKeyEnv: null, apiKey: "unsaved-secret" }, sample: "try this" }, "fallback")).toMatchObject({ ok: true, title: "Named request", latencyMs: expect.any(Number) });
    expect(calls[1]).toEqual({ apiKey: "unsaved-secret", model: "unsaved", prompt: "try this" });
    expect(await settings.model()).toMatchObject({ model: model.model, apiKey: model.apiKey, apiKeyEnv: "TITLE_KEY" });
    const missing = new Titles(settings, async () => { throw new Error("Should not call"); }, {});
    expect(await missing.test({}, "fallback")).toMatchObject({ ok: false, error: "Title model environment variable TITLE_KEY is not set" });
  });
  it("redacts keys from generator errors and skips disabled automatic naming", async () => {
    const settings = await setup(); await settings.update({ titleModel: { ...model, enabled: false } });
    let calls = 0;
    const titles = new Titles(settings, async (config) => { calls++; throw new Error(`Bad key ${config.apiKey}`); });
    expect(await titles.generate("prompt")).toBeUndefined(); expect(calls).toBe(0);
    await expect(titles.generate("prompt", true)).rejects.toThrow("Bad key [redacted]");
    expect(await titles.test({}, "fallback")).toMatchObject({ ok: false, error: "Bad key [redacted]" });
  });
});

describe("chat completions title generator", () => {
  it("uses the required request shape, prompt truncation, bearer key and timeout", async () => {
    let request: RequestInit | undefined, endpoint: string | undefined;
    const generator = createTitleGenerator(async (input, init) => {
      endpoint = String(input); request = init;
      return Response.json({ choices: [{ message: { content: "Title: Pixel Football!" }, finish_reason: "stop" }] });
    });
    expect(await generator({ ...model, baseUrl: model.baseUrl + "/" }, "x".repeat(2100))).toBe("Pixel Football");
    expect(endpoint).toBe("https://title.example/v1/chat/completions");
    expect(request).toMatchObject({ method: "POST", headers: { authorization: `Bearer ${model.apiKey}`, "content-type": "application/json" } });
    const payload = JSON.parse(String(request?.body)) as { messages: Array<{ role: string; content: string }> };
    expect(payload).toMatchObject({ model: model.model, max_tokens: 64, temperature: 0.2 });
    expect(payload.messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("16 Chinese characters or 6 English words") });
    expect(payload.messages[1]).toEqual({ role: "user", content: "Request to name:\n" + "x".repeat(2000) });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });
  it("retries once after provider failure and succeeds", async () => {
    let calls = 0;
    const generator = createTitleGenerator(async () => ++calls === 1 ? new Response("Gateway failure", { status: 503 }) : Response.json({ choices: [{ message: { content: "New title" } }] }));
    expect(await generator(model, "prompt")).toBe("New title"); expect(calls).toBe(2);
  });
  it("rejects null content with finish_reason length after only one retry", async () => {
    let calls = 0;
    const generator = createTitleGenerator(async () => { calls++; return Response.json({ choices: [{ message: { content: null }, finish_reason: "length" }] }); });
    await expect(generator(model, "prompt")).rejects.toThrow("no text"); expect(calls).toBe(2);
  });
  it("retries timeout errors once and honors caller cancellation without retrying", async () => {
    let calls = 0;
    const timeout = createTitleGenerator(async () => { calls++; throw new DOMException("Request timed out", "TimeoutError"); });
    await expect(timeout(model, "prompt")).rejects.toThrow("Request timed out"); expect(calls).toBe(2);
    const controller = new AbortController(); calls = 0;
    const canceled = createTitleGenerator(async (_url, init) => { calls++; controller.abort(); init?.signal?.throwIfAborted(); throw new Error("unreachable"); });
    await expect(canceled(model, "prompt", controller.signal)).rejects.toThrow(); expect(calls).toBe(1);
  });
});
