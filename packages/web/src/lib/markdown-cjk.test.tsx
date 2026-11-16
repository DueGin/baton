import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fixBareUrls } from "./markdown.js";
import { Markdown } from "../components/Markdown.js";

const html = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

describe("CJK-friendly markdown", () => {
  it("ends bare URLs before emphasis markers and CJK punctuation", () => {
    expect(fixBareUrls("可以试 **http://127.0.0.1:25173/create**。")).toBe("可以试 **<http://127.0.0.1:25173/create>**。");
    expect(fixBareUrls("打开 http://localhost:5173/a，就行")).toBe("打开 <http://localhost:5173/a>，就行");
    expect(fixBareUrls("见 http://x.dev/path_with_underscore 吧")).toBe("见 http://x.dev/path_with_underscore 吧");
    expect(fixBareUrls("[链接](http://x.dev/a)。")).toBe("[链接](http://x.dev/a)。");
    expect(fixBareUrls("`http://x.dev/a**。`")).toBe("`http://x.dev/a**。`");
    expect(fixBareUrls("```\nhttp://x.dev/a**。\n```")).toBe("```\nhttp://x.dev/a**。\n```");
  });
  it("renders the reported case as bold link text without stray asterisks", () => {
    const out = html("如果打不开，可以试 **http://127.0.0.1:25173/create**。");
    expect(out).toContain('<strong><a href="http://127.0.0.1:25173/create"');
    expect(out).not.toContain("**");
    expect(out).toContain("</strong>。");
  });
  it("bolds CJK text whose closing marker follows fullwidth punctuation", () => {
    const out = html("这是**（重点）**内容，还有**“引用”**后文。");
    expect(out).toContain("<strong>（重点）</strong>");
    expect(out).toContain("<strong>“引用”</strong>");
    expect(out).not.toContain("**");
  });
  it("treats single newlines as line breaks and renders <br> tags, but no other raw HTML", () => {
    expect(html("第一行\n第二行")).toContain("第一行<br/>");
    const table = html("| 项 | 说明 |\n|---|---|\n| a | 一<br>二 |");
    expect(table).toMatch(/一<br\/>\s*二/);
    expect(html("<b>x</b><script>alert(1)</script>")).not.toContain("<script>");
    expect(html("<b>x</b>")).not.toContain("<b>");
  });
});
