import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, ToolDetail, TranscriptRow } from "./Transcript.js";
import { createScenario, replay } from "../demo/scenario.js";
import { demoBriefPrompt, demoResultsPrompt } from "../demo/prompts.js";
import { reasoningBlockId, reasoningPreferences } from "../lib/reasoning.js";
import type { TimelineItem } from "@baton/protocol";
import type { MessageActionState } from "../lib/conversation.js";

describe("safe agent content rendering", () => {
  it("keeps queued/retracted rows out of the transcript and places icon actions on steered messages", () => {
    const snapshot = replay(createScenario(0), 86000); const node = snapshot.nodes[0]!;
    const render = (delivery: Extract<TimelineItem, { type: "user_message" }>["delivery"], actionState?: MessageActionState, interrupted = false) => renderToStaticMarkup(<TranscriptRow row={{ seq: 12, nodeId: node.id, ts: snapshot.run.createdAt, item: { type: "user_message", text: "请先验证", delivery, interrupted } }} node={node} actionState={actionState} act={() => undefined} />);
    expect(render("queued")).toBe(""); expect(render("retracted")).toBe("");
    const steered = render("steered"); expect(steered).toContain('aria-label="已插入当前回合"'); expect(steered).toContain('aria-label="立即发送"'); expect(steered).not.toContain(">立即发送<"); expect(steered).not.toContain("message-actions");
    const busy = render("steered", { pending: "interrupt" }); expect(busy).toContain('aria-busy="true"'); expect(busy).toContain('disabled=""');
    const instant = render("turn", undefined, true); expect(instant).toContain('aria-label="已中断并立即发送"'); expect(instant).not.toContain("message-action-interrupt");
    expect(render("steered", { error: "网络错误，请重试" })).toContain('role="alert"');
  });
  it("escapes HTML while supporting code, lists and emphasis", () => {
    const html = renderToStaticMarkup(<Markdown text={'<img src=x onerror=alert(1)>\n\n- **bold** and `inline`\n\n```html\n<script>alert(1)</script>\n```'} />);
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
    const pending = renderToStaticMarkup(<ToolDetail detail={{ type: "baton", tool: "delegate", output: { status: "pending_approval", proposalId: "p1" } }} />);
    expect(pending).toContain("pending_approval");
    expect(pending).toContain("p1");
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
    expect(assignment).toContain(edge.role!);
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
    const notice = render('<baton-notice>任务已改派 <img src=x onerror="bad()"></baton-notice>');
    expect(notice).toContain("团队通知"); expect(notice).toContain("baton-notice-card"); expect(notice).not.toContain("<img");
  });
  it("defaults live reasoning to collapsed, follows the selected preference and shows streaming reply carets", () => {
    const snapshot = replay(createScenario(0), 86000); const node = snapshot.nodes[0]!;
    const row = { seq: 1, nodeId: node.id, ts: snapshot.run.createdAt, item: { type: "reasoning" as const, text: "Thinking **live**" } };
    expect(renderToStaticMarkup(<TranscriptRow row={row} node={node} streaming />)).not.toContain('open=""');
    expect(renderToStaticMarkup(<TranscriptRow row={row} node={node} />)).not.toContain('open=""');
    reasoningPreferences.setPreference("streaming");
    expect(renderToStaticMarkup(<TranscriptRow row={row} node={node} streaming />)).toContain('open=""');
    expect(renderToStaticMarkup(<TranscriptRow row={row} node={node} />)).not.toContain('open=""');
    reasoningPreferences.setPreference("expanded");
    expect(renderToStaticMarkup(<TranscriptRow row={row} node={node} />)).toContain('open=""');
    reasoningPreferences.setPreference("collapsed");
    const manual = { ...row, seq: 999 };
    reasoningPreferences.setBlocks([reasoningBlockId(node.id, manual.seq)], true);
    expect(renderToStaticMarkup(<TranscriptRow row={manual} node={node} />)).toContain('open=""');
    reasoningPreferences.setBlocks([reasoningBlockId(node.id, manual.seq)], false);
    reasoningPreferences.setPreference("expanded");
    expect(renderToStaticMarkup(<TranscriptRow row={manual} node={node} streaming />)).not.toContain('open=""');
    reasoningPreferences.setPreference("collapsed");
    const reply = renderToStaticMarkup(<TranscriptRow row={{ ...row, item: { type: "assistant_message", text: "Partial reply" } }} node={node} streaming />);
    expect(reply).toContain("streaming-text");
    const failed = renderToStaticMarkup(<TranscriptRow row={{ ...row, item: { type: "user_message", text: "try again" } }} node={node} outgoing={{ nodeId: node.id, clientId: "c", text: "try again", ts: row.ts, state: "failed", error: "offline" }} retry={() => undefined} />);
    expect(failed).toContain("发送失败"); expect(failed).toContain("重试"); expect(failed).toContain("offline");
  });

});
