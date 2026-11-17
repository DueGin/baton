import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ATTACHMENT_MAX_BYTES, type AttachmentRecord, type AttachmentRef } from "@baton/protocol";
import { startServer, type BatonServer } from "./api/server.js";
import { imageSize, sniffImage } from "./attachments/index.js";
import { FakeDriver, FakeDriverRegistry, type FakeContext, type FakeDriverOptions } from "./driver/fake.js";
import { attachmentLabel, attachmentPrompt, parseAttachmentMarkers } from "./kernel/images.js";

/** A real 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8); header.write("IHDR", 12, "latin1"); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
  return header;
}
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}
function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(14); bytes.write("GIF89a", 0, "latin1"); bytes.writeUInt16LE(width, 6); bytes.writeUInt16LE(height, 8); bytes[13] = 0x3b; return bytes;
}
function webp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30); bytes.write("RIFF", 0, "latin1"); bytes.writeUInt32LE(22, 4); bytes.write("WEBPVP8X", 8, "latin1"); bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3); return bytes;
}

const servers: BatonServer[] = [], homes: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function temp(prefix: string): Promise<string> { const dir = await mkdtemp(join(tmpdir(), prefix)); homes.push(dir); return dir; }
async function serve(drivers: FakeDriver[] = [new FakeDriver("root", { script: (c) => c.text("Done") })]): Promise<BatonServer> {
  const server = await startServer({ home: await temp("baton-attachments-"), port: 0, registry: new FakeDriverRegistry(drivers), notifier: () => {}, deliveryDebounceMs: 10 });
  servers.push(server); return server;
}
async function upload(server: BatonServer, bytes: Uint8Array, type = "image/png", headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${server.url}/api/attachments`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": type, ...headers }, body: bytes });
}
async function until(test: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!test()) { if (Date.now() > end) throw new Error("Timed out waiting for condition"); await delay(5); }
}
function gate(): { release(): void; wait(c: FakeContext): Promise<void> } {
  let release = (): void => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait: async (c) => {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(c.signal.reason);
      c.signal.addEventListener("abort", abort, { once: true });
      void ready.then(() => { c.signal.removeEventListener("abort", abort); resolve(); });
    });
  } };
}

describe("image headers", () => {
  it("sniffs the four stored types by magic bytes and reads their pixel size", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(imageSize(pngHeader(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(sniffImage(jpeg(300, 200))).toBe("image/jpeg");
    expect(imageSize(jpeg(300, 200), "image/jpeg")).toEqual({ width: 300, height: 200 });
    expect(sniffImage(gif(16, 9))).toBe("image/gif");
    expect(imageSize(gif(16, 9), "image/gif")).toEqual({ width: 16, height: 9 });
    expect(sniffImage(webp(1920, 1080))).toBe("image/webp");
    expect(imageSize(webp(1920, 1080), "image/webp")).toEqual({ width: 1920, height: 1080 });
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(sniffImage(Buffer.from("BM"))).toBeUndefined();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).toBeUndefined();
  });
});

describe("attachment markers", () => {
  const lookup = (id: string) => id === "att_known123" ? { path: "/home/me/.baton/attachments/att_known123.png", mimeType: "image/png", name: "stored.png" } : undefined;
  it("splits text around markers, keeping whitespace and unescaping alt text", () => {
    expect(parseAttachmentMarkers("看这里 ![截图](attachment:att_123) 哪里不对")).toEqual([{ type: "text", text: "看这里 " }, { type: "attachment", id: "att_123", name: "截图" }, { type: "text", text: " 哪里不对" }]);
    expect(parseAttachmentMarkers("![a \\] b](attachment:att_x1)![](attachment:att_x2)")).toEqual([{ type: "attachment", id: "att_x1", name: "a ] b" }, { type: "attachment", id: "att_x2", name: "" }]);
    expect(parseAttachmentMarkers("![web](https://example.com/a.png)")).toEqual([{ type: "text", text: "![web](https://example.com/a.png)" }]);
  });
  it("builds ordered image parts, path notes, or missing notes", () => {
    const text = "before ![shot](attachment:att_known123) after";
    expect(attachmentPrompt("no images here", lookup, true)).toBe("no images here");
    expect(attachmentPrompt(text, lookup, true)).toEqual([{ type: "text", text: "before " }, { type: "image", path: "/home/me/.baton/attachments/att_known123.png", mimeType: "image/png", name: "shot" }, { type: "text", text: " after" }]);
    expect(attachmentPrompt(text, lookup, false)).toBe("before [图片 shot: /home/me/.baton/attachments/att_known123.png] after");
    expect(attachmentPrompt("x ![](attachment:att_known123)", lookup, false)).toBe("x [图片 stored.png: /home/me/.baton/attachments/att_known123.png]");
    expect(attachmentPrompt("x ![gone](attachment:att_missing1) y", lookup, true)).toBe("x [图片 gone: 附件 att_missing1 不存在] y");
    expect(attachmentLabel("fix ![shot](attachment:att_known123) please")).toBe("fix [图片 shot] please");
  });
});

describe("attachment HTTP API", () => {
  it("requires the bearer token on every image route", async () => {
    const server = await serve();
    expect((await fetch(`${server.url}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG })).status).toBe(401);
    expect((await fetch(`${server.url}/api/attachments/att_abcdefgh`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/files/image?path=${encodeURIComponent("/tmp/x.png")}`)).status).toBe(401);
  });

  it("stores an upload under BATON_HOME/attachments, serves it back and dedupes identical bytes", async () => {
    const server = await serve();
    const response = await upload(server, PNG, "image/png", { "x-attachment-name": encodeURIComponent("截图 1.png") });
    expect(response.status).toBe(201);
    const record = await response.json() as AttachmentRecord;
    expect(record).toMatchObject({ id: expect.stringMatching(/^att_[A-Za-z0-9_-]+$/), mimeType: "image/png", name: "截图 1.png", width: 1, height: 1, size: PNG.length, createdAt: expect.any(String) });
    expect((await stat(join(server.home, "attachments", `${record.id}.png`))).size).toBe(PNG.length);
    const got = await fetch(`${server.url}/api/attachments/${record.id}`, { headers: { authorization: `Bearer ${server.token}` } });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);
    const again = await (await upload(server, PNG, "image/png; charset=binary")).json() as AttachmentRecord;
    expect(again.id).toBe(record.id);
    const jpg = await (await upload(server, jpeg(64, 32), "image/jpeg")).json() as AttachmentRecord;
    expect(jpg).toMatchObject({ mimeType: "image/jpeg", width: 64, height: 32 });
    expect(jpg.id).not.toBe(record.id);
  });

  it("rejects other types (415), bytes that do not match the declared type (415), empty (400) and oversized (413) bodies", async () => {
    const server = await serve();
    expect((await upload(server, Buffer.from("hello"), "text/plain")).status).toBe(415);
    expect((await upload(server, Buffer.from("<svg/>"), "image/svg+xml")).status).toBe(415);
    const mismatch = await upload(server, jpeg(4, 4), "image/png");
    expect(mismatch.status).toBe(415);
    expect(await mismatch.json()).toMatchObject({ error: { message: expect.stringContaining("not image/png") } });
    expect((await upload(server, Buffer.from("plain text pretending"), "image/gif")).status).toBe(415);
    expect((await upload(server, Buffer.alloc(0))).status).toBe(400);
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1); PNG.copy(big);
    expect((await upload(server, big)).status).toBe(413);
    // Chunked upload without Content-Length is capped while streaming.
    const chunked = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${server.url}/api/attachments`);
      const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "image/png", "transfer-encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      for (let sent = 0; sent <= ATTACHMENT_MAX_BYTES; sent += 1024 * 1024) req.write(Buffer.alloc(1024 * 1024));
      req.end();
    });
    expect(chunked).toBe(413);
    expect((await (await upload(server, PNG)).json() as AttachmentRecord).mimeType).toBe("image/png");
  }, 20000);

  it("404s unknown, malformed and missing-file attachment ids", async () => {
    const server = await serve();
    const auth = { headers: { authorization: `Bearer ${server.token}` } };
    expect((await fetch(`${server.url}/api/attachments/att_doesnotexist`, auth)).status).toBe(404);
    expect((await fetch(`${server.url}/api/attachments/${encodeURIComponent("../token")}`, auth)).status).toBe(404);
    expect((await fetch(`${server.url}/api/attachments/%E0%A4%A`, auth)).status).toBe(400);
    const record = await (await upload(server, PNG)).json() as AttachmentRecord;
    await rm(join(server.home, "attachments", `${record.id}.png`));
    expect((await fetch(`${server.url}/api/attachments/${record.id}`, auth)).status).toBe(404);
    // Re-uploading the same bytes restores the file under the same id.
    expect((await (await upload(server, PNG)).json() as AttachmentRecord).id).toBe(record.id);
    expect((await fetch(`${server.url}/api/attachments/${record.id}`, auth)).status).toBe(200);
  });

  it("serves local image files by absolute path and never anything else", async () => {
    const server = await serve(), dir = await temp("baton-local-images-");
    const get = (path: string | null) => fetch(`${server.url}/api/files/image${path === null ? "" : `?path=${encodeURIComponent(path)}`}`, { headers: { authorization: `Bearer ${server.token}` } });
    await writeFile(join(dir, "shot.png"), PNG);
    await writeFile(join(dir, "photo.JPG"), jpeg(10, 10));
    await writeFile(join(dir, "fake.png"), "not an image at all");
    await writeFile(join(dir, "secret.txt"), PNG);
    await mkdir(join(dir, "folder.png"));
    await symlink(join(dir, "secret.txt"), join(dir, "link.png"));
    await symlink(join(dir, "shot.png"), join(dir, "alias.webp"));
    const ok = await get(join(dir, "shot.png"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(PNG);
    expect((await get(join(dir, "photo.JPG"))).headers.get("content-type")).toBe("image/jpeg");
    // The served type comes from the bytes, after resolving symlinks.
    expect((await get(join(dir, "alias.webp"))).headers.get("content-type")).toBe("image/png");
    for (const path of [join(dir, "fake.png"), join(dir, "secret.txt"), join(dir, "folder.png"), join(dir, "link.png"), join(dir, "missing.png"), "shot.png", `${dir}/../${dir.split("/").at(-1)}/secret.txt`])
      expect((await get(path)).status, path).toBe(404);
    expect((await get(null)).status).toBe(400);
  });
});

describe("image delivery to agents", () => {
  async function setup(options: FakeDriverOptions = {}) {
    const driver = new FakeDriver("root", { script: (c) => c.text("Done"), ...options });
    const server = await serve([driver]);
    const shot = await (await upload(server, PNG, "image/png", { "x-attachment-name": "shot.png" })).json() as AttachmentRecord;
    const path = join(server.home, "attachments", `${shot.id}.png`);
    const start = async (prompt: string) => {
      const run = await server.kernel.createRun({ projectId: (await server.kernel.projects.create({ path: tmpdir() })).id, agent: "root", cwd: tmpdir(), prompt, policy: { teamApproval: false } });
      return run.run.rootNodeId;
    };
    return { server, driver, shot, path, start, session: () => driver.sessions[0]! };
  }

  it("sends ordered text/image parts to an images-capable agent and keeps the marker text in the transcript", async () => {
    const { server, shot, path, start, session } = await setup();
    const text = `看这里 ![截图](attachment:${shot.id}) 哪里不对`;
    const root = await start(text);
    await until(() => session()?.inputs.length === 1);
    expect(session().inputs[0]).toEqual([{ type: "text", text: "看这里 " }, { type: "image", path, mimeType: "image/png", name: "截图" }, { type: "text", text: " 哪里不对" }]);
    expect(session().prompts[0]).toBe("看这里 [image 截图] 哪里不对");
    expect(server.store.items(root).find((row) => row.item.type === "user_message")?.item).toMatchObject({ text });
    expect(server.store.snapshot(server.store.node(root).runId).run.title).toBe("看这里 [图片 截图] 哪里不对");
  });

  it("sends the absolute path as a text note to agents without image input, and a note for unknown ids", async () => {
    const { shot, path, start, session } = await setup({ images: false });
    await start(`fix ![截图](attachment:${shot.id}) and ![old](attachment:att_gone12345)`);
    await until(() => session()?.inputs.length === 1);
    expect(session().inputs[0]).toBe(`fix [图片 截图: ${path}] and [图片 old: 附件 att_gone12345 不存在]`);
  });

  it("converts markers on steer, queued drain after an edit, and interrupt", async () => {
    const hold = gate();
    const { server, shot, path, start, session } = await setup({ script: async (c) => { if (c.turn === 1) await hold.wait(c); } });
    const root = await start("start");
    await until(() => server.store.node(root).status === "running" && session()?.inputs.length === 1);
    const image = { type: "image", path, mimeType: "image/png", name: "s" };
    expect(await server.kernel.message(root, `steer ![s](attachment:${shot.id})`, undefined, "steer")).toMatchObject({ delivery: "steered" });
    expect(session().steeredInputs[0]).toEqual([{ type: "text", text: "steer " }, image]);
    const queued = await server.kernel.message(root, "plain queued text");
    server.kernel.editMessage(root, queued.itemSeq, `edited ![s](attachment:${shot.id})`);
    expect(await server.kernel.message(root, `now ![s](attachment:${shot.id}) please`, undefined, "interrupt")).toMatchObject({ delivery: "turn" });
    await until(() => session().inputs.length === 2);
    expect(session().inputs[1]).toEqual([{ type: "text", text: "now " }, image, { type: "text", text: " please" }]);
    await until(() => session().inputs.length === 3);
    expect(session().inputs[2]).toEqual([{ type: "text", text: "edited " }, image]);
  });

  it("records images a tool returned as attachment refs on the tool call", async () => {
    let ref: AttachmentRef | undefined;
    const { server, start } = await setup({ script: async (c) => {
      ref = await c.saveImage(`data:image/png;base64,${PNG.toString("base64")}`, "image/png", "screen.png");
      c.item({ type: "tool_call", callId: "shot-1", name: "screenshot", status: "completed", detail: { type: "unknown", input: {}, output: "[image]" }, images: [ref] });
    } });
    const root = await start("take a screenshot");
    await until(() => server.store.items(root).some((row) => row.item.type === "tool_call"));
    const call = server.store.items(root).find((row) => row.item.type === "tool_call")!.item;
    expect(call).toMatchObject({ images: [{ id: ref!.id, mimeType: "image/png", name: "screen.png", width: 1, height: 1 }] });
    const got = await fetch(`${server.url}/api/attachments/${ref!.id}`, { headers: { authorization: `Bearer ${server.token}` } });
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);
    // Agent output is stored by its real type; non-images are refused.
    await expect(server.attachments.saveImage(Buffer.from("nope"), "image/png")).rejects.toThrow("Not a PNG");
    expect((await server.attachments.saveImage(jpeg(8, 8).toString("base64"), "image/png")).mimeType).toBe("image/jpeg");
  });

  it("turns images in an inline ask_human answer into path notes for the agent", async () => {
    let received: unknown;
    const { server, shot, path, start } = await setup({ script: async (c) => { received = await c.call("ask_human", { question: "Which screen?", blocking: true }); } });
    const root = await start("ask me");
    const runId = server.store.node(root).runId;
    await until(() => server.store.snapshot(runId).questions.length === 1);
    await server.kernel.human.answer(server.store.snapshot(runId).questions[0]!.id, `this one ![s](attachment:${shot.id})`);
    await until(() => received !== undefined);
    expect(received).toMatchObject({ status: "answered", answer: `this one [图片 s: ${path}]` });
  });
});
