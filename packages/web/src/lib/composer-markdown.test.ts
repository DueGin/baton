import { describe, expect, it } from "vitest";
import { docIsEmpty, docToMarkdown, escapeText, IMAGE_NODE, markdownToDoc, pastedTextDoc, pasteKind, RAW_NODE, textareaSuggestion } from "./composer-markdown.js";

const roundTrip = (markdown: string) => docToMarkdown(markdownToDoc(markdown));
const paragraph = (...content: object[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
const text = (value: string, ...marks: string[]) => ({ type: "text", text: value, ...(marks.length ? { marks: marks.map(type => ({ type })) } : {}) });

describe("composer markdown", () => {
  it("round-trips the Markdown the composer renders live", () => {
    for (const markdown of [
      "# 标题\n\n正文 **粗体** *斜体* `code` ~~删除~~",
      "## 二级标题",
      "- 一\n- 二\n  - 嵌套\n- 三",
      "3. 第三\n4. 第四",
      "- [ ] 待办\n- [x] 已完成",
      "> 引用\n>\n> 第二段",
      "```ts\nconst a = `x`;\n```",
      "第一行\n第二行",
      "[文档](https://example.com/docs) 与 https://example.com/raw",
      "这是**粗体**。然后*斜体*，再来~~删除~~！",
      "---",
    ]) expect(roundTrip(markdown)).toBe(markdown);
  });
  it("sends literal text as typed instead of escaping or entity-encoding it", () => {
    const literal = "fix my_module_name.py if a < b && c > d, glob src/**/*.ts, C:\\Users\\me, 1+1=2";
    expect(docToMarkdown(paragraph(text(literal)))).toBe(literal);
    expect(docToMarkdown(paragraph(text("snake_case_name 和 2 * 3 * 4")))).toBe("snake_case_name 和 2 * 3 * 4");
  });
  it("keeps slash commands and file mentions as plain text", () => {
    for (const example of ["/review src/a_b.ts", "@packages/web/src/App.tsx", '@"a b.txt"']) {
      expect(roundTrip(example)).toBe(example);
      expect(docToMarkdown(paragraph(text(example)))).toBe(example);
    }
    expect(docToMarkdown(paragraph(text("/prompts:fix ")))).toBe("/prompts:fix");
    expect(docToMarkdown(paragraph(text("/review src/a_b.ts ")))).toBe("/review src/a_b.ts");
    expect(docToMarkdown(paragraph(text('@"a b_file.txt" ')))).toBe('@"a b_file.txt"');
  });
  it("skips file suggestions inside Markdown code in the new-run task field", () => {
    for (const prefix of ["```text\n@src", "~~~\n@src", "    @src"]) expect(textareaSuggestion(prefix, prefix.length)).toBeNull();
    const text = "`example @src`\n@README";
    expect(textareaSuggestion(text, text.indexOf("`", 1))).toBeNull();
    expect(textareaSuggestion(text, text.length)?.query).toBe("README");
  });
  it("escapes only when the plain text would otherwise change meaning", () => {
    expect(docToMarkdown(paragraph(text("*不是斜体*")))).toBe("\\*不是斜体\\*");
    expect(docToMarkdown(paragraph(text("1. 不是列表")))).toBe("1\\. 不是列表");
    expect(docToMarkdown(paragraph(text("# 不是标题")))).toBe("\\# 不是标题");
    expect(docToMarkdown(paragraph(text("[x](y) 不是链接")))).toBe("\\[x\\](y) 不是链接");
    expect(docToMarkdown(paragraph(text("a"), { type: "hardBreak" }, text("- b")))).toBe("a\n\\- b");
    expect(markdownToDoc(docToMarkdown(paragraph(text("<kbd> & `tick`"))))).toEqual(paragraph(text("<kbd> & `tick`")));
    expect(escapeText("x_y [z] <b> &amp;", false)).toBe("x\\_y \\[z\\] \\<b> \\&amp;");
  });
  it("keeps emphasis valid by moving whitespace outside delimiters and closing marks at line breaks", () => {
    expect(docToMarkdown(paragraph(text("粗体 ", "bold"), text("之后")))).toBe("**粗体** 之后");
    expect(docToMarkdown(paragraph(text(" 前导", "italic")))).toBe("*前导*");
    expect(docToMarkdown(paragraph(text("a", "bold"), { type: "hardBreak" }, text("b", "bold")))).toBe("**a**\n**b**");
    expect(docToMarkdown(paragraph(text("both", "bold", "italic"), text(" bold", "bold")))).toBe("***both* bold**");
    expect(docToMarkdown(paragraph(text("a`b", "code")))).toBe("``a`b``");
    expect(docToMarkdown(paragraph(text("`x`", "code")))).toBe("`` `x` ``");
  });
  it("turns attachment markers into inline image nodes and back, in place", () => {
    const markdown = "看这里 ![截图](attachment:att_123) 哪里不对";
    const doc = markdownToDoc(markdown);
    expect(doc.content?.[0]?.content).toEqual([text("看这里 "), { type: IMAGE_NODE, attrs: { src: "attachment:att_123", alt: "截图", key: null } }, text(" 哪里不对")]);
    expect(docToMarkdown(doc)).toBe(markdown);
    expect(roundTrip("![a [b]](attachment:att_1)")).toBe("![a \\[b\\]](attachment:att_1)");
  });
  it("writes uploads once they have an attachment id and drops ones still in flight", () => {
    const doc = paragraph(text("前 "), { type: IMAGE_NODE, attrs: { src: null, key: "up-1", alt: "shot.png" } }, text(" 中 "), { type: IMAGE_NODE, attrs: { src: null, key: "up-2", alt: "b.png" } }, text(" 后"));
    const ids: Record<string, string> = { "up-1": "att_9" };
    expect(docToMarkdown(doc, { imageSrc: attrs => typeof attrs.key === "string" && ids[attrs.key] ? `attachment:${ids[attrs.key]}` : null })).toBe("前 ![shot.png](attachment:att_9) 中  后");
  });
  it("keeps Markdown the editor cannot show as verbatim raw blocks", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const doc = markdownToDoc(`前\n\n${table}\n\n后`);
    expect(doc.content?.map(block => block.type)).toEqual(["paragraph", RAW_NODE, "paragraph"]);
    expect(docToMarkdown(doc)).toBe(`前\n\n${table}\n\n后`);
    expect(docToMarkdown(paragraph(text("| a | b |"), { type: "hardBreak" }, text("| - | - |")))).toBe("| a | b |\n| - | - |");
  });
  it("separates paragraphs with a blank line, skips empty ones and trims the edges", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [text("一")] }, { type: "paragraph" }, { type: "paragraph", content: [text("二"), { type: "hardBreak" }] }, { type: "paragraph" }] };
    expect(docToMarkdown(doc)).toBe("一\n\n二");
  });
  it("uses a fence longer than any backtick run in a code block", () => {
    const doc = { type: "doc", content: [{ type: "codeBlock", attrs: { language: "md" }, content: [text("```js\nx\n```")] }] };
    expect(docToMarkdown(doc)).toBe("````md\n```js\nx\n```\n````");
    expect(markdownToDoc(docToMarkdown(doc))).toEqual(doc);
  });
  it("knows an empty draft from one with text or an image", () => {
    expect(docIsEmpty(markdownToDoc(""))).toBe(true);
    expect(docIsEmpty({ type: "doc", content: [{ type: "paragraph", content: [text("  ")] }, { type: "paragraph" }] })).toBe(true);
    expect(docIsEmpty(paragraph(text("x")))).toBe(false);
    expect(docIsEmpty(paragraph({ type: IMAGE_NODE, attrs: { key: "k" } }))).toBe(false);
  });
});

describe("pasted text", () => {
  it("reads Markdown as formatted content and keeps code and plain text literal", () => {
    expect(pasteKind("# 计划\n\n- 一\n- 二")).toBe("markdown");
    expect(pasteKind("请看 **重点** 和 `config.ts`")).toBe("markdown");
    expect(pasteKind("- a\n  - nested")).toBe("markdown");
    expect(pasteKind("```py\nprint(1)\n```")).toBe("markdown");
    expect(pasteKind("| a | b |\n| - | - |")).toBe("markdown");
    expect(pasteKind("def __init__(self):\n    # comment\n    return 1")).toBe("code");
    expect(pasteKind("Error: boom\n    at foo (a.js:1:2)\n    at bar (b.js:3:4)")).toBe("code");
    expect(pasteKind("def __init__(self): pass")).toBe("text");
    expect(pasteKind("2 * 3 * 4 和 a_b_c")).toBe("text");
    expect(pasteKind("第一行\n第二行")).toBe("text");
  });
  it("builds paragraphs with line breaks, code blocks or parsed Markdown", () => {
    expect(pastedTextDoc("一\n二\n\n三")).toEqual({ type: "doc", content: [{ type: "paragraph", content: [text("一"), { type: "hardBreak" }, text("二")] }, { type: "paragraph", content: [text("三")] }] });
    expect(pastedTextDoc("# 不是标题", { plain: true })).toEqual(paragraph(text("# 不是标题")));
    expect(pastedTextDoc("const a = 1;\nconst b = 2;\n", { language: "typescript" })).toEqual({ type: "doc", content: [{ type: "codeBlock", attrs: { language: "typescript" }, content: [text("const a = 1;\nconst b = 2;")] }] });
    expect(pastedTextDoc("const a = 1;", { language: "typescript" })).toEqual(paragraph(text("const a = 1;")));
    expect(pastedTextDoc("# 标题", { language: "markdown" }).content?.[0]?.type).toBe("heading");
    expect(pastedTextDoc("  indented\n  log").content?.[0]?.type).toBe("codeBlock");
    expect(docToMarkdown(pastedTextDoc("a_b *c* [d]", { plain: true }))).toBe("a_b \\*c\\* [d]");
  });
});
