import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../components/Markdown.js";
import { codeFences, diagramReady, safeLink } from "./markdown.js";

describe("Markdown safety and GFM", () => {
  it("escapes HTML, drops executable/relative links and preserves only allowed schemes", () => {
    const html = renderToStaticMarkup(<Markdown text={'<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) [relative](/private) [good](https://example.com) [mail](mailto:dev@example.com)\n\n<img src=x onerror=alert(1)>'} />);
    expect(html).not.toContain("<script"); expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('href="/private');
    expect(html).toContain('href="https://example.com"'); expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"'); expect(html).toContain('href="mailto:dev@example.com"');
    expect(safeLink("data:text/html,x")).toBeUndefined(); expect(safeLink(" java\nscript:x")).toBeUndefined();
  });
  it("renders tables, tasks, strikeout, nested lists, blockquotes, highlighted languages and partial fences", () => {
    const text = '# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n  - child\n\n> quote\n\n~~old~~ https://example.com\n\n```typescript\nconst ready = true;\n```\n\n```python\nprint("partial")';
    const html = renderToStaticMarkup(<Markdown text={text} />);
    for (const tag of ["<h1>", "<table>", 'type="checkbox"', "<del>", "<blockquote>", "language-typescript", "language-python", "hljs-keyword", "复制源码"]) expect(html).toContain(tag);
    expect(html.match(/<ul/g)!.length).toBeGreaterThanOrEqual(2);
  });
});
describe("Mermaid fences and stability", () => {
  it("detects closed and unclosed fences including tilde/long fences", () => {
    const blocks = codeFences('```mermaid\nflowchart TD\n A-->B\n```\n\n~~~~mermaid\nsequenceDiagram\n A->>B: Hi\n~~~~\n\n```mermaid\nflowchart TD\n A-->');
    expect(blocks.map(block => [block.language, block.complete])).toEqual([["mermaid", true], ["mermaid", true], ["mermaid", false]]);
    expect(blocks[0]!.code).toBe("flowchart TD\n A-->B");
    expect(diagramReady(true, 499)).toBe(false); expect(diagramReady(false, 5000)).toBe(false); expect(diagramReady(true, 500)).toBe(true);
  });
  it("leaves Mermaid source visible until a complete message is stable", () => {
    const html = renderToStaticMarkup(<Markdown text={'```mermaid\nflowchart TD\n A-->B\n```'} />);
    expect(html).toContain("图表生成中"); expect(html).toContain("A--&gt;B"); expect(html).not.toContain("<svg");
  });
});

const mermaidMock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}"><text>主导者 → 审查</text><script>bad()</script><path onload="bad()" /></svg>` })) }));
vi.mock("mermaid", () => ({ default: mermaidMock }));
vi.mock("dompurify", () => ({ default: { sanitize: vi.fn((svg: string) => svg.replace(/<script>.*?<\/script>/g, "").replace(/ onload="[^"]*"/g, "")) } }));
describe("lazy Mermaid rendering", () => {
  it("uses strict themed initialization, unique ids, sanitized output and a code/theme cache", async () => {
    const { renderDiagram, renderReadyDiagram, namespaceSvg } = await import("./mermaid.js");
    expect(renderReadyDiagram("incomplete", "light", false, 1000)).toBeNull();
    expect(renderReadyDiagram("unstable", "light", true, 499)).toBeNull();
    expect(mermaidMock.render).not.toHaveBeenCalled();
    const namespaced = namespaceSvg('<svg id="a"><style>#a .x {fill:url(#clip)}</style><defs id="clip"/><g aria-labelledby="a" fill="url(#clip)"/></svg>', "instance");
    expect(namespaced).toContain('id="instance-a"'); expect(namespaced).toContain("url(#instance-clip)"); expect(namespaced).toContain('aria-labelledby="instance-a"');
    const light = await renderDiagram("flowchart TD; A-->B", "light");
    expect(light).toContain("<svg"); expect(light).not.toContain("script"); expect(light).not.toContain("onload"); expect(light).toContain("<text>主导者 → 审查</text>");
    expect(await renderDiagram("flowchart TD; A-->B", "light")).toBe(light);
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    const dark = await renderDiagram("flowchart TD; A-->B", "dark");
    expect(dark).not.toBe(light);
    expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", startOnLoad: false, theme: "dark", htmlLabels: false, flowchart: { htmlLabels: false }, class: { htmlLabels: false } }));
    for (const [config] of mermaidMock.initialize.mock.calls) expect(config).toMatchObject({ htmlLabels: false, flowchart: { htmlLabels: false }, class: { htmlLabels: false } });
    expect(mermaidMock.render.mock.calls[0]![0]).not.toBe(mermaidMock.render.mock.calls[1]![0]);
  });
});
