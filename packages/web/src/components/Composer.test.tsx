import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getSchema } from "@tiptap/core";
import type { AgentEntry, AttachmentRecord } from "@baton/protocol";
import { composerExtensions, EMPHASIS_INPUT, imageIdentity, imageStatus } from "./composer-extensions.js";
import { Composer } from "./Composer.js";
import { Transcript } from "./Transcript.js";
import { docToMarkdown, markdownToDoc, pastedTextDoc } from "../lib/composer-markdown.js";
import { acceptImages, attachmentName, ComposerUploads } from "../lib/composer-uploads.js";
import { DemoClient } from "../demo/client.js";
import { demoAgents } from "../demo/agents.js";
import { RunStore } from "../store.js";
import { createScenario, replay } from "../demo/scenario.js";
import type { BatonClient } from "../api.js";

const schema = getSchema(composerExtensions({ placeholder: () => "", submit: () => undefined }));
const valid = (markdown: string) => { const node = schema.nodeFromJSON(markdownToDoc(markdown)); node.check(); return node; };

describe("composer document", () => {
  it("parses every supported Markdown construct into a document TipTap's schema accepts", () => {
    for (const markdown of ["# 标题", "- a\n  - b\n    1. c", "- [ ] 待办\n  - [x] 嵌套", "> 引用\n> - 列表", "```ts\nx\n```", "| a |\n| - |\n| 1 |", "<div>html</div>", "---", "第一行\n第二行", "[链接](https://x.y) ![图](attachment:att_1) `c` **b** *i* ~~s~~", "[^1]\n\n[^1]: 脚注", ""]) {
      expect(() => valid(markdown), markdown).not.toThrow();
    }
    expect(() => schema.nodeFromJSON(pastedTextDoc("def f():\n    return 1")).check()).not.toThrow();
  });
  it("round-trips the image marker through the editor's own node and serializes uploads by id", () => {
    const markdown = "看这里 ![截图](attachment:att_123) 哪里不对";
    const doc = valid(markdown);
    const image = doc.firstChild!.child(1);
    expect(image.type.name).toBe("composerImage"); expect(image.isAtom && image.isInline).toBe(true); expect(image.attrs).toMatchObject({ src: "attachment:att_123", alt: "截图" });
    expect(docToMarkdown(doc.toJSON())).toBe(markdown);
    expect(imageIdentity(image.attrs)).toBe("src:attachment:att_123"); expect(imageStatus(image.attrs)).toBe("ready");
    expect(imageStatus({ key: "never-uploaded", src: null })).toBe("missing");
  });
  it("turns **bold**, *italic* and ~~strike~~ on as you type, also right after CJK text", () => {
    const typed = (rule: RegExp, text: string) => rule.exec(text)?.[1] ?? null;
    expect(typed(EMPHASIS_INPUT.bold, "请把**结果行**")).toBe("**结果行**");
    expect(typed(EMPHASIS_INPUT.bold, "a **b c**")).toBe("**b c**");
    expect(typed(EMPHASIS_INPUT.bold, "**x **")).toBeNull();
    expect(typed(EMPHASIS_INPUT.italic, "保持*紧凑*")).toBe("*紧凑*");
    expect(typed(EMPHASIS_INPUT.italic, "**结果行*")).toBeNull(); // the first closing star of bold
    expect(typed(EMPHASIS_INPUT.italic, "2 * 3 *")).toBeNull();
    expect(typed(EMPHASIS_INPUT.italic, "\\*字面*")).toBeNull();
    expect(typed(EMPHASIS_INPUT.strike, "去掉~~旧样式~~")).toBe("~~旧样式~~");
  });
});

describe("composer images", () => {
  afterEach(() => vi.useRealTimers());
  const png = (size = 10) => new File([new Uint8Array(size)], "image.png", { type: "image/png" });
  it("takes no images for an agent without image support and says why", () => {
    expect(acceptImages([png()], false)).toEqual({ accepted: [], hint: "当前 agent 不支持图片" });
    expect(acceptImages([], false)).toEqual({ accepted: [], hint: null });
    const svg = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
    const result = acceptImages([png(), svg], true); expect(result.accepted).toHaveLength(1); expect(result.hint).toContain("仅支持");
  });
  it("names clipboard screenshots and keeps real file names", () => {
    expect(attachmentName(png())).toBe("截图.png");
    expect(attachmentName(new File([""], "设计稿.webp", { type: "image/webp" }))).toBe("设计稿.webp");
    expect(attachmentName(new Blob([""], { type: "image/jpeg" }))).toBe("截图.jpg");
  });
  it("tracks an upload from in-flight to an attachment id, and retries failures", async () => {
    let fail = true;
    const uploadAttachment = vi.fn(async (file: Blob, name: string): Promise<AttachmentRecord> => { if (fail) throw new Error("offline"); return { id: "att_7", mimeType: file.type, name, size: file.size, createdAt: "2026-11-18T00:00:00Z" }; });
    const client = { uploadAttachment } as unknown as BatonClient;
    const uploads = new ComposerUploads(); const changes = vi.fn(); uploads.subscribe(changes);
    const key = uploads.start(client, png(), "截图.png");
    expect(uploads.get(key)?.status).toBe("uploading"); expect(uploads.src({ key, src: null })).toBeNull();
    await vi.waitFor(() => expect(uploads.get(key)?.status).toBe("failed")); expect(uploads.get(key)?.error).toBe("offline");
    fail = false; uploads.retry(client, key);
    await vi.waitFor(() => expect(uploads.get(key)?.status).toBe("ready"));
    expect(uploads.src({ key, src: null })).toBe("attachment:att_7"); expect(uploadAttachment).toHaveBeenLastCalledWith(expect.any(Blob), "截图.png"); expect(changes.mock.calls.length).toBeGreaterThanOrEqual(4);
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "看 " }, { type: "composerImage", attrs: { key, src: null, alt: "截图.png" } }] }] };
    expect(docToMarkdown(doc, { imageSrc: attrs => uploads.src(attrs) })).toBe("看 ![截图.png](attachment:att_7)");
  });
});

describe("composer rendering", () => {
  const now = Date.parse("2026-11-10T07:00:00Z");
  it("keeps the 消息 label and placeholder on the editable element before the editor mounts", () => {
    const html = renderToStaticMarkup(<Composer nodeId="n1" client={new DemoClient(() => now)} placeholder="向 claude 发送消息…" disabled imagesEnabled onSend={() => undefined} onStatus={() => undefined} />);
    expect(html).toContain('aria-label="消息"'); expect(html).toContain('role="textbox"'); expect(html).toContain('aria-multiline="true"');
    expect(html).toContain('data-placeholder="向 claude 发送消息…"'); expect(html).toContain('aria-disabled="true"'); expect(html).toContain("is-disabled");
  });
  it("offers the image button only when the node's agent accepts images", () => {
    const store = new RunStore(new DemoClient(() => now)); const live = replay(createScenario(0), 30000);
    const render = (agentId: string, agents: AgentEntry[] = demoAgents) => { const node = live.nodes.find(entry => entry.agentId === agentId)!; return renderToStaticMarkup(<Transcript agents={agents} snapshot={live} store={store} items={{ [node.id]: [] }} itemStatus={{ [node.id]: "ready" }} nodeId={node.id} setNodeId={() => undefined} now={now} inspect={() => undefined} answer={() => undefined} busy={false} stopRun={() => undefined} />); };
    const attach = (html: string) => /<button[^>]*composer-attach[^>]*>/.exec(html)?.[0] ?? "";
    expect(attach(render("claude"))).not.toContain("disabled"); expect(attach(render("claude"))).toContain('aria-label="添加图片"');
    expect(attach(render("pi"))).toContain('disabled=""'); expect(attach(render("pi"))).toContain('title="当前 agent 不支持图片"');
    expect(attach(render("claude", []))).toContain('disabled=""'); // unknown agent: no images
    const html = render("claude"); const form = html.slice(html.indexOf('class="composer"'));
    expect(form).toContain('aria-label="消息"'); expect(form).toContain('accept="image/png,image/jpeg,image/gif,image/webp"'); expect(form).toContain("composer-stop");
  });
});
