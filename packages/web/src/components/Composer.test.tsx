import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
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
import { SuggestionSession } from "../lib/composer-suggest.js";
import { composerKeyDown, editorSuggestion } from "../lib/composer-suggest-editor.js";

const schema = getSchema(composerExtensions({ placeholder: () => "" }));
const valid = (markdown: string) => { const node = schema.nodeFromJSON(markdownToDoc(markdown)); node.check(); return node; };

describe("composer completion", () => {
  afterEach(() => vi.useRealTimers());
  const now = () => Date.parse("2026-11-10T07:00:00Z");
  const mountState = (client: BatonClient, nodeId: string) => {
    const session = new SuggestionSession();
    const source = { client, cwd: "/workspace/atlas", commandQuery: { nodeId } };
    const submit = vi.fn();
    const view = { state: EditorState.create({ schema }), composing: false, dispatch(transaction: Transaction) {
      view.state = view.state.apply(transaction);
      session.update(view.composing ? null : editorSuggestion(view.state), source);
    } };
    const type = (text: string) => { for (const character of text) view.dispatch(view.state.tr.insertText(character)); };
    const key = (key: string) => composerKeyDown(view, { key, keyCode: 0, isComposing: view.composing, ctrlKey: false, metaKey: false,
      altKey: false, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() }, session, false, "enter", submit);
    return { session, view, submit, type, key };
  };

  it("filters /re, selects the active option and accepts on Enter without submitting", async () => {
    const client = new DemoClient(now);
    const commands = vi.spyOn(client, "commands").mockResolvedValue({ source: "session", commands: [{ name: "review" }, { name: "init" }] });
    const { session, view, submit, type, key } = mountState(client, "command-completion-test");
    type("/re");
    await vi.waitFor(() => expect(session.snapshot()?.options.map(option => option.label)).toEqual(["/review"]));
    expect(commands).toHaveBeenCalledExactlyOnceWith({ nodeId: "command-completion-test" });
    expect(key("Enter")).toBe(true);
    expect(view.state.doc.textContent).toBe("/review ");
    expect(submit).not.toHaveBeenCalled();
    expect(session.snapshot()).toBeNull();
  });

  it("debounces @, drills into a directory, and quotes a filename with spaces", async () => {
    vi.useFakeTimers();
    const client = new DemoClient(now);
    const cwd = "/workspace/atlas";
    const search = vi.spyOn(client, "searchFiles").mockImplementation(async (_cwd, query) => ({ cwd, truncated: false,
      files: query === "docs/" ? [{ path: "docs/a b.txt", kind: "file" }] : [{ path: "docs/", kind: "dir" }] }));
    const { session, view, submit, type, key } = mountState(client, "file-completion-test");
    type("读 @doc");
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120);
    expect(search).toHaveBeenCalledExactlyOnceWith(cwd, "doc");
    expect(key("Tab")).toBe(true);
    expect(view.state.doc.textContent).toBe("读 @docs/");
    await vi.advanceTimersByTimeAsync(120);
    expect(search).toHaveBeenLastCalledWith(cwd, "docs/");
    expect(session.snapshot()?.options[0]?.label).toBe("docs/a b.txt");
    expect(key("Enter")).toBe(true);
    expect(view.state.doc.textContent).toBe('读 @"docs/a b.txt" ');
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects code and allows a file trigger after a hard break", () => {
    for (const [markdown, expected] of [["```ts\n@src\n```", null], ["`@src`", null], ["x\n/re", null], ["x\n@src", "src"]] as const) {
      const doc = valid(markdown);
      const selection = TextSelection.atEnd(doc);
      expect(editorSuggestion(EditorState.create({ doc, selection }))?.query ?? null).toBe(expected);
    }
  });

  it("leaves composing Enter alone and suppresses Enter while the list is empty or loading", () => {
    const client = new DemoClient(now);
    const { view, submit, type, key, session } = mountState(client, "composition-test");
    type("@missing");
    view.composing = true;
    expect(key("Enter")).toBe(false);
    view.composing = false;
    expect(key("Enter")).toBe(true);
    expect(key("Escape")).toBe(true);
    expect(session.snapshot()).toBeNull();
    expect(view.state.doc.textContent).toBe("@missing");
    expect(submit).not.toHaveBeenCalled();
  });
});

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
    const html = renderToStaticMarkup(<Composer nodeId="n1" cwd="/workspace/atlas" client={new DemoClient(() => now)} placeholder="向 claude 发送消息…" disabled imagesEnabled onSend={() => undefined} onStatus={() => undefined} />);
    expect(html).toContain('aria-label="消息"'); expect(html).toContain('role="textbox"'); expect(html).toContain('aria-multiline="true"');
    expect(html).toContain('data-placeholder="向 claude 发送消息…"'); expect(html).toContain('aria-disabled="true"'); expect(html).toContain("is-disabled");
  });
  it("offers the image button only when the node's agent accepts images", () => {
    const store = new RunStore(new DemoClient(() => now)); const live = replay(createScenario(0), 30000);
    const render = (agentId: string, agents: AgentEntry[] = demoAgents) => { const node = live.nodes.find(entry => entry.agentId === agentId)!; return renderToStaticMarkup(<Transcript showTopology={() => undefined} agents={agents} snapshot={live} store={store} items={{ [node.id]: [] }} itemStatus={{ [node.id]: "ready" }} nodeId={node.id} setNodeId={() => undefined} now={now} inspect={() => undefined} answer={() => undefined} busy={false} stopRun={() => undefined} />); };
    const attach = (html: string) => /<button[^>]*composer-attach[^>]*>/.exec(html)?.[0] ?? "";
    expect(attach(render("claude"))).not.toContain("disabled"); expect(attach(render("claude"))).toContain('aria-label="添加图片"');
    expect(attach(render("pi"))).toContain('disabled=""'); expect(attach(render("pi"))).toContain('title="当前 agent 不支持图片"');
    expect(attach(render("claude", []))).toContain('disabled=""'); // unknown agent: no images
    const html = render("claude"); const form = html.slice(html.indexOf('class="composer"'));
    expect(form).toContain('aria-label="消息"'); expect(form).toContain('accept="image/png,image/jpeg,image/gif,image/webp"');
  });
});
