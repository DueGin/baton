import { applyEvent, emptyUsage, type CreateRunRequest, type DelegationRecord, type GetItemsResponse, type PatchRunRequest, type PermissionDecision, type RunEvent, type RunEventEnvelope, type RunSnapshot, type TimelineItem, type AddMemberRequest, type ReplaceMemberRequest, type ReassignRequest, type TeamPreset, type TeamPresetInput, type SaveTeamPresetRequest, type TeamRecord, type TeamMember, type TeamMemberSpec, type TeamChange, type TeamProposal, type ApproveTeamProposalRequest, type RejectTeamProposalRequest, type InboxItem, type AnswerQuestionRequest, type ResolveEscalationRequest, type PermissionRule, type CreatePermissionRuleRequest, type QuestionRecord, type EscalationRecord, type SendMessageResponse } from "@baton/protocol";
import { richConversation } from "./conversation.js";
import type { BatonClient, TeamPresetResult } from "../api.js";
import { summarize, terminal } from "../lib/derive.js";
import { createScenario, demoAgents } from "./scenario.js";
import { demoBriefPrompt, demoResultsPrompt } from "./prompts.js";
import { snapshotInbox, sortInbox, permissionPattern } from "../lib/inbox.js";
import { matchPermissionRule } from "../lib/permission-rules.js";
import { activeMembers, cleanMember, defaultAgentSpec, pendingProposals, validateMembers, validatePreset } from "../lib/teams.js";

interface DemoRun { snapshot: RunSnapshot; remaining: RunEventEnvelope[]; log: RunEventEnvelope[] }
export class DemoClient implements BatonClient {
  readonly demo = true;
  private data = new Map<string, DemoRun>();
  private listeners = new Set<(event: RunEventEnvelope) => void>();
  private inboxListeners = new Set<() => void>();
  private rules = new Map<string, PermissionRule>();
  private roundExtensions = new Map<string, number>();
  private abandonedMessages = new Set<string>();
  private itemCounters = new Map<string, number>();
  private counter = 0;
  private serial = 0;
  private presets = new Map<string, TeamPreset>();
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
    const ts = new Date(now()).toISOString();
    this.presets.set("preset-product", { id: "preset-product", name: "产品交付小队", description: "Lead 协调，Codex 实现，pi 独立审查。", lead: defaultAgentSpec(demoAgents, "claude"), members: [{ role: "engineer", ...defaultAgentSpec(demoAgents, "codex"), responsibilities: "代码实现和测试" }, { role: "reviewer", ...defaultAgentSpec(demoAgents, "pi"), responsibilities: "只读审查与边界验证" }], createdAt: ts, updatedAt: ts });
    this.rules.set("rule-demo-read", { id: "rule-demo-read", toolName: "read", pattern: "src/**", decision: "allow", scope: "global", agentId: "codex", createdAt: ts, hits: 1, lastHitAt: ts });
    // Keep a second live Run at the approval gate until the human decides.
    void this.createRun({ agent: "claude", cwd: "/workspace/atlas", title: "待确认团队 · 实现登录流程", prompt: "实现登录流程，并独立审查会话安全。", policy: { mode: "dynamic", teamApproval: true } });
    this.setupHumanDemo();
    this.setupConversationDemo();
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
    if (["permission", "question", "escalation", "team.updated", "run.updated", "node.updated"].includes(event.type)) this.inboxListeners.forEach(listener => listener());
    if (event.type === "node.updated" && event.patch.status && terminal(event.patch.status)) {
      for (const row of this.queuedMessages(data, event.nodeId)) {
        this.abandonedMessages.add(`${event.nodeId}:${row.itemSeq}`);
        this.append(data, event.nodeId, { type: "notice", level: "warning", message: "未送达：节点已结束" });
      }
      for (const question of data.snapshot.questions.filter(row => row.nodeId === event.nodeId && row.status === "pending")) this.emit(data, { type: "question", question: { ...question, status: "canceled", answeredAt: envelope.ts } });
    }
  }
  private append(data: DemoRun, nodeId: string, item: TimelineItem): number {
    const seq = this.nextItemSeq(data, nodeId);
    this.emit(data, { type: "item", nodeId, itemSeq: seq, turnId: data.snapshot.turns.findLast(turn => turn.nodeId === nodeId && turn.status === "running")?.id, ts: new Date(this.now()).toISOString(), item });
    return seq;
  }
  private nextItemSeq(data: DemoRun, nodeId: string, count = 1): number {
    const first = Math.max(this.itemCounters.get(nodeId) ?? 0, ...[...data.log, ...data.remaining].filter(event => event.type === "item" && event.nodeId === nodeId).map(event => event.type === "item" ? event.itemSeq : 0)) + 1;
    this.itemCounters.set(nodeId, first + count - 1); return first;
  }
  private advance(): void {
    for (const data of this.data.values()) {
      const ready = data.remaining.filter(event => Date.parse(event.ts) <= this.now());
      data.remaining = data.remaining.filter(event => Date.parse(event.ts) > this.now());
      for (const event of ready) {
        if (terminal(data.snapshot.run.status)) continue;
        this.emit(data, event);
        if (event.type === "turn.updated" && event.patch.status && event.patch.status !== "running") {
          const nodeId = data.snapshot.turns.find(turn => turn.id === event.turnId)?.nodeId;
          if (nodeId) this.deliverQueued(data, nodeId);
        }
        if (event.seq === 0 && event.type === "delegation.updated" && event.patch.deliveredAt) {
          const edge = data.snapshot.delegations.find(entry => entry.id === event.delegationId);
          if (edge && edge.result) this.append(data, edge.fromNodeId, { type: "user_message", text: demoResultsPrompt([edge]) });
        }
      }
      if (ready.some(event => event.seq === 0) && data.snapshot.nodes.every(node => node.status === "idle" || terminal(node.status))) this.emit(data, { type: "run.updated", patch: { status: "idle", updatedAt: new Date(this.now()).toISOString() } });
    }
  }
  async createRun(request: CreateRunRequest): Promise<RunSnapshot> {
    if (request.team?.length && request.team.length > (request.policy?.maxTeamSize ?? 5)) throw new Error("团队人数超过 maxTeamSize");
    const id = `run-local-${++this.counter}`; const ts = new Date(this.now()).toISOString(); const rootNodeId = `${id}:root`;
    const preset = request.teamPresetId ? this.presets.get(request.teamPresetId) : undefined;
    if (request.teamPresetId && !preset) throw new Error("团队预设不存在");
    if (preset && preset.members.length > (request.policy?.maxTeamSize ?? 5)) throw new Error("预设团队人数超过 maxTeamSize");
    const lead = preset?.lead ?? { agentId: request.agent ?? "claude", model: request.model, modeId: request.modeId, thinking: request.thinking };
    const mode = preset ? "preset" : request.policy?.mode ?? "dynamic";
    const snapshot: RunSnapshot = { run: { id, title: request.title || request.prompt.slice(0, 28), status: "active", cwd: request.cwd, rootNodeId, createdAt: ts, updatedAt: ts, policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, teamApproval: true, maxTeamSize: 5, stallMinutes: 10, maxRoundsPerDelegation: 3, ...request.policy, mode }, usage: emptyUsage() }, nodes: [{ id: rootNodeId, runId: id, parentNodeId: null, delegationId: null, depth: 0, ...lead, title: request.title || "处理用户请求", status: "running", activity: "分析任务", cwd: request.cwd, usage: emptyUsage(), turns: 1, createdAt: ts, updatedAt: ts }], turns: [{ id: `${id}:t1`, runId: id, nodeId: rootNodeId, status: "running", trigger: "user", startedAt: ts }], delegations: [], permissions: [], questions: [], escalations: [], toolSpans: [], lastSeq: 0 };
    const data = { snapshot, log: [], remaining: [] }; this.data.set(id, data);
    this.append(data, rootNodeId, { type: "user_message", text: request.prompt });
    this.append(data, rootNodeId, { type: "notice", level: "info", message: "这是浏览器内 demo。消息与操作保存在本次会话中，不会调用本机 agent。" });
    this.append(data, rootNodeId, { type: "assistant_message", text: "收到任务。我会先检查项目结构，再根据工作范围创建委派。\n\n当前为 demo 模式；连接 daemon 后会启动真实 agent。" });
    this.emit(data, { type: "node.updated", nodeId: rootNodeId, patch: { status: "idle", activity: "等待下一条消息" } });
    this.emit(data, { type: "turn.updated", turnId: `${id}:t1`, patch: { status: "completed", endedAt: ts } });
    this.emit(data, { type: "run.updated", patch: { status: "idle" } });
    if (mode !== "solo") {
      const specs = preset?.members ?? request.team;
      if (specs?.length) {
        const issues = validateMembers(specs); if (issues.length) throw new Error(issues.join("；"));
        this.checkTeamSize(data, specs.length);
        const members = specs.map(spec => this.member(spec, preset ? "preset" : "human", "由创建 Run 时指定"));
        const team: TeamRecord = { source: preset ? "preset" : "dynamic", ...(preset ? { presetId: preset.id, presetName: preset.name } : {}), members, proposals: [], changes: [], updatedAt: ts };
        this.teamUpdate(data, team, { kind: "formed", by: preset ? "preset" : "human", at: ts, reason: "创建 Run 时带入名单" });
      } else if (!preset) this.proposeTeam(id, [{ role: "engineer", ...defaultAgentSpec(demoAgents, "codex"), responsibilities: "实现功能与测试" }, ...((request.policy?.maxTeamSize ?? 5) > 1 ? [{ role: "reviewer", ...defaultAgentSpec(demoAgents, "pi"), responsibilities: "独立检查安全和边界" }] : [])], "实现与审查分开，由成员推进；名单确认后开工。");
      else this.teamUpdate(data, { source: "preset", presetId: preset.id, presetName: preset.name, members: [], proposals: [], changes: [], updatedAt: ts }, { kind: "formed", by: "preset", at: ts, reason: "使用无成员预设，由 lead 处理任务" });
    }
    return structuredClone(data.snapshot);
  }
  teams = async (): Promise<TeamPreset[]> => structuredClone([...this.presets.values()]);
  async createTeam(request: TeamPresetInput): Promise<TeamPresetResult> {
    const warnings = this.checkPreset(request); const ts = new Date(this.now()).toISOString(); const id = `preset-${++this.serial}`;
    const preset = { ...structuredClone(request), id, createdAt: ts, updatedAt: ts };
    this.presets.set(id, preset); return { ...structuredClone(preset), warnings };
  }
  async updateTeam(id: string, request: TeamPresetInput): Promise<TeamPresetResult> {
    const warnings = this.checkPreset(request); const old = this.presets.get(id); if (!old) throw new Error("预设不存在");
    const preset = { ...structuredClone(request), id, createdAt: old.createdAt, updatedAt: new Date(this.now()).toISOString() };
    this.presets.set(id, preset); return { ...structuredClone(preset), warnings };
  }
  deleteTeam = async (id: string): Promise<void> => { this.presets.delete(id); };
  private checkPreset(request: TeamPresetInput): string[] {
    const issues = validatePreset(request); if (issues.length) throw new Error(issues.join("；"));
    const warnings: string[] = [];
    for (const id of new Set([request.lead.agentId, ...request.members.map(member => member.agentId)])) {
      const agent = demoAgents.find(entry => entry.id === id); if (!agent) throw new Error(`Unknown agent id: ${id}`);
      if (agent.status !== "ready" || !agent.enabled) warnings.push(`${agent.label} 当前不可用，启动使用此预设的 Run 前需恢复可用状态。`);
    }
    return warnings;
  }
  private member(spec: TeamMemberSpec, addedBy: TeamMember["addedBy"], reason?: string): TeamMember { return { ...cleanMember(spec), id: `member-${++this.serial}`, status: "active", addedBy, addedAt: new Date(this.now()).toISOString(), reason }; }
  private teamUpdate(data: DemoRun, team: TeamRecord, change: TeamChange): void {
    this.emit(data, { type: "team.updated", team: { ...team, changes: [...team.changes, change], updatedAt: change.at }, change });
  }
  private checkTeamSize(data: DemoRun, size: number): void { if (size > (data.snapshot.run.policy.maxTeamSize ?? 5)) throw new Error(`团队人数超过 maxTeamSize (${data.snapshot.run.policy.maxTeamSize ?? 5})`); }
  private teamFor(data: DemoRun): TeamRecord {
    if (data.snapshot.run.policy.mode === "solo") throw new Error("单独完成模式没有团队");
    return data.snapshot.run.team ?? { source: "dynamic", members: [], proposals: [], changes: [], updatedAt: new Date(this.now()).toISOString() };
  }
  async addMember(id: string, request: AddMemberRequest): Promise<void> {
    const data = this.get(id); const team = this.teamFor(data); const issues = validateMembers([...activeMembers(team), request]); if (issues.length) throw new Error(issues.join("；"));
    this.checkTeamSize(data, activeMembers(team).length + 1);
    const member = this.member(request, "human", request.reason);
    this.teamUpdate(data, { ...team, members: [...team.members, member] }, { kind: "member_added", by: "human", memberId: member.id, at: member.addedAt, reason: request.reason });
  }
  async replaceMember(id: string, memberId: string, request: ReplaceMemberRequest): Promise<void> {
    const data = this.get(id); const team = this.teamFor(data); const old = activeMembers(team).find(member => member.id === memberId); if (!old) throw new Error("成员已被替换或移除");
    const next = this.member({ ...request, role: old.role, responsibilities: request.responsibilities ?? old.responsibilities }, "human", request.reason); next.replaces = old.id;
    this.teamUpdate(data, { ...team, members: [...team.members.map(member => member.id === old.id ? { ...member, status: "replaced" as const, replacedBy: next.id, reason: request.reason } : member), next] }, { kind: "member_replaced", by: "human", memberId: next.id, previousMemberId: old.id, reason: request.reason, at: next.addedAt });
    if (request.reassignActive !== false) for (const edge of data.snapshot.delegations.filter(edge => edge.memberId === old.id && !["completed", "canceled", "replaced"].includes(edge.status))) await this.reassign(edge.id, { memberId: next.id, reason: request.reason });
  }
  async removeMember(id: string, memberId: string): Promise<void> {
    const data = this.get(id); const team = this.teamFor(data); const member = activeMembers(team).find(entry => entry.id === memberId); if (!member) throw new Error("成员不再活跃");
    this.teamUpdate(data, { ...team, members: team.members.map(entry => entry.id === memberId ? { ...entry, status: "removed", reason: "由用户移除" } : entry) }, { kind: "member_removed", by: "human", memberId, at: new Date(this.now()).toISOString(), reason: "由用户移除；正在执行的委派继续运行。" });
  }
  async saveTeam(id: string, request: SaveTeamPresetRequest): Promise<TeamPresetResult> {
    const data = this.get(id); const root = data.snapshot.nodes.find(node => node.id === data.snapshot.run.rootNodeId)!;
    return this.createTeam({ ...request, lead: { agentId: root.agentId, model: root.model, modeId: root.modeId, thinking: root.thinking }, members: activeMembers(this.teamFor(data)).map(cleanMember) });
  }
  async reassign(id: string, request: ReassignRequest): Promise<void> {
    const old = await this.delegation(id); const data = this.get(old.runId); const team = this.teamFor(data);
    if (["canceled", "replaced"].includes(old.status)) throw new Error("已取消或替换的委派不能改派");
    let target = activeMembers(team).find(member => member.id === request.memberId);
    if (!target) {
      if (request.memberId || !request.agentId || data.snapshot.run.policy.mode === "preset") throw new Error("请选择活跃团队成员");
      await this.addMember(old.runId, { role: `临时-${++this.serial}`, agentId: request.agentId, model: request.model, modeId: request.modeId, thinking: request.thinking, reason: request.reason });
      target = activeMembers(data.snapshot.run.team).at(-1)!;
    }
    const hasNode = data.snapshot.nodes.some(node => node.id === old.toNodeId);
    const rows = hasNode ? (await this.items(old.toNodeId)).items : [];
    const last = rows.findLast(row => row.item.type === "assistant_message");
    const files = rows.flatMap(row => row.item.type === "tool_call" && (row.item.detail.type === "edit" || row.item.detail.type === "write") ? [row.item.detail.filePath] : []);
    const progress = `${last?.item.type === "assistant_message" ? last.item.text.slice(0, 2000) : "尚无最终回复"}\n修改文件：${[...new Set(files)].join(", ") || "无"}`;
    if (hasNode) await this.cancelNode(old.toNodeId); else this.cancelQueued(data, old);
    const ts = new Date(this.now()).toISOString(); const newId = `delegation-${++this.serial}`;
    if (hasNode) this.emit(data, { type: "node.updated", nodeId: old.toNodeId, patch: { status: "replaced", endedAt: ts, updatedAt: ts, activity: "已改派" } });
    this.emit(data, { type: "delegation.updated", delegationId: old.id, patch: { status: "replaced", replacedBy: newId, replaceReason: request.reason, endedAt: ts } });
    this.queueTask(data, target, { ...old.brief, context: `${old.brief.context ?? ""}\n\n前任进展摘要：\n${progress}` }, undefined, old.fromNodeId, newId, old.id);
    this.notice(data, old.fromNodeId, `任务已改派：${old.id} → ${newId}\n原因：${request.reason ?? "用户要求"}\n前任进展和修改文件已附入任务书。`);
  }
  /** Exposed only on the browser demo, to exercise the same gate without a real agent. */
  proposeTeam(id: string, specs: TeamMemberSpec[], rationale: string): void {
    const data = this.get(id); const team = this.teamFor(data);
    if (pendingProposals(team).length) throw new Error("已有待确认提案，请先处理");
    const issues = validateMembers([...activeMembers(team), ...specs]); if (issues.length) throw new Error(issues.join("；"));
    this.checkTeamSize(data, activeMembers(team).length + specs.length);
    const ts = new Date(this.now()).toISOString();
    if (data.snapshot.run.policy.teamApproval === false) {
      const members = specs.map(spec => this.member(spec, "lead", rationale));
      this.teamUpdate(data, { ...team, rationale, members: [...team.members, ...members] }, { kind: team.members.length ? "member_added" : "formed", by: "lead", at: ts, reason: rationale });
      members.forEach(member => this.queueTask(data, member, { title: `${member.role} · 执行任务`, task: member.responsibilities ?? "执行分配任务" }));
      return;
    }
    const proposal: TeamProposal = { id: `proposal-${++this.serial}`, kind: team.members.length ? "addition" : "formation", status: "pending", by: "lead", nodeId: data.snapshot.run.rootNodeId, proposedAt: ts, rationale, members: specs.map(cleanMember) };
    this.teamUpdate(data, { ...team, rationale, proposals: [...team.proposals, proposal] }, { kind: "proposed", by: "lead", at: ts, reason: rationale, proposalId: proposal.id });
    specs.forEach(spec => this.queueTask(data, spec, { title: `${spec.role} · 执行任务`, task: spec.responsibilities ?? "执行分配任务" }, proposal.id));
    this.notice(data, proposal.nodeId, "组队提案已提交，等待你的名单确认；批准前排队任务不会开工。");
  }
  proposeReplacement(id: string, memberId: string, spec: TeamMemberSpec, reason: string, reassignActive = true): void {
    const data = this.get(id); const team = this.teamFor(data);
    if (pendingProposals(team).length) throw new Error("已有待确认提案，请先处理");
    if (!activeMembers(team).some(member => member.id === memberId)) throw new Error("成员不再活跃");
    if (data.snapshot.run.policy.teamApproval === false) { void this.replaceMember(id, memberId, { ...spec, reason, reassignActive }); return; }
    const ts = new Date(this.now()).toISOString();
    const proposal: TeamProposal = { id: `proposal-${++this.serial}`, kind: "replacement", status: "pending", by: "lead", nodeId: data.snapshot.run.rootNodeId, proposedAt: ts, rationale: reason, replace: { memberId, with: cleanMember(spec), reassignActive, reason } };
    this.teamUpdate(data, { ...team, proposals: [...team.proposals, proposal] }, { kind: "proposed", by: "lead", at: ts, proposalId: proposal.id, reason });
    this.notice(data, proposal.nodeId, `已提交换人提案：${spec.role} → ${spec.agentId}，等待确认。`);
  }
  private queueTask(data: DemoRun, member: TeamMemberSpec, brief: DelegationRecord["brief"], blockedByProposal?: string, parentId = data.snapshot.run.rootNodeId, id = `delegation-${++this.serial}`, replaces?: string): void {
    const ts = new Date(this.now()).toISOString(); const nodeId = `node-${++this.serial}`;
    const memberId = "id" in member && typeof member.id === "string" ? member.id : undefined;

    const edge: DelegationRecord = { id, runId: data.snapshot.run.id, kind: "delegate", fromNodeId: parentId, toNodeId: nodeId, role: member.role, memberId, brief, status: "queued", round: 1, createdAt: ts, subtreeUsage: emptyUsage(), ...(blockedByProposal ? { blockedByProposal } : {}), ...(replaces ? { replaces } : {}) };
    this.emit(data, { type: "delegation.created", delegation: edge });
    if (!blockedByProposal) this.startTask(data, edge, memberId);
  }
  private startTask(data: DemoRun, old: DelegationRecord, memberId?: string): void {
    const { blockedByProposal: _blocked, ...reserved } = old;
    const ts = new Date(this.now()).toISOString(); const member = activeMembers(data.snapshot.run.team).find(entry => entry.id === memberId);
    if (!member) throw new Error("任务需要活跃团队成员");
    const edge = { ...reserved, role: member.role, memberId: member.id }; const turnId = `${edge.toNodeId}:t1`;
    const parent = data.snapshot.nodes.find(node => node.id === edge.fromNodeId)!;
    if (!data.snapshot.nodes.some(node => node.id === edge.toNodeId)) this.emit(data, { type: "node.created", node: { id: edge.toNodeId, runId: edge.runId, parentNodeId: parent.id, delegationId: edge.id, depth: parent.depth + 1, ...cleanMember(member), memberId: member.id, title: edge.brief.title, cwd: parent.cwd, status: "starting", activity: "准备执行", createdAt: ts, updatedAt: ts, usage: emptyUsage(), turns: 0 } });
    this.emit(data, { type: "run.updated", patch: { status: "active", updatedAt: ts } });
    this.emit(data, { type: "delegation.created", delegation: { ...edge, status: "running", startedAt: ts } });
    this.emit(data, { type: "node.updated", nodeId: edge.toNodeId, patch: { ...cleanMember(member), memberId: member.id, status: "running", activity: "执行已批准的任务", turns: 1, updatedAt: ts } });
    this.emit(data, { type: "turn.started", turn: { id: turnId, runId: edge.runId, nodeId: edge.toNodeId, trigger: "delegation", delegationId: edge.id, status: "running", startedAt: ts } });
    this.append(data, edge.toNodeId, { type: "user_message", text: demoBriefPrompt(edge) });
    this.append(data, edge.toNodeId, { type: "assistant_message", text: `以 ${member?.role ?? edge.role} 角色开始执行，先检查现有实现。` });
    const span = { id: `${edge.toNodeId}:check`, runId: edge.runId, nodeId: edge.toNodeId, turnId, callId: "check", name: "shell", kind: "shell", status: "running" as const, summary: "npm test", startedAt: ts };
    this.emit(data, { type: "tool.span", span });
    const end = new Date(this.now() + 12000).toISOString();
    const future: RunEvent[] = [{ type: "tool.span", span: { ...span, status: "completed", endedAt: end } }, { type: "turn.updated", turnId, patch: { status: "completed", endedAt: end } }, { type: "node.updated", nodeId: edge.toNodeId, patch: { status: "completed", activity: "结果已交付", endedAt: end, updatedAt: end } }, { type: "delegation.updated", delegationId: edge.id, patch: { status: "completed", endedAt: end, deliveredAt: end, deliveredVia: "turn", result: { status: "success", summary: "浏览器 demo 任务执行完成，测试通过。", reported: true, finalText: "完成" } } }];
    future.forEach(event => data.remaining.push({ ...event, runId: edge.runId, seq: 0, ts: end }));
  }
  private cancelQueued(data: DemoRun, old: DelegationRecord): void {
    const { blockedByProposal: _blocked, ...edge } = old;
    this.emit(data, { type: "delegation.created", delegation: { ...edge, status: "canceled", endedAt: new Date(this.now()).toISOString() } });
  }
  private notice(data: DemoRun, nodeId: string, text: string): void { this.append(data, nodeId, { type: "user_message", text: `<baton-notice>\n${text}\n</baton-notice>` }); }
  async approveTeam(id: string, proposalId: string, request: ApproveTeamProposalRequest): Promise<void> {
    const data = this.get(id); const team = this.teamFor(data); const proposal = team.proposals.find(entry => entry.id === proposalId && entry.status === "pending"); if (!proposal) throw new Error("提案已处理或不存在");
    if (data.snapshot.run.status === "canceled") throw new Error("Run 已取消");
    const specs = (proposal.kind === "replacement" ? [request.replacement ?? proposal.replace!.with] : request.members ?? proposal.members ?? []).map(cleanMember);
    if (proposal.replace && specs[0]?.role !== proposal.replace.with.role) throw new Error("换人必须保留原角色");
    const issues = validateMembers([...activeMembers(team).filter(member => member.id !== proposal.replace?.memberId), ...specs]); if (issues.length) throw new Error(issues.join("；"));
    this.checkTeamSize(data, activeMembers(team).length - (proposal.replace ? 1 : 0) + specs.length);
    const ts = new Date(this.now()).toISOString(); const members = specs.map(spec => this.member(spec, proposal.by, proposal.rationale));
    this.teamUpdate(data, { ...team, rationale: proposal.rationale ?? team.rationale, members: [...team.members, ...members], proposals: team.proposals.map(entry => entry.id === proposalId ? { ...entry, status: "approved", decidedAt: ts, approvedMembers: proposal.kind !== "replacement" ? specs : undefined, approvedReplacement: proposal.kind === "replacement" ? specs[0] : undefined, feedback: request.note } : entry) }, { kind: "approved", by: "human", at: ts, proposalId, reason: request.note ?? "批准名单" });
    if (!proposal.replace) this.teamUpdate(data, data.snapshot.run.team!, { kind: proposal.kind === "formation" ? "formed" : "member_added", by: proposal.by, at: ts, proposalId, reason: proposal.rationale });
    if (proposal.replace && members[0]) {
      const replacement = members[0];
      const current = data.snapshot.run.team!;
      const next = { ...current, members: current.members.map(member => member.id === proposal.replace!.memberId ? { ...member, status: "replaced" as const, replacedBy: replacement.id } : member.id === replacement.id ? { ...member, replaces: proposal.replace!.memberId } : member) };
      this.teamUpdate(data, next, { kind: "member_replaced", by: "human", at: ts, memberId: replacement.id, previousMemberId: proposal.replace.memberId, reason: request.note ?? proposal.replace.reason });
      if (proposal.replace.reassignActive) for (const edge of data.snapshot.delegations.filter(edge => edge.memberId === proposal.replace!.memberId && !["completed", "canceled", "replaced"].includes(edge.status))) await this.reassign(edge.id, { memberId: replacement.id, reason: request.note ?? proposal.replace.reason });
    }
    for (const edge of data.snapshot.delegations.filter(edge => edge.blockedByProposal === proposalId)) {
      const member = members.find(member => member.role === edge.role);
      if (member) this.startTask(data, edge, member.id); else this.cancelQueued(data, edge);
    }
    const originalSpecs = (proposal.members ?? (proposal.replace ? [proposal.replace.with] : [])).map(cleanMember);
    const originalRoles = originalSpecs.map(member => member.role);
    this.notice(data, proposal.nodeId, `名单已批准。\n原提案：${originalRoles.join("、")}\n生效名单：${specs.map(spec => `${spec.role}=${spec.agentId}/${spec.model ?? "默认模型"}`).join("、")}\n${JSON.stringify(specs) === JSON.stringify(originalSpecs) ? "按原名单批准。" : "已按用户编辑应用名单；删除角色的排队任务已取消。"}\n留言：${request.note ?? "无"}`);
  }
  async rejectTeam(id: string, proposalId: string, request: RejectTeamProposalRequest): Promise<void> {
    if (!request.feedback.trim()) throw new Error("请填写驳回理由");
    const data = this.get(id); const team = this.teamFor(data); const proposal = team.proposals.find(entry => entry.id === proposalId && entry.status === "pending"); if (!proposal) throw new Error("提案已处理或不存在");
    const ts = new Date(this.now()).toISOString();
    this.teamUpdate(data, { ...team, proposals: team.proposals.map(entry => entry.id === proposalId ? { ...entry, status: "rejected", decidedAt: ts, feedback: request.feedback } : entry) }, { kind: "rejected", by: "human", at: ts, proposalId, reason: request.feedback });
    for (const edge of data.snapshot.delegations.filter(edge => edge.blockedByProposal === proposalId)) this.cancelQueued(data, edge);
    this.notice(data, proposal.nodeId, `名单已驳回，所有相关排队委派已取消。\n理由：${request.feedback}`);
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
  async send(nodeId: string, text: string, clientId?: string): Promise<SendMessageResponse> {
    this.advance();
    const data = this.forNode(nodeId); const node = data.snapshot.nodes.find(entry => entry.id === nodeId)!;
    if (node.status === "canceled" || node.status === "replaced") throw new Error("节点已取消或替换，请选择活跃节点");
    const previous = clientId ? data.log.findLast(event => event.type === "item" && event.nodeId === nodeId && event.item.type === "user_message" && event.item.clientId === clientId) : undefined;
    if (previous?.type === "item" && previous.item.type === "user_message") return { accepted: true, delivery: previous.item.delivery ?? "turn", itemSeq: previous.itemSeq };
    const active = data.snapshot.turns.findLast(turn => turn.nodeId === nodeId && turn.status === "running");
    const delivery = active ? demoAgents.find(agent => agent.id === node.agentId)?.capabilities.steer && node.status !== "waiting_permission" ? "steered" : "queued" : "turn";
    const itemSeq = this.append(data, nodeId, { type: "user_message", text, clientId, delivery });
    if (delivery === "turn") {
      this.startReply(data, nodeId, text);
      const turnId = data.snapshot.turns.findLast(turn => turn.nodeId === nodeId && turn.status === "running")?.id;
      this.emit(data, { type: "item", nodeId, itemSeq, turnId, ts: new Date(this.now()).toISOString(), item: { type: "user_message", text, clientId, delivery } });
    }
    return { accepted: true, delivery, itemSeq };
  }
  private startReply(data: DemoRun, nodeId: string, text: string): void {
    const node = data.snapshot.nodes.find(entry => entry.id === nodeId)!;
    const ts = new Date(this.now()).toISOString(); const turnId = `${nodeId}:user-${++this.serial}`;
    this.emit(data, { type: "turn.started", turn: { id: turnId, runId: data.snapshot.run.id, nodeId, trigger: "user", status: "running", startedAt: ts } });
    this.emit(data, { type: "node.updated", nodeId, patch: { status: "running", endedAt: undefined, turns: node.turns + 1, activity: "已发送，等待响应…", updatedAt: ts } });
    if (node.delegationId) this.emit(data, { type: "delegation.updated", delegationId: node.delegationId, patch: { round: (data.snapshot.delegations.find(edge => edge.id === node.delegationId)?.round ?? 1) + 1 } });
    this.emit(data, { type: "run.updated", patch: { status: "active", endedAt: undefined, updatedAt: ts } });
    const first = this.nextItemSeq(data, nodeId, 3);
    const schedule = (seconds: number, event: RunEvent) => data.remaining.push({ ...event, runId: data.snapshot.run.id, seq: 0, ts: new Date(this.now() + seconds * 1000).toISOString() });
    const row = (seconds: number, itemSeq: number, item: TimelineItem) => schedule(seconds, { type: "item", nodeId, itemSeq, turnId, ts, item });
    row(1, first, { type: "reasoning", text: "先确认补充信息对现有计划的影响。" });
    row(3, first, { type: "reasoning", text: "先确认补充信息对现有计划的影响。\n检查当前任务、验收条件和已交付结果，再调整实现。" });
    schedule(4, { type: "node.updated", nodeId, patch: { activity: "思考中…" } });
    const span = { id: `${turnId}:check`, callId: `${turnId}:check`, runId: data.snapshot.run.id, nodeId, turnId, name: "shell", kind: "shell", summary: "npm test", status: "running" as const, startedAt: new Date(this.now() + 6_000).toISOString() };
    schedule(6, { type: "tool.span", span });
    row(6, first + 1, { type: "tool_call", callId: span.callId, name: "shell", status: "running", detail: { type: "shell", command: "npm test" } });
    schedule(10, { type: "tool.span", span: { ...span, status: "completed", endedAt: new Date(this.now() + 10_000).toISOString() } });
    row(10, first + 1, { type: "tool_call", callId: span.callId, name: "shell", status: "completed", detail: { type: "shell", command: "npm test", output: "✓ 12 tests passed", exitCode: 0 } });
    row(11, first + 2, { type: "assistant_message", text: "已收到补充，验证通过。\n\n" });
    row(13, first + 2, { type: "assistant_message", text: `已收到补充：\n\n${text}\n\n- [x] 更新计划\n- [x] 验证通过\n\n这是 demo 回复，可在运行中继续发送消息。` });
    schedule(15, { type: "node.updated", nodeId, patch: { status: "idle", activity: "等待下一条消息", updatedAt: new Date(this.now() + 15_000).toISOString() } });
    schedule(15, { type: "turn.updated", turnId, patch: { status: "completed", endedAt: new Date(this.now() + 15_000).toISOString() } });
    data.remaining.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }
  private queuedMessages(data: DemoRun, nodeId: string) {
    const rows = new Map<number, Extract<RunEventEnvelope, { type: "item" }>>();
    for (const event of data.log) if (event.type === "item" && event.nodeId === nodeId) rows.set(event.itemSeq, event);
    return [...rows.values()].filter(row => row.item.type === "user_message" && row.item.delivery === "queued" && !this.abandonedMessages.has(`${nodeId}:${row.itemSeq}`));
  }
  private deliverQueued(data: DemoRun, nodeId: string): void {
    if (data.snapshot.nodes.some(node => node.id === nodeId && ["canceled", "replaced", "failed", "completed"].includes(node.status))) return;
    const queued = this.queuedMessages(data, nodeId)[0];
    if (queued?.item.type === "user_message") {
      this.startReply(data, nodeId, queued.item.text);
      const turnId = data.snapshot.turns.findLast(turn => turn.nodeId === nodeId && turn.status === "running")?.id;
      this.emit(data, { type: "item", nodeId, itemSeq: queued.itemSeq, turnId, ts: new Date(this.now()).toISOString(), item: { ...queued.item, delivery: "turn" } });
    }
  }
  cancelRun = async (id: string): Promise<void> => { const data = this.get(id); await this.cancelNode(data.snapshot.run.rootNodeId); };
  async cancelNode(nodeId: string): Promise<void> {
    const data = this.forNode(nodeId); const ids = new Set([nodeId]); const ts = new Date(this.now()).toISOString();
    let size = 0; while (size !== ids.size) { size = ids.size; data.snapshot.nodes.forEach(node => { if (node.parentNodeId && ids.has(node.parentNodeId)) ids.add(node.id); }); data.snapshot.delegations.forEach(edge => { if (ids.has(edge.fromNodeId)) ids.add(edge.toNodeId); }); }
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
    for (const edge of data.snapshot.delegations) if (ids.has(edge.toNodeId) && !terminal(edge.status)) {
      if (edge.blockedByProposal) this.cancelQueued(data, edge); else this.emit(data, { type: "delegation.updated", delegationId: edge.id, patch: { status: "canceled", endedAt: ts } });
    }
    for (const escalation of data.snapshot.escalations) if (ids.has(escalation.nodeId) && escalation.status === "pending") this.emit(data, { type: "escalation", escalation: { ...escalation, status: "resolved", resolution: "cancel", resolvedAt: ts } });
    for (const permission of data.snapshot.permissions) if (ids.has(permission.nodeId) && permission.status === "pending") this.emit(data, { type: "permission", permission: { ...permission, status: "expired", resolvedAt: ts } });
    if (ids.has(data.snapshot.run.rootNodeId)) {
      const team = data.snapshot.run.team;
      if (team && pendingProposals(team).length) this.teamUpdate(data, { ...team, proposals: team.proposals.map(proposal => proposal.status === "pending" ? { ...proposal, status: "rejected", decidedAt: ts, feedback: "Run 已取消" } : proposal) }, { kind: "rejected", by: "human", at: ts, reason: "Run 已取消" });
      this.emit(data, { type: "run.updated", patch: { status: "canceled", endedAt: ts, updatedAt: ts } });
    }
  }
  decide = async (requestId: string, decision: PermissionDecision): Promise<void> => {
    if (decision.remember) {
      for (const data of this.data.values()) {
        const permission = data.snapshot.permissions.find(row => row.requestId === requestId && row.status === "pending"); if (!permission) continue;
        const node = data.snapshot.nodes.find(row => row.id === permission.nodeId)!;
        await this.createPermissionRule({ toolName: permission.request.name, pattern: decision.remember.pattern ?? permissionPattern(permission, data.snapshot.run.cwd), decision: decision.response.behavior, scope: decision.remember.scope, ...(decision.remember.scope === "run" ? { runId: permission.runId } : {}), ...(decision.remember.agentOnly ? { agentId: node.agentId } : {}) });
        const saved = [...this.rules.values()].at(-1)!; this.rules.set(saved.id, { ...saved, createdFrom: permission.id });
      }
    }
    await this.resolve(requestId, decision, "human");
  };
  private async resolve(requestId: string, decision: PermissionDecision, by: "human" | "policy" | "rule", ruleId?: string): Promise<void> {
    for (const data of this.data.values()) {
      const permission = data.snapshot.permissions.find(entry => entry.requestId === requestId && entry.status === "pending");
      if (!permission) continue;
      const ts = new Date(this.now()).toISOString();
      this.emit(data, { type: "permission", permission: { ...permission, status: "resolved", resolution: decision.response, resolvedBy: by, ruleId, resolvedAt: ts } });
      if (data.snapshot.run.id !== "run-demo") {
        this.notice(data, permission.nodeId, decision.response.behavior === "allow" ? "授权已允许，继续执行。" : "The human denied this action. Do not retry it; choose a different approach or ask_human.");
        return;
      }
      this.append(data, permission.nodeId, { type: "notice", level: "info", message: decision.response.behavior === "allow" ? "授权已允许，继续执行。" : "The human denied this action. Do not retry it; choose a different approach or ask_human." });
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
      // Resolving the walkthrough's final permission also finishes its integration check.
      for (const node of data.snapshot.nodes.filter(node => node.parentNodeId && !terminal(node.status))) {
        this.emit(data, { type: "node.updated", nodeId: node.id, patch: { status: "completed", endedAt: ts, updatedAt: ts, activity: "验证完成" } });
        for (const turn of data.snapshot.turns.filter(turn => turn.nodeId === node.id && turn.status === "running")) this.emit(data, { type: "turn.updated", turnId: turn.id, patch: { status: "completed", endedAt: ts } });
        const pending = data.snapshot.delegations.find(edge => edge.toNodeId === node.id);
        if (pending) {
          const result: DelegationRecord = { ...pending, status: "completed", endedAt: ts, deliveredAt: ts, deliveredVia: "turn", result: { status: "success", summary: "集成回归验证完成。", reported: true, finalText: "验证完成" } };
          this.emit(data, { type: "delegation.updated", delegationId: pending.id, patch: result });
          this.append(data, result.fromNodeId, { type: "user_message", text: demoResultsPrompt([result]) });
        }
      }
      this.emit(data, { type: "run.updated", patch: { status: "idle", updatedAt: ts } });
      return;
    }
    throw new Error("该权限请求已处理或不存在");
  }
  inbox = async (): Promise<InboxItem[]> => { this.advance(); return structuredClone(sortInbox([...this.data.values()].flatMap(data => snapshotInbox(data.snapshot)))); };
  async inboxEvents(changed: () => void, signal: AbortSignal): Promise<void> {
    this.inboxListeners.add(changed); const timer = setInterval(() => this.advance(), 500);
    await new Promise<void>(resolve => { const cleanup = (): void => { clearInterval(timer); this.inboxListeners.delete(changed); resolve(); }; if (signal.aborted) cleanup(); else signal.addEventListener("abort", cleanup, { once: true }); });
  }
  async answer(id: string, request: AnswerQuestionRequest): Promise<void> {
    if (!request.answer.trim()) throw new Error("请填写回答");
    for (const data of this.data.values()) {
      const question = data.snapshot.questions.find(row => row.id === id && row.status === "pending"); if (!question) continue;
      this.emit(data, { type: "question", question: { ...question, status: "answered", answer: request.answer.trim(), answeredAt: new Date(this.now()).toISOString() } });
      await this.send(question.nodeId, `<baton-answer question="${id}">\n${request.answer.trim()}\n</baton-answer>`); return;
    }
    throw new Error("提问已处理或不存在");
  }
  /** Demo-only provider hook; ask_human is available even in solo runs. */
  askHuman(nodeId: string, input: Pick<QuestionRecord, "question" | "options" | "blocking">): QuestionRecord {
    const data = this.forNode(nodeId); const node = data.snapshot.nodes.find(row => row.id === nodeId)!;
    if (terminal(node.status) || !input.question.trim()) throw new Error("节点已结束或问题为空");
    const question: QuestionRecord = { ...input, question: input.question.trim(), id: `question-${++this.serial}`, nodeId, runId: node.runId, status: "pending", askedAt: new Date(this.now()).toISOString() };
    this.emit(data, { type: "question", question }); return question;
  }
  async resolveEscalation(id: string, request: ResolveEscalationRequest): Promise<void> {
    for (const data of this.data.values()) {
      const escalation = data.snapshot.escalations.find(row => row.id === id && row.status === "pending"); if (!escalation) continue;
      if (request.resolution === "extend" && (escalation.kind !== "round_limit" || !Number.isInteger(request.extraRounds ?? 2) || (request.extraRounds ?? 2) < 1)) throw new Error("仅轮次上限可延长，增加轮次须为正整数");
      this.emit(data, { type: "escalation", escalation: { ...escalation, status: "resolved", resolution: request.resolution, note: request.note, resolvedAt: new Date(this.now()).toISOString() } });
      if (request.resolution === "cancel") await this.cancelNode(escalation.nodeId);
      if (request.resolution === "extend") {
        if (escalation.delegationId) this.roundExtensions.set(escalation.delegationId, (this.roundExtensions.get(escalation.delegationId) ?? 0) + (request.extraRounds ?? 2));
        if (escalation.pendingMessage) {
          for (const turn of data.snapshot.turns.filter(turn => turn.nodeId === escalation.nodeId && turn.status === "running")) this.emit(data, { type: "turn.updated", turnId: turn.id, patch: { status: "completed", endedAt: new Date(this.now()).toISOString() } });
          await this.send(escalation.nodeId, escalation.pendingMessage);
        }
      }
      const edge = data.snapshot.delegations.find(row => row.id === escalation.delegationId);
      this.notice(data, edge?.fromNodeId ?? data.snapshot.run.rootNodeId, `升级已处理：${escalation.kind} · ${request.resolution}\n留言：${request.note ?? "无"}`); return;
    }
    throw new Error("升级已处理或不存在");
  }
  permissionRules = async (): Promise<PermissionRule[]> => structuredClone([...this.rules.values()]);
  async createPermissionRule(request: CreatePermissionRuleRequest): Promise<void> {
    if (!request.toolName.trim() || (request.scope === "run" && !request.runId)) throw new Error("请填写工具名称与 Run");
    if (request.runId) this.get(request.runId);
    const rule = { ...request, toolName: request.toolName.trim(), pattern: request.pattern?.trim() || undefined, id: `rule-${++this.serial}`, createdAt: new Date(this.now()).toISOString(), hits: 0 };
    this.rules.set(rule.id, rule);
  }
  deletePermissionRule = async (id: string): Promise<void> => { this.rules.delete(id); };
  /** Demo hook used to exercise deterministic remembered decisions without a provider. */
  async requestPermission(nodeId: string, permission: import("@baton/protocol").PermissionRecord): Promise<void> {
    const data = this.forNode(nodeId); const node = data.snapshot.nodes.find(row => row.id === nodeId)!;
    this.emit(data, { type: "permission", permission });
    const rule = matchPermissionRule([...this.rules.values()], permission, node.agentId, data.snapshot.run.cwd);
    if (rule) { this.rules.set(rule.id, { ...rule, hits: rule.hits + 1, lastHitAt: new Date(this.now()).toISOString() }); await this.resolve(permission.requestId, { response: { behavior: rule.decision } }, "rule", rule.id); }
    else if (data.snapshot.run.policy.autoApprove) await this.resolve(permission.requestId, { response: { behavior: "allow" } }, "policy");
  }
  private setupHumanDemo(): void {
    void this.createRun({ agent: "claude", cwd: "/workspace/atlas", title: "人工介入 · API 与回归验证", prompt: "实现 API 并检查边界，遇到产品选择时请向我提问。", team: [{ role: "builder", ...defaultAgentSpec(demoAgents, "codex"), responsibilities: "实现 API" }, { role: "tester", ...defaultAgentSpec(demoAgents, "pi"), responsibilities: "验证边界" }], policy: { mode: "dynamic", teamApproval: true } });
    const data = this.get(`run-local-${this.counter}`); const root = data.snapshot.run.rootNodeId;
    const members = activeMembers(data.snapshot.run.team);
    members.forEach(member => this.queueTask(data, member, { title: `${member.role} · 验证实现`, task: member.responsibilities ?? "检查实现" }));
    data.remaining = [];
    const question: QuestionRecord = { id: "demo-question", runId: data.snapshot.run.id, nodeId: root, question: "搜索结果是否需要包含已归档项目？", options: ["默认隐藏，提供筛选", "全部显示"], blocking: true, status: "pending", askedAt: new Date(this.now()).toISOString() };
    this.emit(data, { type: "question", question }); this.append(data, root, { type: "assistant_message", text: question.question });
    const edges = data.snapshot.delegations;
    const stall: EscalationRecord = { id: "demo-stall", runId: data.snapshot.run.id, nodeId: edges[0]!.toNodeId, delegationId: edges[0]!.id, kind: "stall", detail: "builder 已超过 10 分钟没有新活动；最后活动：npm test。可以忽略或取消委派。", status: "pending", createdAt: new Date(this.now()).toISOString() };
    this.emit(data, { type: "escalation", escalation: stall });
    this.emit(data, { type: "escalation", escalation: { id: "demo-round-limit", runId: data.snapshot.run.id, nodeId: edges[1]!.toNodeId, delegationId: edges[1]!.id, kind: "round_limit", detail: "tester 已达到 3 轮，需要你决定是否继续。", pendingMessage: "请补充归档数据的回归测试。", status: "pending", createdAt: new Date(this.now()).toISOString() } });
    this.emit(data, { type: "delegation.updated", delegationId: edges[1]!.id, patch: { round: 3 } });
  }
  private setupConversationDemo(): void {
    const scenario = createScenario(this.now() - 180_000, "run-conversation");
    const root = scenario.initial.run.rootNodeId; const at = (offset: number) => new Date(this.now() + offset).toISOString();
    const seed = scenario.events.reduce(applyEvent, scenario.initial);
    const snapshot: RunSnapshot = { ...seed, run: { ...seed.run, title: "会话体验 · Markdown 与 Mermaid", status: "active", endedAt: undefined, updatedAt: at(-90_000) }, nodes: seed.nodes.filter(node => [root, "run-conversation:review"].includes(node.id)).map(node => ({ ...node, status: "running", endedAt: undefined, activity: "思考中…", updatedAt: at(-65_000) })), turns: [], toolSpans: [], permissions: [], questions: [], escalations: [], delegations: seed.delegations.filter(edge => edge.toNodeId === "run-conversation:review").map(edge => ({ ...edge, status: "running", endedAt: undefined, deliveredAt: undefined, result: undefined })), lastSeq: 0 };
    snapshot.run.usage = snapshot.nodes.reduce((usage, node) => ({ inputTokens: usage.inputTokens + node.usage.inputTokens, cachedInputTokens: usage.cachedInputTokens + node.usage.cachedInputTokens, outputTokens: usage.outputTokens + node.usage.outputTokens, costUsd: usage.costUsd + node.usage.costUsd }), emptyUsage());
    const data: DemoRun = { snapshot, log: [], remaining: [] }; this.data.set(snapshot.run.id, data);
    const history = (secondsAgo: number, event: RunEvent) => {
      const envelope = { ...event, runId: snapshot.run.id, seq: data.snapshot.lastSeq + 1, ts: at(-secondsAgo * 1000) } as RunEventEnvelope;
      data.snapshot = applyEvent(data.snapshot, envelope); data.log.push(envelope);
    };
    history(170, { type: "item", nodeId: root, itemSeq: 1, ts: at(-170_000), item: { type: "user_message", text: "请展示完整 Markdown、Mermaid，以及运行中继续发送消息的体验。", delivery: "turn" } });
    history(140, { type: "item", nodeId: root, itemSeq: 2, ts: at(-140_000), item: { type: "assistant_message", text: richConversation } });
    for (const node of snapshot.nodes) {
      const turnId = `${node.id}:quiet`;
      history(100, { type: "turn.started", turn: { id: turnId, nodeId: node.id, runId: snapshot.run.id, trigger: "user", status: "running", startedAt: at(-100_000) } });
      history(65, { type: "item", nodeId: node.id, itemSeq: node.id === root ? 3 : 1, turnId, ts: at(-65_000), item: { type: "reasoning", text: "正在梳理复杂边界。此 demo 故意保持较长静默，仍会显示本轮计时与无新输出时长。\nClaude 支持插入当前回合；切换到 pi 发送可以体验排队。" } });
      data.remaining.push({ type: "node.updated", nodeId: node.id, patch: { status: "idle", activity: "本轮完成" }, runId: snapshot.run.id, seq: 0, ts: at(45_000) });
      data.remaining.push({ type: "turn.updated", turnId, patch: { status: "completed", endedAt: at(45_000) }, runId: snapshot.run.id, seq: 0, ts: at(45_000) });
    }
    data.remaining.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
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
