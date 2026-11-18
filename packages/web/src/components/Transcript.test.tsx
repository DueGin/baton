import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { agentCardPreferences } from "../lib/agent-card-preferences.js";
import { Markdown, ToolDetail, Transcript, TranscriptRow, toolSummary } from "./Transcript.js";
import { DemoClient } from "../demo/client.js";
import { RunStore } from "../store.js";
import { createScenario, replay } from "../demo/scenario.js";
import { demoBriefPrompt, demoResultsPrompt } from "../demo/prompts.js";
import { reasoningBlockId, reasoningPreferences } from "../lib/reasoning.js";
import type { TimelineItem } from "@baton/protocol";
import { nodeIsLive, type MessageActionState } from "../lib/conversation.js";

describe("safe agent content rendering", () => {
  it("renders the anchored question between the agent introduction and same-turn continuation", async () => {
    const now = Date.parse("2026-11-10T07:00:00Z"); const client = new DemoClient(() => now); const store = new RunStore(client);
    const snapshot = await client.run("run-questions"); const question = snapshot.questions[0]!;
    await client.answer(question.id, { answers: { scope: ["当前项目"], checks: ["中文", "权限"] } });
    const live = await client.run(snapshot.run.id); const items = (await client.items(question.nodeId)).items;
    const html = renderToStaticMarkup(<Transcript snapshot={live} store={store} items={{ [question.nodeId]: items }} itemStatus={{ [question.nodeId]: "ready" }} nodeId={question.nodeId} setNodeId={() => undefined} now={now} inspect={() => undefined} answer={() => undefined} busy={false} />);
    expect(html.indexOf("先确认两个产品选择")).toBeLessThan(html.indexOf("question-card")); expect(html.indexOf("question-card")).toBeLessThan(html.indexOf("已收到回答，继续执行"));
    expect(html).not.toContain("tool-row"); expect(html).toContain("你的回答："); expect(html).not.toContain("baton-answer-card");
  });
  it("docks a pending question above the composer and leaves a slim marker in the transcript", async () => {
    const now = Date.parse("2026-11-10T07:00:00Z"); const client = new DemoClient(() => now); const store = new RunStore(client);
    const snapshot = await client.run("run-questions"); const question = snapshot.questions[0]!; const items = (await client.items(question.nodeId)).items;
    const html = renderToStaticMarkup(<Transcript snapshot={snapshot} store={store} items={{ [question.nodeId]: items }} itemStatus={{ [question.nodeId]: "ready" }} nodeId={question.nodeId} setNodeId={() => undefined} now={now} inspect={() => undefined} answer={() => undefined} busy={false} />);
    const transcript = html.slice(0, html.indexOf('class="composer-stack"')); const stack = html.slice(html.indexOf('class="composer-stack"'));
    expect(transcript).toContain("question-marker"); expect(transcript).toContain("在输入框上方作答"); expect(transcript).not.toContain("question-card");
    expect(stack.indexOf('class="question-dock"')).toBeLessThan(stack.indexOf('class="composer"')); expect(stack).toContain("question-card question-pending is-compact"); expect(stack).toContain("提交回答"); expect(stack).toContain('aria-label="收起问题"');
    expect(html.match(new RegExp(`id="question-${encodeURIComponent(question.id)}"`, "g"))).toHaveLength(1);
  });
  it("turns the empty composer's send button into 停止 while agents work and 继续 once paused", () => {
    const now = Date.parse("2026-11-10T07:00:00Z"); const store = new RunStore(new DemoClient(() => now));
    const live = replay(createScenario(0), 30000); const node = live.nodes[0]!;
    expect(live.nodes.some(entry => nodeIsLive(live, entry))).toBe(true);
    const render = (snapshot: typeof live, actions = true) => renderToStaticMarkup(<Transcript snapshot={snapshot} store={store} items={{ [node.id]: [] }} itemStatus={{ [node.id]: "ready" }} nodeId={node.id} setNodeId={() => undefined} now={now} inspect={() => undefined} answer={() => undefined} busy={false} {...(actions ? { stopRun: () => undefined, resumeRun: () => undefined } : {})} />);
    const working = render(live); expect(working).toContain("composer-stop"); expect(working).toContain('aria-label="停止"'); expect(working).not.toContain('aria-label="发送"'); expect(working).not.toMatch(/<\/svg>(停止|发送|继续)<\/button>/);
    const paused = render({ ...live, run: { ...live.run, status: "paused" } }); expect(paused).toContain("composer-resume"); expect(paused).toContain('aria-label="继续"'); expect(paused).not.toMatch(/<\/svg>继续<\/button>/);
    const restarted = render({ ...live, run: { ...live.run, status: "paused", pauses: [{ at: live.run.createdAt, by: "restart" }] } }); expect(restarted).toContain("baton 重启时有 agent 正在工作"); expect(restarted).toContain("composer-resume");
    const done = render({ ...live, run: { ...live.run, status: "completed" } }); expect(done).not.toContain("composer-stop"); expect(done).toContain('aria-label="发送"'); expect(done).not.toMatch(/<\/svg>发送<\/button>/);
    expect(render(live, false)).not.toContain("composer-stop");
  });
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
  it("shows the actual tool name and concise input summary for unknown details", () => {
    const snapshot = replay(createScenario(0), 86000); const node = snapshot.nodes[0]!;
    const detail = { type: "unknown" as const, input: { query: "+baton send" }, output: null };
    const html = renderToStaticMarkup(<TranscriptRow row={{ seq: 99, nodeId: node.id, ts: node.createdAt, item: { type: "tool_call", callId: "search", name: "ToolSearch", status: "completed", detail } }} node={node} />);
    expect(html).toContain("ToolSearch ·"); expect(html).toContain("+baton send"); expect(html).not.toContain("unknown unknown"); expect(html).not.toContain('class="tool-type">unknown');
    expect(toolSummary({ type: "unknown", input: null, output: null }, "ToolSearch")).toBe("ToolSearch");
    expect(toolSummary({ type: "unknown", input: "x".repeat(500), output: null }, "ToolSearch").length).toBeLessThan(120);
  });
  it("renders baton assignments/results as linked cards and falls back to escaped text", () => {
    const snapshot = replay(createScenario(0), 86000);
    const edge = snapshot.delegations.find(delegation => delegation.result?.status === "success")!;
    const node = snapshot.nodes[0]!;
    const render = (text: string) => renderToStaticMarkup(<TranscriptRow row={{ seq: 1, nodeId: node.id, ts: snapshot.run.createdAt, item: { type: "user_message", text } }} node={node} snapshot={snapshot} inspect={() => undefined} />);
    agentCardPreferences.setDefault(true);
    const assignment = render(demoBriefPrompt(edge));
    expect(assignment).toContain("来自 Lead 的任务");
    expect(assignment).toContain('aria-label="查看 Lead 节点"');
    expect(assignment).not.toContain("baton-assignment");
    expect(assignment).toContain("验收标准");
    const delivered = render(demoResultsPrompt([{ ...edge, brief: { ...edge.brief, title: '<script>alert("x")</script>' }, result: { ...edge.result!, summary: '<img src=x onerror="bad()">' } }]));
    expect(delivered).toContain("收到结果");
    expect(delivered).toContain('aria-label="结果：success"');
    expect(delivered).toContain("Result JSON");
    expect(delivered).toContain("Artifacts");
    expect(delivered).toContain(`aria-label="查看 ${snapshot.nodes.find(node => node.id === edge.toNodeId)!.role} 节点"`);
    expect(delivered).not.toContain("<script");
    expect(delivered).not.toContain("<img");
    const malformed = render('<baton-assignment delegation="x">broken <img src=x></baton-assignment>');
    expect(malformed).toContain("&lt;baton-assignment");
    expect(malformed).not.toContain("protocol-card");
    const notice = render('<baton-notice>任务已改派 <img src=x onerror="bad()"></baton-notice>');
    expect(notice).toContain("团队通知"); expect(notice).toContain('data-agent-card="notice"'); expect(notice).not.toContain("<img");
    agentCardPreferences.setDefault(false);
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
