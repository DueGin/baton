import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, ToolDetail, TranscriptRow } from "./Transcript.js";
import { createScenario, replay } from "../demo/scenario.js";
import { demoBriefPrompt, demoResultsPrompt } from "../demo/prompts.js";

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
  it("renders baton assignments/results as linked cards and falls back to escaped text", () => {
    const snapshot = replay(createScenario(0), 86000);
    const edge = snapshot.delegations.find(delegation => delegation.result?.status === "success")!;
    const node = snapshot.nodes[0]!;
    const render = (text: string) => renderToStaticMarkup(<TranscriptRow row={{ seq: 1, nodeId: node.id, ts: snapshot.run.createdAt, item: { type: "user_message", text } }} node={node} snapshot={snapshot} inspect={() => undefined} />);
    const assignment = render(demoBriefPrompt(edge));
    expect(assignment).toContain("任务书");
    expect(assignment).toContain('title="查看委派节点"');
    expect(assignment).not.toContain("baton-assignment");
    const delivered = render(demoResultsPrompt([{ ...edge, brief: { ...edge.brief, title: '<script>alert("x")</script>' }, result: { ...edge.result!, summary: '<img src=x onerror="bad()">' } }]));
    expect(delivered).toContain("结果送达");
    expect(delivered).toContain("✓ 完成");
    expect(delivered).toContain("Result JSON");
    expect(delivered).toContain("Artifacts");
    expect(delivered).toContain('title="查看子节点"');
    expect(delivered).not.toContain("<script");
    expect(delivered).not.toContain("<img");
    const malformed = render('<baton-assignment delegation="x">broken <img src=x></baton-assignment>');
    expect(malformed).toContain("&lt;baton-assignment");
    expect(malformed).not.toContain("protocol-card");
  });
});
