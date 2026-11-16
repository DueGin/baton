import { applyEvent, emptyUsage, type DelegationRecord, type ItemRecord, type NodeRecord, type RunEvent, type RunEventEnvelope, type RunSnapshot, type TeamMember, type TeamRecord, type TimelineItem, type ToolCallDetail } from "@baton/protocol";
import { demoBriefPrompt, demoResultsPrompt } from "./prompts.js";

import { demoAgents } from "./agents.js";
export { demoAgents } from "./agents.js";

export interface DemoScenario { initial: RunSnapshot; events: RunEventEnvelope[]; items: Record<string, ItemRecord[]>; at: (offset: number) => string }

/** Deterministic event fixture; the UI starts midway and streams the remaining events. */
export function createScenario(base = Date.now() - 86000, id = "run-demo"): DemoScenario {
  const at = (offset: number): string => new Date(base + offset * 1000).toISOString();
  const run = { id, title: "为工作台添加全局搜索", cwd: "/workspace/atlas", rootNodeId: `${id}:root`, status: "active" as const, policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, mode: "dynamic" as const, teamApproval: false }, createdAt: at(0), updatedAt: at(0), usage: emptyUsage() };
  const initial: RunSnapshot = { run, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], questions: [], escalations: [], lastSeq: 0 };
  const events: RunEventEnvelope[] = [];
  const items: Record<string, ItemRecord[]> = {};
  const itemCounters: Record<string, number> = {};
  const delegations = new Map<string, DelegationRecord>();
  const memberFor: Record<string, TeamMember> = Object.fromEntries(([['api', 'backend', 'codex', '搜索 API、中文索引与测试'], ['ui', 'frontend', 'claude', 'Command Palette 和键盘交互'], ['review', 'reviewer', 'pi', '安全审查与边界验证'], ['index', 'indexing', 'pi', '索引环境验证']] as const).map(([key, role, agentId, responsibilities]) => [key, { id: `${id}:m-${key}`, role, agentId, model: demoAgents.find(agent => agent.id === agentId)?.models[0]?.id, responsibilities, status: "active", addedBy: "lead", addedAt: at(6), reason: `按 ${role} 职责选择合适的 agent` }]));
  const rationale = "把 API、界面和独立审查分开并行推进；索引环境单独验证，避免影响主线。";
  const team: TeamRecord = { source: "dynamic", rationale, members: Object.values(memberFor), proposals: [], changes: [{ kind: "formed", by: "lead", at: at(6), reason: rationale }], updatedAt: at(6) };
  function emit(offset: number, event: RunEvent): void { events.push({ ...event, runId: id, seq: events.length + 1, ts: at(offset) }); }
  const nid = (key: string): string => `${id}:${key}`;
  function item(offset: number, key: string, content: TimelineItem, replace?: number): number {
    const nodeId = nid(key); const seq = replace ?? (itemCounters[key] = (itemCounters[key] ?? 0) + 1);
    const row = { seq, nodeId, ts: items[nodeId]?.find(entry => entry.seq === seq)?.ts ?? at(offset), item: content };
    const current = items[nodeId] ?? []; items[nodeId] = [...current.filter(entry => entry.seq !== seq), row].sort((a, b) => a.seq - b.seq);
    emit(offset, { type: "item", nodeId, itemSeq: seq, itemTs: row.ts, item: content }); return seq;
  }
  function node(offset: number, key: string, title: string, agentId: string, parent: string | null): void {
    const member = memberFor[key];
    const record: NodeRecord = { id: nid(key), runId: id, parentNodeId: parent ? nid(parent) : null, delegationId: parent ? `d-${nid(key)}` : null, depth: parent === "api" ? 2 : parent ? 1 : 0, agentId, role: member?.role, memberId: member?.id, model: demoAgents.find(agent => agent.id === agentId)?.models[0]?.id, modeId: key === "review" ? "plan" : "default", title, cwd: run.cwd, status: "running", activity: "思考中…", createdAt: at(offset), updatedAt: at(offset), usage: emptyUsage(), turns: 1 };
    emit(offset, { type: "node.created", node: record });
    if (parent) {
      const delegation: DelegationRecord = { id: `d-${nid(key)}`, runId: id, kind: "delegate", fromNodeId: nid(parent), toNodeId: nid(key), brief: { title, task: key === "api" ? "实现 /api/search 接口与 SQLite FTS5 索引，补充单元测试。" : key === "ui" ? "实现全局搜索 Command Palette，支持键盘操作与搜索结果分组。" : key === "review" ? "独立审查搜索输入校验、SQL 注入和访问范围。" : "检查 FTS5 tokenizer 行为，提供中文搜索的可行方案。", context: "项目使用 React 19 + Node.js；保持现有 API 兼容。", acceptance: ["现有测试通过", "提供变更清单和验证结果"], readonly: key === "review" || key === "index", outputSchema: { type: "object", properties: { summary: { type: "string" } } } }, status: "running", round: 1, createdAt: at(offset), startedAt: at(offset), subtreeUsage: emptyUsage() };
      delegation.role = member?.role; delegation.memberId = member?.id;
      delegations.set(key, delegation);
      emit(offset, { type: "delegation.created", delegation });
      item(offset, key, { type: "user_message", text: demoBriefPrompt(delegation) });
    }
    emit(offset, { type: "turn.started", turn: { id: `t-${nid(key)}-1`, runId: id, nodeId: nid(key), trigger: parent ? "delegation" : "user", status: "running", startedAt: at(offset), ...(parent ? { delegationId: `d-${nid(key)}` } : {}) } });
  }
  function tool(offset: number, key: string, detail: ToolCallDetail, seconds = 4, fail = false): void {
    const callId = `${key}-${offset}`; const summary = detail.type === "shell" ? detail.command : "filePath" in detail ? detail.filePath : detail.type === "search" ? detail.query : detail.type;
    const turn = key === "api" && offset >= 44 || key === "root" && offset >= 58 ? 2 : 1;
    const span = { id: `${nid(key)}:${callId}`, runId: id, nodeId: nid(key), turnId: `t-${nid(key)}-${turn}`, callId, name: detail.type, kind: detail.type, summary, startedAt: at(offset), status: "running" as const };
    emit(offset, { type: "tool.span", span });
    emit(offset, { type: "node.updated", nodeId: nid(key), patch: { activity: `${detail.type}: ${summary}`, updatedAt: at(offset) } });
    const seq = item(offset, key, { type: "tool_call", callId, name: detail.type, status: "running", detail });
    emit(offset + seconds, { type: "tool.span", span: { ...span, status: fail ? "failed" : "completed", endedAt: at(offset + seconds) } });
    item(offset + seconds, key, { type: "tool_call", callId, name: detail.type, status: fail ? "failed" : "completed", detail, ...(fail ? { error: "测试失败：FTS5 默认 tokenizer 不支持中文分词" } : {}) }, seq);
  }
  function finish(offset: number, key: string, success = true): void {
    emit(offset, { type: "turn.updated", turnId: `t-${nid(key)}-${key === "api" ? 2 : 1}`, patch: { status: success ? "completed" : "failed", endedAt: at(offset) } });
    emit(offset, { type: "node.updated", nodeId: nid(key), patch: { status: success ? "completed" : "failed", activity: success ? "结果已交付" : "执行失败", endedAt: at(offset), updatedAt: at(offset), ...(!success ? { error: "FTS5 trigram tokenizer 在当前运行环境不可用" } : {}) } });
    const delegation: DelegationRecord = { ...delegations.get(key)!, status: success ? "completed" : "failed", endedAt: at(offset), result: { status: success ? "success" : "failed", summary: success ? "已完成任务，测试通过。详见结构化结果与产出文件。" : "当前 SQLite 构建未启用 trigram tokenizer；建议短词回退到 LIKE。", result: { summary: success ? "实现完成" : "采用 LIKE 回退", tests: success ? 12 : 1 }, artifacts: success ? [{ kind: "file", value: key === "ui" ? "src/components/SearchPalette.tsx" : "src/search.ts", description: "实现与测试" }] : [], reported: true, finalText: "已完成检查，并将结果交回父节点。" } };
    delegations.set(key, delegation);
    emit(offset, { type: "delegation.updated", delegationId: delegation.id, patch: { status: delegation.status, endedAt: delegation.endedAt, result: delegation.result } });
    emit(offset + 2, { type: "delegation.updated", delegationId: `d-${nid(key)}`, patch: { deliveredAt: at(offset + 2), deliveredVia: "turn" } });
    const parent = delegation.fromNodeId.slice(id.length + 1);
    item(offset + 2, parent, { type: "user_message", text: demoResultsPrompt([delegation]) });
  }
  emit(0, { type: "run.created", run }); node(0, "root", "协调全局搜索实现", "claude", null);
  item(0, "root", { type: "user_message", text: "为工作台添加全局搜索。支持 ⌘K 快捷键、按类型分组，覆盖中文检索，并补充测试。" });
  item(2, "root", { type: "reasoning", text: "先理解代码结构，然后把 API、交互和独立审查并行委派给不同 agent。索引方案存在环境风险，需要单独验证。" });
  item(4, "root", { type: "assistant_message", text: "我会把工作分成三个并行任务：\n\n- **Codex**：搜索 API 和索引\n- **Claude Code**：Command Palette 交互\n- **pi**：独立审查边界与安全\n\n结果会自动回到这里，我会整合并验证。" });
  tool(5, "root", { type: "baton", tool: "list_agents", input: {}, output: ["claude", "codex", "pi"] }, 1);
  emit(6, { type: "team.updated", team, change: team.changes[0]! });
  node(8, "api", "实现搜索 API", "codex", "root");
  node(11, "ui", "构建 Command Palette", "claude", "root");
  node(14, "review", "审查搜索边界与安全", "pi", "root");
  emit(15, { type: "turn.updated", turnId: `t-${nid("root")}-1`, patch: { status: "completed", endedAt: at(15) } });
  emit(15, { type: "node.updated", nodeId: nid("root"), patch: { status: "idle", activity: "等待委派结果", updatedAt: at(15) } });
  item(9, "api", { type: "assistant_message", text: "正在梳理现有路由与数据库结构；我会保留现有 API 风格。" });
  tool(10, "api", { type: "read", filePath: "src/server/routes.ts", content: "export const routes = createRouter();\nroutes.get('/api/workspaces', listWorkspaces);" });
  tool(16, "review", { type: "search", query: "search|query|sqlite", content: "src/search.ts:12\nSELECT * FROM documents WHERE workspace_id = ?", numFiles: 3, numMatches: 8 });
  tool(17, "ui", { type: "read", filePath: "src/components/Dialog.tsx", content: "export function Dialog({ children }: Props) { … }" });
  node(23, "index", "验证中文索引方案", "pi", "api");
  item(24, "index", { type: "notice", level: "info", message: "只读委派：检查 SQLite 能力，不修改文件。" });
  tool(26, "index", { type: "shell", command: "node scripts/check-fts.mjs", output: "SQLite 3.46.1\nError: no such tokenizer: trigram", exitCode: 1 }, 8, true);
  tool(27, "api", { type: "edit", filePath: "src/search.ts", unifiedDiff: "--- a/src/search.ts\n+++ b/src/search.ts\n@@ -1,2 +1,5 @@\n+export function search(query: string) {\n+  const normalized = query.trim().slice(0, 200);\n+  return db.prepare(SEARCH_SQL).all(normalized);\n+}" }, 9);
  tool(29, "ui", { type: "write", filePath: "src/components/SearchPalette.tsx", content: "export function SearchPalette() {\n  const [query, setQuery] = useState('');\n  return <Dialog aria-label=\"全局搜索\">…</Dialog>;\n}" }, 8);
  tool(35, "review", { type: "fetch", url: "https://www.sqlite.org/fts5.html", result: "Use parameter binding for MATCH expressions and enforce workspace boundaries.", code: 200 }, 5);
  finish(42, "index", false);
  emit(43, { type: "turn.updated", turnId: `t-${nid("api")}-1`, patch: { status: "completed", endedAt: at(43) } });
  item(44, "api", { type: "notice", level: "warning", message: "子节点结果：trigram 不可用；采用短词 LIKE 回退并测试。" });
  emit(44, { type: "turn.started", turn: { id: `t-${nid("api")}-2`, runId: id, nodeId: nid("api"), trigger: "result", delegationId: `d-${nid("index")}`, status: "running", startedAt: at(44) } });
  emit(44, { type: "node.updated", nodeId: nid("api"), patch: { turns: 2, updatedAt: at(44) } });
  tool(47, "api", { type: "shell", command: "npm test -- src/search.test.ts", output: "✓ search.test.ts (12 tests)\nTest Files  1 passed (1)\nTests       12 passed (12)", exitCode: 0 }, 12);
  item(51, "review", { type: "assistant_message", text: "审查完成：\n\n1. 搜索查询必须参数绑定。\n2. 对查询长度设置 `200` 字符上限。\n3. 所有结果保持 `workspace_id` 隔离。\n\n```ts\nconst query = input.trim().slice(0, 200);\n```" });
  finish(56, "review");
  emit(58, { type: "turn.started", turn: { id: `t-${nid("root")}-2`, runId: id, nodeId: nid("root"), trigger: "result", status: "running", startedAt: at(58) } });
  emit(58, { type: "node.updated", nodeId: nid("root"), patch: { status: "running", turns: 2, activity: "整合审查建议", updatedAt: at(58) } });
  tool(60, "ui", { type: "plan", text: "完成快捷键、焦点管理与分组结果。接下来运行组件测试。" }, 2);
  const permission = { id: `${nid("ui")}:install`, runId: id, nodeId: nid("ui"), requestId: "demo-install", request: { id: "demo-install", name: "shell", kind: "tool" as const, title: "允许安装测试依赖？", description: "运行 npm install -D @testing-library/user-event，以验证键盘导航。", detail: { type: "shell" as const, command: "npm install -D @testing-library/user-event", cwd: run.cwd }, actions: [{ id: "allow", label: "允许一次", behavior: "allow" as const }, { id: "deny", label: "拒绝", behavior: "deny" as const }] }, status: "pending" as const, requestedAt: at(68) };
  emit(68, { type: "permission", permission });
  emit(68, { type: "node.updated", nodeId: nid("ui"), patch: { status: "waiting_permission", activity: "等待批准 shell 命令", updatedAt: at(68) } });
  item(70, "root", { type: "assistant_message", text: "安全审查已完成。中文检索将使用兼容回退方案；API 测试已经通过。UI 节点正等待你的授权。" });
  tool(74, "api", { type: "baton", tool: "report_result", input: { status: "success", summary: "搜索 API、中文回退和 12 个测试完成" }, output: { delivered: true } }, 2);
  finish(79, "api");
  const previousMember = memberFor.review!;
  const successor: TeamMember = { ...previousMember, id: `${id}:m-review-v2`, agentId: "codex", model: demoAgents.find(agent => agent.id === "codex")?.models[0]?.id, replaces: previousMember.id, addedAt: at(83), reason: "安全审查完成后由 Codex 接手集成回归，复用实现上下文。" };
  const change = { kind: "member_replaced" as const, by: "lead" as const, at: at(83), memberId: successor.id, previousMemberId: previousMember.id, reason: successor.reason };
  emit(83, { type: "team.updated", team: { ...team, members: team.members.map(member => member.id === previousMember.id ? { ...member, status: "replaced" as const, replacedBy: successor.id, reason: successor.reason } : member).concat(successor), changes: [...team.changes, change], updatedAt: at(83) }, change });
  memberFor.regression = successor;
  node(84, "regression", "验证集成回归", "codex", "root");
  item(84, "regression", { type: "assistant_message", text: "已完成核心路径检查，接下来需要前端交互测试经验更丰富的 agent 继续验证。" });
  const replacementId = `d-${nid("regression-v2")}`;
  emit(85, { type: "node.updated", nodeId: nid("regression"), patch: { status: "replaced", endedAt: at(85), updatedAt: at(85), activity: "任务已改派" } });
  emit(85, { type: "turn.updated", turnId: `t-${nid("regression")}-1`, patch: { status: "canceled", endedAt: at(85) } });
  emit(85, { type: "delegation.updated", delegationId: `d-${nid("regression")}`, patch: { status: "replaced", replacedBy: replacementId, replaceReason: "交互回归交给 frontend 成员接手", endedAt: at(85) } });
  memberFor['regression-v2'] = memberFor.ui!;
  node(85, "regression-v2", "验证集成回归", "claude", "root");
  emit(85, { type: "delegation.updated", delegationId: replacementId, patch: { replaces: `d-${nid("regression")}` } });
  item(85, "root", { type: "user_message", text: `<baton-notice>\n任务已改派：d-${nid("regression")} → ${replacementId}\n原因：交互回归交给 frontend 成员接手；前任进展已附入任务书。\n</baton-notice>` });
  tool(86, "regression-v2", { type: "shell", command: "npm test -- integration", output: "8 integration tests passed", exitCode: 0 }, 7);
  finish(95, "regression-v2");
  const liveMessage = item(88, "root", { type: "assistant_message", text: "API 结果已经收到。我正在核对最终变更" });
  item(92, "root", { type: "assistant_message", text: "API 结果已经收到。我正在核对最终变更，并准备集成验证。" }, liveMessage);
  item(96, "root", { type: "assistant_message", text: "API 结果已经收到。我正在核对最终变更，并准备集成验证。\n\nUI 节点仍在等待授权；你可以在节点卡片上直接处理。" }, liveMessage);
  tool(90, "root", { type: "shell", command: "git diff --stat", output: " src/search.ts                       | 82 +++++++++++++\n src/components/SearchPalette.tsx     | 146 +++++++++++++++++++\n src/search.test.ts                   | 92 +++++++++++++++\n 3 files changed, 320 insertions(+)\n", exitCode: 0 }, 3);
  tool(100, "root", { type: "read", filePath: "src/search.test.ts", content: "it('keeps workspace boundaries', () => {\n  expect(search('报告', 'workspace-a')).toHaveLength(2);\n});" }, 5);
  tool(111, "root", { type: "shell", command: "npm run typecheck", output: "> tsc --noEmit\n\nTypes checked successfully.", exitCode: 0 }, 8);
  for (let second = 15; second <= 125; second += 5) {
    const total = emptyUsage(); const perNode = new Map<string, ReturnType<typeof emptyUsage>>();
    for (const [key, share] of [["root", 0.28], ["api", 0.30], ["ui", 0.24], ["review", 0.12], ["index", 0.06]] as const) {
      const created = { root: 0, api: 8, ui: 11, review: 14, index: 23 }[key];
      const ended = { root: 130, api: 79, ui: 68, review: 56, index: 42 }[key];
      if (second <= created) continue;
      const time = Math.min(second, ended) - created;
      const usage = { inputTokens: Math.round(time * 248 * share), cachedInputTokens: Math.round(time * 62 * share), outputTokens: Math.round(time * 47 * share), costUsd: time * 0.0084 * share };
      perNode.set(key, usage);
      total.inputTokens += usage.inputTokens; total.cachedInputTokens += usage.cachedInputTokens; total.outputTokens += usage.outputTokens; total.costUsd += usage.costUsd;
      emit(second, { type: "node.updated", nodeId: nid(key), patch: { usage } });
    }
    emit(second, { type: "run.updated", patch: { usage: total, updatedAt: at(second) } });
    for (const key of ["api", "ui", "review", "index"]) {
      const own = perNode.get(key); if (!own) continue;
      const child = key === "api" ? perNode.get("index") : undefined;
      emit(second, { type: "delegation.updated", delegationId: `d-${nid(key)}`, patch: { subtreeUsage: child ? { inputTokens: own.inputTokens + child.inputTokens, cachedInputTokens: own.cachedInputTokens + child.cachedInputTokens, outputTokens: own.outputTokens + child.outputTokens, costUsd: own.costUsd + child.costUsd } : own } });
    }
  }
  // Schedule order is independent of fixture declaration order. Reassign run sequence after sort.
  events.sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  // Fixture helpers may schedule delivery after a later-declared message. Allocate local item
  // sequences on first chronological appearance while preserving chunk replacements.
  const localSequences = new Map<string, Map<number, number>>();
  for (const event of events) if (event.type === "item") {
    const sequences = localSequences.get(event.nodeId) ?? new Map<number, number>();
    if (!sequences.has(event.itemSeq)) sequences.set(event.itemSeq, sequences.size + 1);
    event.itemSeq = sequences.get(event.itemSeq)!;
    localSequences.set(event.nodeId, sequences);
  }
  for (const [nodeId, rows] of Object.entries(items)) items[nodeId] = rows.map(row => ({ ...row, seq: localSequences.get(nodeId)!.get(row.seq)! })).sort((a, b) => a.seq - b.seq);
  events.forEach((event, index) => { event.seq = index + 1; });
  return { initial, events, items, at };
}

export function replay(scenario: DemoScenario, until: number): RunSnapshot {
  return scenario.events.filter(event => Date.parse(event.ts) <= until).reduce(applyEvent, scenario.initial);
}
