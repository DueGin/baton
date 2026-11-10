import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, ToolDetail } from "./Transcript.js";

describe("safe agent content rendering", () => {
  it("escapes HTML while supporting code, lists and emphasis", () => {
    const html = renderToStaticMarkup(<Markdown text={'<img src=x onerror=alert(1)>\n- **bold** and `inline`\n\n```html\n<script>alert(1)</script>\n```'} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<code>inline</code>");
  });
  it("keeps tool commands, diffs and unknown payloads as escaped text", () => {
    const html = renderToStaticMarkup(<ToolDetail detail={{ type: "edit", filePath: "test.ts", unifiedDiff: "+<script>bad()</script>\n-old" }} />);
    expect(html).toContain('class="added"');
    expect(html).toContain('class="removed"');
    expect(html).not.toContain("<script>");
  });
});
