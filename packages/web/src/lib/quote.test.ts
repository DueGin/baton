import { describe, expect, it } from "vitest";
import { quoteMarkdown, selectedBodyText } from "./quote.js";

describe("selectedBodyText", () => {
  it("joins clipped bodies across message metadata and buttons", () => {
    expect(selectedBodyText([
      { text: "开头用户正文结尾", body: 0, start: 2 },
      { text: "思考过程 90 字 ✓", body: null },
      { text: "复制", body: 0, control: true },
      { text: "助手回复后续", body: 1, end: 4 },
    ])).toBe("用户正文结尾\n\n助手回复");
  });
  it("preserves inline text and paragraph breaks within a message", () => {
    expect(selectedBodyText([
      { text: "第一段 ", body: 0 },
      { text: "加粗", body: 0 },
      { text: " 第二段", body: 0, separator: "\n\n" },
      { text: "\n", body: 0, preserveWhitespace: true },
      { text: "\n下一行", body: 0 },
    ])).toBe("第一段 加粗\n\n第二段\n下一行");
  });
  it("skips code chrome, keeps syntax spans together and preserves indentation", () => {
    expect(selectedBodyText([
      { text: "typescript", body: 0, control: true },
      { text: "copy", body: 0, control: true },
      { text: "const", body: 0, preserveWhitespace: true },
      { text: " value = 1;\n    return value;", body: 0, preserveWhitespace: true },
    ])).toBe("const value = 1;\n    return value;");
  });
  it("clips code offsets without losing selected indentation", () => {
    expect(selectedBodyText([
      { text: "前缀    const value = 1;\n", body: 0, start: 2, preserveWhitespace: true },
      { text: "    return value;后缀", body: 0, end: 17, preserveWhitespace: true },
    ])).toBe("    const value = 1;\n    return value;");
  });
  it("retains whitespace between inline nodes and ignores structural whitespace", () => {
    expect(selectedBodyText([
      { text: "one", body: 0 },
      { text: " \n ", body: 0 },
      { text: "two", body: 0 },
      { text: "\n", body: 0, separator: "\n\n" },
      { text: "three", body: 0, separator: "\n\n" },
    ])).toBe("one two\n\nthree");
  });
  it("ignores empty clips, whitespace-only bodies and control-only selections", () => {
    expect(selectedBodyText([
      { text: "正文", body: 0, start: 2, end: 2 },
      { text: "\n \t", body: 1 },
      { text: "思考过程", body: null },
      { text: "复制", body: 2, control: true },
      { text: "  唯一正文  ", body: 3 },
    ])).toBe("唯一正文");
    expect(selectedBodyText([{ text: "复制", body: 0, control: true }, { text: "\n", body: null }])).toBe("");
  });
});

describe("quoteMarkdown", () => {
  it("prefixes each selected line and leaves room to write after the quote", () => {
    expect(quoteMarkdown("第一行\r\n第二行\r\n \t\r\n第三行")).toBe("> 第一行\n> 第二行\n>\n> 第三行\n\n");
  });
  it("trims only outer blank lines, not indentation in the selection", () => {
    expect(quoteMarkdown("\n  \r    return value;\r\t")).toBe(">     return value;\n\n");
  });
  it("does not quote an empty or whitespace-only selection", () => {
    expect(quoteMarkdown("")).toBe("");
    expect(quoteMarkdown(" \n\t\r\n　")).toBe("");
  });
});
