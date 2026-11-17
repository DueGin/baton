import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineMarkdown, Markdown } from "./Markdown.js";
import { TranscriptRow } from "./Transcript.js";
import { ImageContext } from "../lib/images.js";
import { DemoClient } from "../demo/client.js";
import { createScenario, replay } from "../demo/scenario.js";

const client = new DemoClient(() => Date.parse("2026-11-10T07:00:00Z"));
const render = (text: string, cwd?: string) => renderToStaticMarkup(<ImageContext value={{ client, cwd }}><Markdown text={text} /></ImageContext>);

describe("images in Markdown", () => {
  it("renders http(s) and data images as lazy, referrer-less thumbnails that open a lightbox", () => {
    const html = render("看 ![远程图](https://example.com/a.png) 和 ![内联](data:image/png;base64,iVBORw0KGgo=)");
    expect(html).toContain('src="https://example.com/a.png"'); expect(html).toContain('referrerPolicy="no-referrer"'); expect(html).toContain('loading="lazy"');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="'); expect(html).toContain('aria-label="查看图片：远程图"');
  });
  it("fetches attachments and local files with auth, reserving space while they load", () => {
    const html = render("![截图](attachment:att_1) ![本地](/Users/me/a.png) ![相对](docs/b.png)", "/workspace/notes");
    expect(html.match(/image-thumb is-loading/g)).toHaveLength(3); expect(html).not.toContain("<img");
    expect(html).toContain('aria-label="截图（加载中）"');
  });
  it("falls back to the old link or alt text for anything it will not load", () => {
    const html = render("![坏](javascript:alert(1)) ![矢量](https://example.com/a.svg) ![svg](data:image/svg+xml;base64,PHN2Zz4=) ![相对](docs/b.png)");
    expect(html).not.toContain("javascript:"); expect(html).not.toContain("data:image/svg"); expect(html).toContain(">坏</span>");
    expect(html).toContain('src="https://example.com/a.svg"'); // http(s) is loaded as an image whatever its extension
    expect(html).toContain(">相对</span>"); // no cwd → no guess
    const noClient = renderToStaticMarkup(<Markdown text="![截图](attachment:att_1)" />); expect(noClient).toContain(">截图</span>"); expect(noClient).not.toContain("<img");
  });
  it("never turns raw HTML into an image", () => {
    const html = render('<img src="https://example.com/x.png" onerror="alert(1)">\n\n<p><img src=x></p> `![code](https://example.com/c.png)`');
    expect(html).not.toContain("<img"); expect(html).toContain("&lt;img"); expect(html).not.toContain("onerror=\"");
  });
  it("keeps inline Markdown (option buttons) free of images and links", () => {
    const html = renderToStaticMarkup(<InlineMarkdown text="选 ![图](https://example.com/a.png) 或 [链接](https://example.com) **粗**" />);
    expect(html).not.toContain("<img"); expect(html).not.toContain("<a "); expect(html).not.toContain("<button"); expect(html).toContain("<strong>粗</strong>");
  });
  it("shows images a tool returned under its row, even when the row is collapsed", () => {
    const snapshot = replay(createScenario(0), 86000); const node = snapshot.nodes[0]!;
    const html = renderToStaticMarkup(<TranscriptRow row={{ seq: 3, nodeId: node.id, ts: node.createdAt, item: { type: "tool_call", callId: "shot", name: "screenshot", status: "completed", detail: { type: "unknown", input: {}, output: null }, images: [{ id: "att_shot", mimeType: "image/png", name: "shot.png", width: 960, height: 600 }] } }} node={node} />);
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf('class="tool-images"')); expect(html).toContain("shot.png");
  });
});
