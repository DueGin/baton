import { applyEvent, emptyUsage, type CreateRunRequest, type DelegationRecord, type GetItemsResponse, type PatchRunRequest, type PermissionDecision, type RunEvent, type RunEventEnvelope, type RunSnapshot, type TimelineItem } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { summarize, terminal } from "../lib/derive.js";
import { createScenario, demoAgents } from "./scenario.js";
import { demoResultsPrompt } from "./prompts.js";

interface DemoRun { snapshot: RunSnapshot; remaining: RunEventEnvelope[]; log: RunEventEnvelope[] }
export class DemoClient implements BatonClient {
  readonly demo = true;
  private data = new Map<string, DemoRun>();
  private listeners = new Set<(event: RunEventEnvelope) => void>();
  private counter = 0;
  constructor(private readonly now: () => number = Date.now) {
    const scenario = createScenario(now() - 86000);
    let snapshot = scenario.initial;
    const log = scenario.events.filter(event => Date.parse(event.ts) <= now());
    for (const event of log) snapshot = applyEvent(snapshot, event);
    this.data.set(snapshot.run.id, { snapshot, log, remaining: scenario.events.filter(event => Date.parse(event.ts) > now()) });
    const archived = createScenario(now() - 86400000, "run-previous");
    let previous = archived.events.reduce(applyEvent, archived.initial);
    previous = {
      ...previous,
      run: { ...previous.run, title: "梳理项目结构与 API 规范", status: "completed", endedAt: archived.at(130) },
      nodes: previous.nodes.map(node => terminal(node.status) ? node : { ...node, status: "completed", activity: "结果已交付", endedAt: archived.at(130), updatedAt: archived.at(130) }),
      turns: previous.turns.map(turn => turn.status === "running" ? { ...turn, status: "completed", endedAt: archived.at(130) } : turn),
      delegations: previous.delegations.map(edge => terminal(edge.status) ? edge : { ...edge, status: "completed", endedAt: archived.at(130), deliveredAt: archived.at(130), deliveredVia: "turn", result: { status: "success", summary: "任务完成，结果已交付。", reported: true, finalText: "实现与验证完成。" } }),
      permissions: previous.permissions.map(permission => ({ ...permission, status: "resolved", resolution: { behavior: "allow" }, resolvedBy: "human", resolvedAt: archived.at(90) })),
    };
    this.data.set(previous.run.id, { snapshot: previous, log: archived.events, remaining: [] });
  }
  agents = async () => structuredClone(demoAgents);
  runs = async () => { this.advance(); return [...this.data.values()].map(data => summarize(data.snapshot)).reverse(); };
  run = async (id: string) => { this.advance(); return structuredClone(this.get(id).snapshot); };
  delegation = async (id: string): Promise<DelegationRecord> => {
    for (const data of this.data.values()) { const delegation = data.snapshot.delegations.find(edge => edge.id === id); if (delegation) return structuredClone(delegation); }
    throw new Error("委派不存在");
  };
  private get(id: string): DemoRun { const data = this.data.get(id); if (!data) throw new Error("Run 不存在"); return data; }
  private forNode(id: string): DemoRun {
    const data = [...this.data.values()].find(entry => entry.snapshot.nodes.some(node => node.id === id));
    if (!data) throw new Error("节点不存在"); return data;
  }
  private emit(data: DemoRun, event: RunEvent): void {
    const envelope = { ...event, runId: data.snapshot.run.id, seq: data.snapshot.lastSeq + 1, ts: new Date(this.now()).toISOString() } as RunEventEnvelope;
    data.snapshot = applyEvent(data.snapshot, envelope); data.log.push(envelope);
    this.listeners.forEach(listener => listener(envelope));
  }
  private append(data: DemoRun, nodeId: string, item: TimelineItem): void {
    const seq = Math.max(0, ...data.log.filter(event => event.type === "item" && event.nodeId === nodeId).map(event => event.type === "item" ? event.itemSeq : 0)) + 1;
    this.emit(data, { type: "item", nodeId, itemSeq: seq, ts: new Date(this.now()).toISOString(), item });
  }
  private advance(): void {
    for (const data of this.data.values()) {
      const ready = data.remaining.filter(event => Date.parse(event.ts) <= this.now());
      data.remaining = data.remaining.filter(event => Date.parse(event.ts) > this.now());
      for (const event of ready) {
        if (terminal(data.snapshot.run.status)) continue;
        this.emit(data, event);
      }
    }
  }
  async createRun(request: CreateRunRequest): Promise<RunSnapshot> {
    const id = `run-local-${++this.counter}`; const ts = new Date(this.now()).toISOString(); const rootNodeId = `${id}:root`;
    const snapshot: RunSnapshot = { run: { id, title: request.title || request.prompt.slice(0, 28), status: "active", cwd: request.cwd, rootNodeId, createdAt: ts, updatedAt: ts, policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, ...request.policy }, usage: emptyUsage() }, nodes: [{ id: rootNodeId, runId: id, parentNodeId: null, delegationId: null, depth: 0, agentId: request.agent, model: request.model, modeId: request.modeId, thinking: request.thinking, title: request.title || "处理用户请求", status: "running", activity: "分析任务", cwd: request.cwd, usage: emptyUsage(), turns: 1, createdAt: ts, updatedAt: ts }], turns: [{ id: `${id}:t1`, runId: id, nodeId: rootNodeId, status: "running", trigger: "user", startedAt: ts }], delegations: [], permissions: [], toolSpans: [], lastSeq: 0 };
    const data = { snapshot, log: [], remaining: [] }; this.data.set(id, data);
    this.append(data, rootNodeId, { type: "user_message", text: request.prompt });
    this.append(data, rootNodeId, { type: "notice", level: "info", message: "这是浏览器内 demo。消息与操作保存在本次会话中，不会调用本机 agent。" });
    this.append(data, rootNodeId, { type: "assistant_message", text: "收到任务。我会先检查项目结构，再根据工作范围创建委派。\n\n当前为 demo 模式；连接 daemon 后会启动真实 agent。" });
    this.emit(data, { type: "node.updated", nodeId: rootNodeId, patch: { status: "idle", activity: "等待下一条消息" } });
    this.emit(data, { type: "turn.updated", turnId: `${id}:t1`, patch: { status: "completed", endedAt: ts } });
    this.emit(data, { type: "run.updated", patch: { status: "idle" } });
    return structuredClone(data.snapshot);
  }
  async patchRun(id: string, request: PatchRunRequest): Promise<void> {
    const data = this.get(id);
    this.emit(data, { type: "run.updated", patch: { ...(request.title ? { title: request.title } : {}), policy: { ...data.snapshot.run.policy, ...request.policy }, updatedAt: new Date(this.now()).toISOString() } });
    if (request.policy?.autoApprove) for (const permission of data.snapshot.permissions.filter(entry => entry.status === "pending")) await this.resolve(permission.requestId, { response: { behavior: "allow" } }, "policy");
  }
  async items(nodeId: string, after = 0): Promise<GetItemsResponse> {
    this.advance(); const data = this.forNode(nodeId);
    const rows = new Map<number, GetItemsResponse["items"][number]>();
    for (const event of data.log) if (event.type === "item" && event.nodeId === nodeId) rows.set(event.itemSeq, { seq: event.itemSeq, nodeId, ts: event.ts, item: event.item, turnId: event.turnId });
    const items = [...rows.values()].filter(row => row.seq > after).sort((a, b) => a.seq - b.seq);
    return structuredClone({ items, lastSeq: items.at(-1)?.seq ?? after });
  }
  async send(nodeId: string, text: string): Promise<void> {
    const data = this.forNode(nodeId); const ts = new Date(this.now()).toISOString(); const node = data.snapshot.nodes.find(entry => entry.id === nodeId)!;
    if (node.status === "canceled") throw new Error("节点已取消，请创建新的 Run");
    if (node.status === "waiting_permission") throw new Error("请先处理该节点的权限请求");
    this.append(data, nodeId, { type: "user_message", text });
    const turnId = `${nodeId}:user-${data.snapshot.lastSeq}`;
    this.emit(data, { type: "turn.started", turn: { id: turnId, runId: data.snapshot.run.id, nodeId, trigger: "user", status: "running", startedAt: ts } });
    this.emit(data, { type: "node.updated", nodeId, patch: { status: "running", endedAt: undefined, turns: node.turns + 1, activity: "处理新消息", updatedAt: ts } });
    this.append(data, nodeId, { type: "assistant_message", text: `已收到补充：\n\n${text}\n\n这是 demo 回复。真实连接下，消息会发送到选中节点的 agent 会话。` });
    this.emit(data, { type: "turn.updated", turnId, patch: { status: "completed", endedAt: ts } });
    this.emit(data, { type: "node.updated", nodeId, patch: { status: "idle", activity: "等待下一条消息", updatedAt: ts } });
    if (node.delegationId) this.emit(data, { type: "delegation.updated", delegationId: node.delegationId, patch: { round: (data.snapshot.delegations.find(edge => edge.id === node.delegationId)?.round ?? 1) + 1 } });
    this.emit(data, { type: "run.updated", patch: { status: "active", endedAt: undefined, updatedAt: ts } });
  }
  cancelRun = async (id: string): Promise<void> => { const data = this.get(id); await this.cancelNode(data.snapshot.run.rootNodeId); };
  async cancelNode(nodeId: string): Promise<void> {
    const data = this.forNode(nodeId); const ids = new Set([nodeId]); const ts = new Date(this.now()).toISOString();
    let size = 0; while (size !== ids.size) { size = ids.size; data.snapshot.nodes.forEach(node => { if (node.parentNodeId && ids.has(node.parentNodeId)) ids.add(node.id); }); }
    data.remaining = data.remaining.filter(event => {
      if (event.type === "run.updated" && event.patch.usage) return false;
      if ("nodeId" in event && event.nodeId && ids.has(event.nodeId)) return false;
      if (event.type === "tool.span" && ids.has(event.span.nodeId)) return false;
      if (event.type === "permission" && ids.has(event.permission.nodeId)) return false;
      if (event.type === "turn.started" && ids.has(event.turn.nodeId)) return false;
      if (event.type === "turn.updated" && data.snapshot.turns.some(turn => turn.id === event.turnId && ids.has(turn.nodeId))) return false;
      if (event.type === "delegation.updated" && data.snapshot.delegations.some(edge => edge.id === event.delegationId && ids.has(edge.toNodeId))) return false;
      return true;
    });
    for (const node of [...data.snapshot.nodes].reverse()) if (ids.has(node.id) && !terminal(node.status)) this.emit(data, { type: "node.updated", nodeId: node.id, patch: { status: "canceled", endedAt: ts, updatedAt: ts } });
    for (const turn of data.snapshot.turns) if (ids.has(turn.nodeId) && turn.status === "running") this.emit(data, { type: "turn.updated", turnId: turn.id, patch: { status: "canceled", endedAt: ts } });
    for (const span of data.snapshot.toolSpans) if (ids.has(span.nodeId) && span.status === "running") this.emit(data, { type: "tool.span", span: { ...span, status: "canceled", endedAt: ts } });
    for (const edge of data.snapshot.delegations) if (ids.has(edge.toNodeId) && !terminal(edge.status)) this.emit(data, { type: "delegation.updated", delegationId: edge.id, patch: { status: "canceled", endedAt: ts } });
    for (const permission of data.snapshot.permissions) if (ids.has(permission.nodeId) && permission.status === "pending") this.emit(data, { type: "permission", permission: { ...permission, status: "expired", resolvedAt: ts } });
    if (ids.has(data.snapshot.run.rootNodeId)) this.emit(data, { type: "run.updated", patch: { status: "canceled", endedAt: ts, updatedAt: ts } });
  }
  decide = (requestId: string, decision: PermissionDecision) => this.resolve(requestId, decision, "human");
  private async resolve(requestId: string, decision: PermissionDecision, by: "human" | "policy"): Promise<void> {
    for (const data of this.data.values()) {
      const permission = data.snapshot.permissions.find(entry => entry.requestId === requestId && entry.status === "pending");
      if (!permission) continue;
      const ts = new Date(this.now()).toISOString();
      this.emit(data, { type: "permission", permission: { ...permission, status: "resolved", resolution: decision.response, resolvedBy: by, resolvedAt: ts } });
      this.append(data, permission.nodeId, { type: "notice", level: "info", message: decision.response.behavior === "allow" ? "授权已允许，继续执行。" : "授权已拒绝，使用现有测试依赖。" });
      this.append(data, permission.nodeId, { type: "assistant_message", text: "Command Palette 已完成：支持 ⌘K、方向键导航、Esc 关闭和结果分组。组件测试通过。" });
      this.emit(data, { type: "node.updated", nodeId: permission.nodeId, patch: { status: "completed", activity: "结果已交付", endedAt: ts, updatedAt: ts } });
      for (const turn of data.snapshot.turns) if (turn.nodeId === permission.nodeId && turn.status === "running") this.emit(data, { type: "turn.updated", turnId: turn.id, patch: { status: "completed", endedAt: ts } });
      const edge = data.snapshot.delegations.find(entry => entry.toNodeId === permission.nodeId);
      if (edge) {
        const delivered: DelegationRecord = { ...edge, status: "completed", endedAt: ts, deliveredAt: ts, deliveredVia: "turn", result: { status: decision.response.behavior === "allow" ? "success" : "partial", summary: "Command Palette 和键盘导航实现完成。", reported: true, finalText: "实现与验证完成。", artifacts: [{ kind: "file", value: "src/components/SearchPalette.tsx" }], result: { tests: 8, keyboardNavigation: true } } };
        this.emit(data, { type: "delegation.updated", delegationId: edge.id, patch: delivered });
        this.append(data, delivered.fromNodeId, { type: "user_message", text: demoResultsPrompt([delivered]) });
      }
      const rootId = data.snapshot.run.rootNodeId;
      this.append(data, rootId, { type: "assistant_message", text: "所有委派结果已汇总。\n\n- 搜索 API 与中文兼容回退已完成，12 个测试通过。\n- Command Palette 与键盘导航已完成。\n- 安全审查建议均已纳入。\n\n索引子任务的环境问题已通过 LIKE 回退解决。可以继续发消息安排下一轮。" });
      this.emit(data, { type: "node.updated", nodeId: rootId, patch: { status: "idle", activity: "等待下一条消息", updatedAt: ts } });
      for (const turn of data.snapshot.turns) if (turn.nodeId === rootId && turn.status === "running") this.emit(data, { type: "turn.updated", turnId: turn.id, patch: { status: "completed", endedAt: ts } });
      data.remaining = [];
      for (const span of data.snapshot.toolSpans) if (span.status === "running") this.emit(data, { type: "tool.span", span: { ...span, status: "completed", endedAt: ts } });
      this.emit(data, { type: "run.updated", patch: { status: "idle", updatedAt: ts } });
      return;
    }
    throw new Error("该权限请求已处理或不存在");
  }
  async events(runId: string, after: number, onEvent: (event: RunEventEnvelope) => void, signal: AbortSignal): Promise<void> {
    const listener = (event: RunEventEnvelope): void => { if (event.runId === runId && event.seq > after) { after = event.seq; onEvent(structuredClone(event)); } };
    this.listeners.add(listener);
    this.get(runId).log.filter(event => event.seq > after).forEach(listener);
    const timer = setInterval(() => this.advance(), 500);
    await new Promise<void>(resolve => {
      const cleanup = (): void => { clearInterval(timer); this.listeners.delete(listener); resolve(); };
      if (signal.aborted) cleanup(); else signal.addEventListener("abort", cleanup, { once: true });
    });
  }
}
