import { applyEvent, type ItemRecord, type RunSnapshot, type TimelineItem } from "@baton/protocol";
import { createScenario } from "./scenario.js";
import { demoBriefPrompt, demoFollowupPrompt, demoNoticePrompt, demoResultsPrompt } from "./prompts.js";

/** A small gallery embedded in a real tree, so every counterpart link is inspectable. */
export function agentMessageDemo(now: number): { snapshot: RunSnapshot; items: ItemRecord[] } {
  const scenario = createScenario(now - 600000, "run-agent-messages"); const seed = scenario.events.reduce(applyEvent, scenario.initial);
  const snapshot: RunSnapshot = { ...seed, run: { ...seed.run, projectId: "project-atlas", title: "Agent 消息 · 派活、追问与结果", status: "idle", updatedAt: new Date(now).toISOString() }, nodes: seed.nodes.map(node => node.parentNodeId ? node : { ...node, status: "idle", activity: "等待成员结果" }), turns: seed.turns.map(turn => turn.status === "running" ? { ...turn, status: "completed", endedAt: new Date(now - 1000).toISOString() } : turn), permissions: [], questions: [], escalations: [] };
  const root = snapshot.nodes[0]!; const api = snapshot.delegations.find(edge => edge.role === "backend")!;
  const review = snapshot.delegations.find(edge => edge.toNodeId.endsWith(":review"))!;
  const old = snapshot.delegations.find(edge => edge.replacedBy)!; const replacement = snapshot.delegations.find(edge => edge.id === old.replacedBy)!;
  const items: ItemRecord[] = []; const counters = new Map<string, number>();
  const row = (nodeId: string, item: TimelineItem) => { const seq = (counters.get(nodeId) ?? 0) + 1; counters.set(nodeId, seq); items.push({ nodeId, seq, ts: new Date(now - 50000 + items.length * 2000).toISOString(), item }); };
  const tool = (nodeId: string, name: string, input: Record<string, import("@baton/protocol").JsonValue>, output?: import("@baton/protocol").JsonValue) => row(nodeId, { type: "tool_call", callId: `${nodeId}:${name}:${items.length}`, name: `mcp__baton__${name}`, status: "completed", detail: { type: "baton", tool: name, input, output } });
  row(root.id, { type: "user_message", text: "实现搜索，并请团队独立验证。" });
  row(root.id, { type: "assistant_message", text: "把 API 和独立审查分给不同成员。下方卡片可展开查看任务与往来消息。" });
  tool(root.id, "delegate", { role: api.role!, title: api.brief.title, task: api.brief.task, context: api.brief.context ?? "", acceptance: api.brief.acceptance ?? [], outputSchema: api.brief.outputSchema ?? {} }, { delegationId: api.id, nodeId: api.toNodeId });
  const followup = "请补充中文短词的回归测试。\n\n优先覆盖：\n- 单字检索\n- 跨项目访问边界";
  tool(root.id, "send", { delegationId: api.id, message: followup }, { delivered: true });
  tool(root.id, "reassign", { delegationId: old.id, reason: "改由验证成员接手回归任务，保持文件归属不变。" }, { delegationId: replacement.id, nodeId: replacement.toNodeId, replaces: old.id });
  row(root.id, { type: "user_message", text: demoResultsPrompt([api, { ...review, result: { ...review.result!, status: "partial", summary: "边界审查基本完成，建议补充一种授权用例。" } }, { ...old, result: { status: "failed", summary: "原回归成员已中断，任务已改派。", reported: true, finalText: "" } }]) });
  row(root.id, { type: "user_message", text: demoNoticePrompt("team", "验证成员已调整\n新的 reviewer 接手剩余回归，并保留前任进度。") });
  row(root.id, { type: "user_message", text: demoNoticePrompt("system", "会话已恢复\n后台服务仍在运行，可以继续验证。") });
  row(root.id, { type: "tool_call", callId: "search-tools", name: "ToolSearch", status: "completed", detail: { type: "unknown", input: { query: "+baton send report_result" }, output: { tools: ["send", "report_result"] } } });
  row(api.toNodeId, { type: "user_message", text: demoBriefPrompt(api) });
  row(api.toNodeId, { type: "assistant_message", text: "已完成 API 实现，准备交付验证结果。" });
  row(api.toNodeId, { type: "user_message", text: demoFollowupPrompt(api.id, followup) });
  row(api.toNodeId, { type: "user_message", text: demoNoticePrompt("correction", "结果结构需要修正\n\n`tests` 必须是数字。请修正并重新调用 report_result。") });
  tool(api.toNodeId, "report_result", { status: "success", summary: "搜索 API 与中文短词测试通过。\n已覆盖访问边界。", result: { tests: 18, summary: "实现完成" }, artifacts: [{ kind: "file", value: "src/search.ts", description: "实现与测试" }] }, { accepted: true });
  row(api.toNodeId, { type: "user_message", text: '<baton-answer question="demo-risk">优先验证跨项目访问权限。</baton-answer>' });
  // Another run's session messages this one (DESIGN §4.16), then the reply goes back with send_message.
  const from = snapshot.delegations.find(edge => edge.toNodeId.endsWith(":review"))?.toNodeId ?? api.toNodeId;
  row(root.id, { type: "user_message", text: `<baton-message from="${from}" agent="claude" role="review" title="审查搜索边界与安全" run="run-notes" session="后台服务 · Vite 与 Python" project="Atlas">搜索接口的分页参数用 limit 还是 pageSize？我们这边想统一命名。</baton-message>` });
  tool(root.id, "send_message", { to: from, message: "统一用 limit + cursor；语料侧我们同步改，本周内完成。" }, { sent: true, delivery: "delivered; the receiver started a turn", to: { agentId: from, agent: "claude", role: "review", title: "审查搜索边界与安全", run: { id: "run-notes", title: "后台服务 · Vite 与 Python" }, project: "Atlas" } });
  for (const edge of snapshot.delegations.filter(edge => edge.toNodeId !== api.toNodeId)) row(edge.toNodeId, { type: "user_message", text: demoBriefPrompt(edge) });
  return { snapshot, items };
}
