import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ACPAgentClient, acpPromptBlocks } from "./acp-agent.js";
import { CodexAppServerAgentClient, codexTurnInput } from "./codex-agent.js";
import { PiRpcAgentClient, piPromptPayload } from "./pi-agent.js";
import { claudePromptContent } from "./claude-agent.js";
import { AcpAgentSpecSchema } from "../acp-spec.js";
import { OrderedTasks, findImageBlocks, promptText, saveProviderImages } from "../images.js";
import type { AgentClient, AgentPromptPart, AgentSession, AgentStreamEvent, ClientOptions, SaveImage } from "../agent-sdk-types.js";

const fixture = fileURLToPath(new URL("../test-utils/fake-agent.mjs", import.meta.url));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let home: string, image: string, sessions: AgentSession[];
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "baton-provider-images-")); image = join(home, "shot.png"); await writeFile(image, PNG); sessions = []; });
afterEach(async () => { await Promise.allSettled(sessions.map(session => session.close())); await rm(home, { recursive: true, force: true }); });

const prompt = (): AgentPromptPart[] => [{ type: "text", text: "look " }, { type: "image", path: image, mimeType: "image/png", name: "shot.png" }, { type: "text", text: " here" }];
function recorder(): { saved: Array<{ data: string; mimeType: string; name?: string }>; saveImage: SaveImage } {
    const saved: Array<{ data: string; mimeType: string; name?: string }> = [];
    // Slow on purpose: the turn must still end after the image items.
    return { saved, saveImage: async (data, mimeType, name) => { await delay(30); saved.push({ data: typeof data === "string" ? data : Buffer.from(data).toString("base64"), mimeType, ...(name ? { name } : {}) }); return { id: `att_${saved.length}`, mimeType: "image/png", ...(name ? { name } : {}) }; } };
}
function client(kind: "codex" | "pi" | "acp", extra: Partial<ClientOptions> & { env?: Record<string, string> } = {}): AgentClient {
    const options: ClientOptions = { command: [process.execPath, fixture, kind], home, timeoutMs: 3000, ...extra, env: { BATON_HOME: home, FAKE_CAPTURE: join(home, "frames.jsonl"), FAKE_IMAGE_PATH: image, ...extra.env } };
    return kind === "codex" ? new CodexAppServerAgentClient(options) : kind === "pi" ? new PiRpcAgentClient(options) : new ACPAgentClient(options);
}
async function open(provider: AgentClient): Promise<{ session: AgentSession; events: AgentStreamEvent[] }> {
    const session = await provider.createSession({ cwd: home });
    sessions.push(session);
    const events: AgentStreamEvent[] = [];
    session.subscribe(event => events.push(event));
    return { session, events };
}
async function completed(events: AgentStreamEvent[]): Promise<void> { await expect.poll(() => events.some(event => event.type === "turn_completed"), { timeout: 4000, interval: 10 }).toBe(true); }
async function frames(): Promise<Array<Record<string, unknown>>> { return (await readFile(join(home, "frames.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>); }
function timeline(events: AgentStreamEvent[]) { return events.flatMap(event => event.type === "timeline" ? [event.item] : []); }
function completedAfter(events: AgentStreamEvent[], predicate: (event: AgentStreamEvent) => boolean): boolean {
    const index = events.findIndex(predicate);
    return index >= 0 && index < events.findIndex(event => event.type === "turn_completed");
}

describe("image helpers", () => {
    it("renders prompt parts as text with path notes", () => {
        expect(promptText("plain")).toBe("plain");
        expect(promptText(prompt())).toBe(`look [图片 shot.png: ${image}] here`);
        expect(promptText(prompt(), (part, index) => `<${index}:${part.name}>`)).toBe("look <0:shot.png> here");
    });
    it("finds image blocks in the shapes providers return", () => {
        expect(findImageBlocks([{ type: "text", text: "x" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }])).toEqual([{ data: "AAA", mimeType: "image/png" }]);
        expect(findImageBlocks({ content: [{ type: "image", data: "BBB", mimeType: "image/jpeg" }] })).toEqual([{ data: "BBB", mimeType: "image/jpeg" }]);
        expect(findImageBlocks({ type: "image", file: { base64: "CCC", type: "image/webp" } })).toEqual([{ data: "CCC", mimeType: "image/webp" }]);
        expect(findImageBlocks({ type: "text", text: "image" })).toEqual([]);
    });
    it("stores inline and file images and skips the ones the host refuses", async () => {
        const save: SaveImage = async (data, mimeType, name) => { if (typeof data === "string" && data === "bad") throw new Error("not an image"); return { id: `att_${name ?? "x"}`, mimeType }; };
        expect(await saveProviderImages(save, [{ data: "bad" }, { data: "AAA", mimeType: "image/png", name: "a" }, { path: image }, { path: join(home, "missing.png") }])).toEqual([{ id: "att_a", mimeType: "image/png" }, { id: "att_shot.png", mimeType: "" }]);
        expect(await saveProviderImages(undefined, [{ data: "AAA" }])).toEqual([]);
    });
    it("runs tasks in order, synchronously until one turns asynchronous", async () => {
        const tasks = new OrderedTasks(), order: string[] = [];
        tasks.run(() => { order.push("a"); });
        expect(order).toEqual(["a"]);
        tasks.run(async () => { await delay(20); order.push("b"); });
        tasks.run(() => { throw new Error("ignored"); });
        tasks.run(() => { order.push("c"); });
        expect(order).toEqual(["a"]);
        await tasks.idle();
        expect(order).toEqual(["a", "b", "c"]);
        tasks.run(() => { order.push("d"); });
        expect(order).toEqual(["a", "b", "c", "d"]);
    });
});

describe("prompt conversion per driver", () => {
    it("Claude: base64 image blocks in place, path notes when the file is unusable", async () => {
        expect(await claudePromptContent("plain")).toBe("plain");
        expect(await claudePromptContent(prompt())).toEqual([{ type: "text", text: "look " }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } }, { type: "text", text: " here" }]);
        const missing = join(home, "gone.png");
        expect(await claudePromptContent([{ type: "image", path: missing, mimeType: "image/png" }])).toEqual([{ type: "text", text: `[图片: ${missing}]` }]);
        expect(await claudePromptContent([{ type: "image", path: image, mimeType: "image/bmp", name: "b" }])).toEqual([{ type: "text", text: `[图片 b: ${image}]` }]);
    });
    it("Codex: localImage items between text items", async () => {
        expect(await codexTurnInput("plain")).toEqual([{ type: "text", text: "plain" }]);
        expect(await codexTurnInput(prompt())).toEqual([{ type: "text", text: "look " }, { type: "localImage", path: image }, { type: "text", text: " here" }]);
        expect(await codexTurnInput([{ type: "image", path: join(home, "gone.png"), mimeType: "image/png" }])).toEqual([{ type: "text", text: `[图片: ${join(home, "gone.png")}]` }]);
    });
    it("Pi: base64 images plus a positional marker for image models, the path note otherwise", async () => {
        expect(await piPromptPayload("plain", true)).toEqual({ message: "plain" });
        expect(await piPromptPayload(prompt(), true)).toEqual({ message: "look [图片 shot.png] here", images: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] });
        expect(await piPromptPayload(prompt(), false)).toEqual({ message: `look [图片 shot.png: ${image}] here` });
    });
    it("ACP: image blocks only when the agent advertised promptCapabilities.image", async () => {
        expect(await acpPromptBlocks("plain", true, "system")).toEqual([{ type: "text", text: "system\n\nplain" }]);
        expect(await acpPromptBlocks(prompt(), true, "system")).toEqual([{ type: "text", text: "system\n\nlook " }, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }, { type: "text", text: " here" }]);
        expect(await acpPromptBlocks(prompt(), false)).toEqual([{ type: "text", text: `look [图片 shot.png: ${image}] here` }]);
    });
});

describe("image prompts reach the agent process", () => {
    it("Codex sends localImage input on turn/start", async () => {
        const { session, events } = await open(client("codex"));
        await session.startTurn(prompt());
        await completed(events);
        expect((await frames()).find(frame => frame.method === "turn/start")).toMatchObject({ params: { input: [{ type: "text", text: "look " }, { type: "localImage", path: image }, { type: "text", text: " here" }] } });
        expect(timeline(events).find(item => item.type === "user_message")).toEqual({ type: "user_message", text: `look [图片 shot.png: ${image}] here` });
    });
    it.each([true, false])("Pi forwards images only when the model takes image input (%s)", async (imageInput) => {
        const { session, events } = await open(client("pi", { env: imageInput ? { FAKE_IMAGE_INPUT: "1" } : {} }));
        await session.startTurn(prompt());
        await completed(events);
        const frame = (await frames()).find(frame => frame.type === "prompt");
        expect(frame).toEqual(expect.objectContaining(imageInput ? { message: "look [图片 shot.png] here", images: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] } : { message: `look [图片 shot.png: ${image}] here` }));
        if (!imageInput)
            expect(frame).not.toHaveProperty("images");
    });
    it.each([true, false])("ACP sends image blocks only when initialize advertised them (%s)", async (imageInput) => {
        const { session, events } = await open(client("acp", { env: imageInput ? { FAKE_IMAGE_INPUT: "1" } : {} }));
        await session.startTurn(prompt());
        await completed(events);
        const blocks = (await frames()).find(frame => frame.method === "session/prompt")?.params as { prompt: unknown };
        expect(blocks.prompt).toEqual(imageInput ? [{ type: "text", text: "look " }, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }, { type: "text", text: " here" }] : [{ type: "text", text: `look [图片 shot.png: ${image}] here` }]);
    });
    it("ACP capabilities.images needs both the spec flag and promptCapabilities.image", async () => {
        const spec = (images: boolean) => AcpAgentSpecSchema.parse({ id: "fake", label: "Fake", command: [process.execPath, fixture, "acp"], homepage: "https://example.com", installHint: "fake", mcp: { supported: true, http: true, sse: true, stdio: true }, images });
        const probe = async (images: boolean, advertised: boolean) => {
            const provider = new ACPAgentClient({ command: [process.execPath, fixture, "acp"], home, timeoutMs: 3000, spec: spec(images), env: advertised ? { FAKE_IMAGE_INPUT: "1" } : {} });
            await provider.fetchCatalog();
            return provider.capabilities.images;
        };
        expect(await probe(true, true)).toBe(true);
        expect(await probe(true, false)).toBe(false);
        expect(await probe(false, true)).toBe(false);
        expect(new CodexAppServerAgentClient({ command: ["codex"], home }).capabilities.images).toBe(true);
        expect(new PiRpcAgentClient({ command: ["pi"], home }).capabilities.images).toBe(true);
    });
});

describe("images agents return are stored and referenced", () => {
    it("Codex: MCP image results, view_image and generated images", async () => {
        const { saved, saveImage } = recorder();
        const { session, events } = await open(client("codex", { saveImage }));
        await session.startTurn("images");
        await completed(events);
        const items = timeline(events);
        expect(items.find(item => item.type === "tool_call" && item.name === "browser.screenshot" && item.status === "completed")).toMatchObject({ images: [{ id: "att_1", mimeType: "image/png" }] });
        expect(JSON.stringify(items)).not.toContain(PNG.toString("base64"));
        expect(items.find(item => item.type === "tool_call" && item.name === "view_image")).toMatchObject({ status: "completed", detail: { type: "read", filePath: image }, images: [{ id: "att_2", name: "shot.png" }] });
        expect(items.filter(item => item.type === "tool_call" && item.name === "image_generation").map(item => item.type === "tool_call" ? item.status : "")).toEqual(["running", "completed"]);
        expect(items.find(item => item.type === "assistant_message" && item.text.includes("attachment:att_3"))).toMatchObject({ text: "\n\n![生成的图片](attachment:att_3)\n\n" });
        expect(saved.map(image => image.data)).toEqual([PNG.toString("base64"), PNG.toString("base64"), PNG.toString("base64")]);
        expect(completedAfter(events, event => event.type === "timeline" && event.item.type === "assistant_message" && event.item.text.includes("attachment:att_3"))).toBe(true);
    });
    it("Pi: tool_execution_end image content", async () => {
        const { saved, saveImage } = recorder();
        const { session, events } = await open(client("pi", { saveImage }));
        await session.startTurn("images");
        await completed(events);
        expect(timeline(events).find(item => item.type === "tool_call" && item.name === "screenshot" && item.status === "completed")).toMatchObject({ images: [{ id: "att_1", mimeType: "image/png" }] });
        expect(saved).toHaveLength(1);
        expect(completedAfter(events, event => event.type === "timeline" && event.item.type === "tool_call" && event.item.name === "screenshot" && event.item.status === "completed")).toBe(true);
    });
    it("ACP: tool content images and image message chunks", async () => {
        const { saved, saveImage } = recorder();
        const { session, events } = await open(client("acp", { saveImage }));
        await session.startTurn("images");
        await completed(events);
        const items = timeline(events);
        expect(items.find(item => item.type === "tool_call" && item.callId === "shot-1" && item.status === "completed")).toMatchObject({ images: [{ id: "att_1" }] });
        expect(items.find(item => item.type === "assistant_message" && item.text.includes("attachment:att_2"))).toBeTruthy();
        expect(saved).toHaveLength(2);
        expect(completedAfter(events, event => event.type === "timeline" && event.item.type === "assistant_message" && event.item.text.includes("attachment:att_2"))).toBe(true);
    });
    it("drops images silently when no store is configured", async () => {
        const { session, events } = await open(client("acp"));
        await session.startTurn("images");
        await completed(events);
        const call = timeline(events).find(item => item.type === "tool_call" && item.callId === "shot-1" && item.status === "completed");
        expect(call).toBeTruthy();
        expect(call).not.toHaveProperty("images");
    });
});
