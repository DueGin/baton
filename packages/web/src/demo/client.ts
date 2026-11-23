import { applyEvent, emptyUsage, type CreateRunRequest, type DelegationRecord, type GetItemsResponse, type PatchRunRequest, type PermissionDecision, type RunEvent, type RunEventEnvelope, type RunSnapshot, type TimelineItem, type AddMemberRequest, type ReplaceMemberRequest, type ReassignRequest, type TeamPreset, type TeamPresetInput, type SaveTeamPresetRequest, type TeamRecord, type TeamMember, type TeamMemberSpec, type TeamChange, type TeamProposal, type ApproveTeamProposalRequest, type RejectTeamProposalRequest, type InboxItem, type AnswerQuestionRequest, type ResolveEscalationRequest, type PermissionRule, type CreatePermissionRuleRequest, type QuestionRecord, type EscalationRecord, type SendMessageResponse, type SettingsResponse, type UpdateSettingsRequest, type TestTitleModelRequest, type TestTitleModelResponse } from "@baton/protocol";
import { idleScenario } from "./idle.js";
import type { NodeRecord, UpdateNodeConfigRequest, UpdateNodeConfigResponse } from "@baton/protocol";
import { activeTurn, conversationRows } from "../lib/conversation.js";
import { compatibleThinking, findModel, thinkingOptions } from "../lib/models.js";
import type { BackgroundProcess, CancelRunRequest, DismissBackgroundRequest, StopBackgroundRequest, ListBackgroundResponse } from "@baton/protocol";
import { demoBackground } from "./background.js";
import { backgroundActive } from "../lib/background.js";
import type { ProjectRecord, ProjectSummary, CreateProjectRequest, PatchProjectRequest } from "@baton/protocol";
import { demoDirs, demoPath, initialDemoProjects } from "./projects.js";
import { liveProjectSummaries, pathBasename } from "../lib/projects.js";
import { richConversation } from "./conversation.js";
import type { SendMode, DeliverMessageRequest, EditMessageRequest, ReorderQueueRequest, ReorderQueueResponse } from "@baton/protocol";
import { HttpError } from "../api.js";
import type { BatonClient, TeamPresetResult } from "../api.js";
import { summarize, terminal } from "../lib/derive.js";
import { createScenario, demoAgents } from "./scenario.js";
import { agentMessageDemo } from "./messages.js";
import { pullRequestDemo } from "./pull-requests.js";
import { isOpenPr, linkedPullRequests, safePrUrl } from "../lib/pull-requests.js";
import type { PullRequestRecord, ListPullRequestsResponse, LinkPullRequestRequest, PullRequestFeedbackRequest } from "@baton/protocol";
import { demoNoticePrompt, demoBriefPrompt, demoResultsPrompt } from "./prompts.js";
import { snapshotInbox, sortInbox, permissionPattern } from "../lib/inbox.js";
import { matchPermissionRule } from "../lib/permission-rules.js";
import { activeMembers, cleanCandidate, cleanMember, defaultAgentSpec, pendingProposals, validateMembers, validatePreset } from "../lib/teams.js";
import { questionPrompts } from "../lib/questions.js";
import type { RunRecord, TurnTrigger, AttachmentRecord } from "@baton/protocol";
import { demoAttachments, demoLocalImages, drawDemoImage } from "./images.js";
import { attachmentProblem } from "../lib/images.js";
import type { CheckpointChangesResponse, ListCheckpointsResponse, RollbackRequest, RollbackResponse } from "@baton/protocol";
import { demoChanges, demoCheckpointNode, demoCheckpoints, demoRows } from "./rollback.js";

interface DemoRun { snapshot: RunSnapshot; remaining: RunEventEnvelope[]; log: RunEventEnvelope[] }
export class DemoClient implements BatonClient {
  readonly demo = true;
  private data = new Map<string, DemoRun>();
  private listeners = new Set<(event: RunEventEnvelope) => void>();
  private inboxListeners = new Set<() => void>();
  private rules = new Map<string, PermissionRule>();
  private roundExtensions = new Map<string, number>();
  private titleSettings: SettingsResponse = { titleModel: { enabled: true, baseUrl: "http://127.0.0.1:3425/v1", model: "demo-title-model", hasApiKey: false }, github: { ghFound: true, authenticated: true, ghPath: "gh", env: {}, trackMentioned: true } };
  private titleJobs = new Map<string, { at: number; force: boolean }>();
  private prompts = new Map<string, string>();
  private abandonedMessages = new Set<string>();
  private itemCounters = new Map<string, number>();
  private counter = 0;
  private serial = 0;
  private presets = new Map<string, TeamPreset>();
  private projectRecords = new Map<string, ProjectRecord>();
  private pausedNodes = new Map<string, string[]>();
  private heldMessages = new Map<string, string[]>();
  private attachments = new Map<string, { blob: Blob; record: AttachmentRecord }>();
  private attachmentSerial = 0;
  constructor(private readonly now: () => number = Date.now) {
    initialDemoProjects(new Date(now() - 86_400_000).toISOString()).forEach(project => this.projectRecords.set(project.id, project));
    const scenario = createScenario(now() - 86000);
    let snapshot = scenario.initial;
    const log = scenario.events.filter(event => Date.parse(event.ts) <= now());
    for (const event of log) snapshot = applyEvent(snapshot, event);
    snapshot = { ...snapshot, run: { ...snapshot.run, projectId: "project-atlas" } };
    this.data.set(snapshot.run.id, { snapshot, log, remaining: scenario.events.filter(event => Date.parse(event.ts) > now()) });
    const archived = createScenario(now() - 86400000, "run-previous");
    let previous = archived.events.reduce(applyEvent, archived.initial);
    previous = {
      ...previous,
      run: { ...previous.run, title: "梳理项目结构与 API 规范", projectId: "project-archive", cwd: "/workspace/archive", status: "completed", endedAt: archived.at(130) },
      nodes: previous.nodes.map(node => terminal(node.status) ? node : { ...node, status: "completed", activity: "结果已交付", endedAt: archived.at(130), updatedAt: archived.at(130) }),
      turns: previous.turns.map(turn => turn.status === "running" ? { ...turn, status: "completed", endedAt: archived.at(130) } : turn),
      delegations: previous.delegations.map(edge => terminal(edge.status) ? edge : { ...edge, status: "completed", endedAt: archived.at(130), deliveredAt: archived.at(130), deliveredVia: "turn", result: { status: "success", summary: "任务完成，结果已交付。", reported: true, finalText: "实现与验证完成。" } }),
      permissions: previous.permissions.map(permission => ({ ...permission, status: "resolved", resolution: { behavior: "allow" }, resolvedBy: "human", resolvedAt: archived.at(90) })),
    };
    this.data.set(previous.run.id, { snapshot: previous, log: archived.events, remaining: [] });
    const ts = new Date(now()).toISOString();
    this.presets.set("preset-product", { id: "preset-product", name: "产品交付小队", description: "Lead 协调，Codex 实现，pi 独立审查；需要时从候选中招人。", lead: defaultAgentSpec(demoAgents, "claude"), members: [{ role: "engineer", ...defaultAgentSpec(demoAgents, "codex"), responsibilities: "代码实现和测试" }, { role: "reviewer", ...defaultAgentSpec(demoAgents, "pi"), responsibilities: "只读审查与边界验证" }], candidates: [{ agentId: "codex", model: "gpt-5.3-codex", thinking: "high", description: "前端、CSS 动画与交互细节" }, { agentId: "claude", model: "claude-sonnet-4-6", thinking: "high", description: "架构评审、迁移方案与长文档" }, { agentId: "pi", model: "gemini-2.5-pro", thinking: "medium", description: "便宜快速，适合跑测试和批量检查" }], createdAt: ts, updatedAt: ts });
    this.presets.set("preset-pool", { id: "preset-pool", name: "按需招人", description: "不设固定角色，由 lead 按任务从候选中招人。", lead: defaultAgentSpec(demoAgents, "claude"), members: [], candidates: [{ agentId: "codex", model: "gpt-5.3-codex", thinking: "high", description: "实现与重构，适合较大的改动" }, { agentId: "pi", model: "gemini-2.5-pro", description: "便宜快速，适合跑测试" }, { agentId: "qwen", model: "qwen-default", description: "中文文档与界面文案" }], createdAt: ts, updatedAt: ts });
    this.rules.set("rule-demo-read", { id: "rule-demo-read", toolName: "read", pattern: "src/**", decision: "allow", scope: "global", agentId: "codex", createdAt: ts, hits: 1, lastHitAt: ts });
    // Keep a second live Run at the approval gate until the human decides.
    void this.createRun({ projectId: "project-atlas", agent: "claude", cwd: "/workspace/atlas", title: "待确认团队 · 实现登录流程", prompt: "实现登录流程，并独立审查会话安全。", policy: { mode: "dynamic", teamApproval: true } });
    this.setupHumanDemo();
    this.setupConversationDemo();
    this.setupQuestionDemo();
    this.setupCandidateDemo();
    const gallery = agentMessageDemo(now());
    const galleryData: DemoRun = { snapshot: { ...gallery.snapshot, lastSeq: 0 }, log: [], remaining: [] };
    this.data.set(gallery.snapshot.run.id, galleryData);
    gallery.items.forEach(row => this.emit(galleryData, { type: "item", nodeId: row.nodeId, itemSeq: row.seq, itemTs: row.ts, item: row.item }));
    const background = createScenario(now() - 600000, "run-background");
    const backgroundLog = background.events.filter(event => Date.parse(event.ts) <= now());
    const backgroundRun = { snapshot: backgroundLog.reduce(applyEvent, background.initial), log: backgroundLog, remaining: [] };
    this.data.set(backgroundRun.snapshot.run.id, backgroundRun);
    this.emit(backgroundRun, { type: "run.updated", patch: { title: "后台服务 · Vite 与 Python", projectId: "project-atlas", titleSource: "human" } });
    demoBackground(backgroundRun.snapshot, now()).forEach(process => this.emit(backgroundRun, { type: "background", process }));
    const idle = idleScenario(now() - 9_000_000); idle.run.projectId = "project-notes"; idle.run.cwd = "/workspace/notes"; this.data.set(idle.run.id, { snapshot: idle, log: [], remaining: [] });
    const prDemo = pullRequestDemo(now()); const prData: DemoRun = { snapshot: prDemo.snapshot, log: [], remaining: [] }; this.data.set(prDemo.snapshot.run.id, prData);
    prDemo.items.forEach(row => this.emit(prData, { type: "item", nodeId: row.nodeId, itemSeq: row.seq, itemTs: row.ts, item: row.item }));
    prDemo.prs.forEach(pr => this.emit(prData, { type: "pr", pr }));
  }
  agents = async () => structuredClone(demoAgents);
  /** Uploads stay in memory; a short delay shows the pill's uploading state, and a name containing "fail" shows the failed one. */
  uploadAttachment = async (file: Blob, name: string): Promise<AttachmentRecord> => {
    const problem = attachmentProblem(file); if (problem) throw new HttpError(415, problem);
    await new Promise(resolve => setTimeout(resolve, 700));
    if (/fail|失败/i.test(name)) throw new HttpError(500, "演示：上传失败，可点击缩略图重试");
    const record: AttachmentRecord = { id: `att_demo_upload_${++this.attachmentSerial}`, mimeType: file.type, name, size: file.size, createdAt: new Date(this.now()).toISOString() };
    this.attachments.set(record.id, { blob: file, record }); return structuredClone(record);
  };
  attachmentBlob = async (id: string): Promise<Blob> => {
    const stored = this.attachments.get(id); if (stored) return stored.blob;
    const fixture = demoAttachments[id]; if (fixture) return drawDemoImage(fixture.kind);
    throw new HttpError(404, "附件不存在");
  };
  localImageBlob = async (path: string): Promise<Blob> => {
    const kind = demoLocalImages[path]; if (kind) return drawDemoImage(kind);
    throw new HttpError(404, "文件不存在");
  };
  runs = async (projectId?: string) => { this.advance(); return [...this.data.values()].map(data => summarize(data.snapshot)).filter(run => !projectId || run.projectId === projectId).reverse(); };
  dirs = async (path = "~") => demoDirs(path, [...this.projectRecords.values()]);
  projects = async (includeArchived = false): Promise<ProjectSummary[]> => liveProjectSummaries([...this.projectRecords.values()].filter(project => includeArchived || !project.archived).map(project => ({ ...project, exists: true, ...(project.gitRoot ? { gitBranch: "main" } : {}), runCount: 0, activeRunCount: 0, pendingTotal: 0, backgroundCount: 0 })), await this.runs());
  project = async (id: string): Promise<ProjectSummary> => { const project = (await this.projects(true)).find(project => project.id === id); if (!project) throw new Error("项目不存在"); return project; };
  async createProject(request: CreateProjectRequest): Promise<ProjectRecord> {
    const path = demoDirs(request.path, [...this.projectRecords.values()]).path; const old = [...this.projectRecords.values()].find(project => project.path === path);
    if (old) { if (old.archived) return this.patchProject(old.id, { archived: false }); return structuredClone(old); }
    const ts = new Date(this.now()).toISOString(); const project = { id: `project-${++this.serial}`, name: request.name?.trim() || pathBasename(path), path, ...(path === "/workspace/atlas" || path.startsWith("/workspace/atlas/") ? { gitRoot: "/workspace/atlas" } : {}), createdAt: ts, updatedAt: ts };
    this.projectRecords.set(project.id, project); return structuredClone(project);
  }
  async patchProject(id: string, request: PatchProjectRequest): Promise<ProjectSummary> {
    const old = this.projectRecords.get(id); if (!old) throw new Error("项目不存在");
    if (request.archived && (await this.project(id)).activeRunCount > 0) throw new Error("409 · 项目有活跃 Run，无法归档");
    if (request.name !== undefined && !request.name.trim()) throw new Error("项目名称不能为空");
    const project = { ...old, ...request, ...(request.name !== undefined ? { name: request.name.trim() } : {}), updatedAt: new Date(this.now()).toISOString() }; this.projectRecords.set(id, project); return this.project(id);
  }
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
    if (event.type === "item") {
      const { nodeId, itemSeq } = event;
      const previous = data.log.findLast(row => row.type === "item" && row.nodeId === nodeId && row.itemSeq === itemSeq);
      if (previous?.type === "item") event = { ...event, itemTs: previous.itemTs };
    }
    const envelope = { ...event, runId: data.snapshot.run.id, seq: data.snapshot.lastSeq + 1, ts: new Date(this.now()).toISOString() } as RunEventEnvelope;
    data.snapshot = applyEvent(data.snapshot, envelope); data.log.push(envelope);
    this.listeners.forEach(listener => listener(envelope));
    if (["permission", "question", "escalation", "team.updated", "run.updated", "node.updated"].includes(event.type)) this.inboxListeners.forEach(listener => listener());
    if (event.type === "node.updated" && event.patch.status && terminal(event.patch.status)) {
      for (const row of this.queuedMessages(data, event.nodeId)) {
        this.abandonedMessages.add(`${event.nodeId}:${row.itemSeq}`);
        this.append(data, event.nodeId, { type: "notice", level: "warning", message: "未送达：节点已结束" });
      }
      for (const question of data.snapshot.questions.filter(row => row.nodeId === event.nodeId && row.status === "pending")) this.emit(data, { type: "question", question: question.source === "native" ? { ...question, status: "canceled", cancelReason: "节点已结束", answeredAt: envelope.ts } : { ...question, delivery: "async" } });
    }
  }
  private append(data: DemoRun, nodeId: string, item: TimelineItem): number {
    const seq = this.nextItemSeq(data, nodeId);
    this.emit(data, { type: "item", nodeId, itemSeq: seq, turnId: item.type === "user_message" && item.delivery === "queued" ? undefined : data.snapshot.turns.findLast(turn => turn.nodeId === nodeId && turn.status === "running")?.id, itemTs: new Date(this.now()).toISOString(), item });
    return seq;
  }
  private nextItemSeq(data: DemoRun, nodeId: string, count = 1): number {
    const first = Math.max(this.itemCounters.get(nodeId) ?? 0, ...[...data.log, ...data.remaining].filter(event => event.type === "item" && event.nodeId === nodeId).map(event => event.type === "item" ? event.itemSeq : 0)) + 1;
    this.itemCounters.set(nodeId, first + count - 1); return first;
  }
  settings = async (): Promise<SettingsResponse> => structuredClone(this.titleSettings);
  async updateSettings(request: UpdateSettingsRequest): Promise<SettingsResponse> {
    if (request.titleModel === null) { const { titleModel: _old, ...rest } = this.titleSettings; this.titleSettings = rest; }
    else if (request.titleModel) {
      const { apiKey, apiKeyEnv, ...fields } = request.titleModel;
      const old = this.titleSettings.titleModel ?? { enabled: false, baseUrl: "", model: "", hasApiKey: false };
      this.titleSettings = { ...this.titleSettings, titleModel: { ...old, ...fields, hasApiKey: apiKey === undefined ? old.hasApiKey : Boolean(apiKey), apiKeyEnv: apiKeyEnv === null ? undefined : apiKeyEnv ?? old.apiKeyEnv } };
    }
    if (request.github === null) this.titleSettings.github = { ghFound: true, authenticated: true, trackMentioned: true };
    else if (request.github) { this.titleSettings.github = { ...this.titleSettings.github, ghFound: true, authenticated: true, ...structuredClone(request.github) }; if (request.github.ghPath !== undefined && !request.github.ghPath.trim()) delete this.titleSettings.github.ghPath; }
    return this.settings();
  }
  pullRequests = async (projectId?: string, state: "open" | "all" = "open"): Promise<ListPullRequestsResponse> => [...this.data.values()].flatMap(data => linkedPullRequests(data.snapshot).filter(pr => (!projectId || pr.projectId === projectId) && (state === "all" || isOpenPr(pr))).map(pr => ({ ...structuredClone(pr), runTitle: data.snapshot.run.title })));
  private forPr(id: string): { data: DemoRun; pr: PullRequestRecord } {
    for (const data of this.data.values()) { const pr = linkedPullRequests(data.snapshot).find(pr => pr.id === id); if (pr) return { data, pr }; }
    throw new HttpError(404, "PR 不存在或已取消关联");
  }
  async linkPullRequest(runId: string, request: LinkPullRequestRequest): Promise<PullRequestRecord> {
    const data = this.get(runId); const url = safePrUrl(request.url.trim()); if (!url) throw new HttpError(400, "PR URL 无效");
    const parsed = new URL(url); const match = /\/(.+)\/-\/merge_requests\/(\d+)\/?$/.exec(parsed.pathname) ?? /\/([^/]+)\/([^/]+)\/(?:pull|pulls|pull-requests|pr)\/(\d+)\/?$/.exec(parsed.pathname);
    if (!match) throw new HttpError(400, "请输入 PR 或 Merge Request 链接");
    if (request.nodeId && !data.snapshot.nodes.some(node => node.id === request.nodeId)) throw new HttpError(400, "节点不属于本会话");
    const forge = parsed.hostname === "github.com" ? "github" : parsed.pathname.includes("/merge_requests/") ? "gitlab" : "other";
    const repo = match.length === 4 ? `${match[1]}/${match[2]}` : match[1]!; const number = Number(match.at(-1)); const id = `${runId}:${forge}:${repo}#${number}`; const old = data.snapshot.pullRequests?.find(pr => pr.id === id);
    const pr: PullRequestRecord = old ? { ...old, unlinkedAt: undefined } : { id, runId, projectId: data.snapshot.run.projectId, nodeId: request.nodeId, source: "manual", url, forge, repo, number, title: `手动关联 PR #${number}`, state: "open", checks: { state: "pending", total: 1, passed: 0, failed: 0, pending: 1, failedChecks: [] }, createdAt: new Date(this.now()).toISOString() };
    this.emit(data, { type: "pr", pr }); return structuredClone(pr);
  }
  async refreshPullRequest(id: string): Promise<void> {
    const { data, pr } = this.forPr(id);
    this.emit(data, { type: "pr", pr: { ...pr, error: undefined, lastCheckedAt: new Date(this.now()).toISOString(), ...(pr.checks.state === "pending" ? { checks: { ...pr.checks, state: "success", passed: pr.checks.total, pending: 0 } } : {}) } });
  }
  async feedbackPullRequest(id: string, request: PullRequestFeedbackRequest): Promise<void> {
    const { data, pr } = this.forPr(id); const nodeId = request.nodeId ?? pr.nodeId ?? data.snapshot.run.rootNodeId;
    const text = [`PR #${pr.number} ${pr.title ?? ""}\n${pr.url}`, ...(request.include.includes("checks") ? [`CI：${pr.checks.failed} 失败，${pr.checks.pending} 进行中`, ...pr.checks.failedChecks.map(check => `- ${check.name}${check.url ? ` ${check.url}` : ""}`)] : []), ...(request.include.includes("reviews") ? [`评审：${pr.reviewDecision ?? "暂无结论"}`, "请检查边界条件与回归测试，修复后更新 PR。"] : []), request.note ?? ""].filter(Boolean).join("\n");
    await this.send(nodeId, text, undefined, "queue");
    this.emit(data, { type: "pr", pr: { ...pr, lastFeedbackAt: new Date(this.now()).toISOString() } });
  }
  async unlinkPullRequest(id: string): Promise<void> { const { data, pr } = this.forPr(id); this.emit(data, { type: "pr", pr: { ...pr, unlinkedAt: new Date(this.now()).toISOString() } }); }
  async testTitleModel(request: TestTitleModelRequest): Promise<TestTitleModelResponse> {
    const value = { ...this.titleSettings.titleModel, ...request.titleModel };
    if (!value.baseUrl || !value.model) return { ok: false, error: "请填写 Base URL 和 Model", latencyMs: 120 };
    return { ok: true, title: "全局搜索与独立审查", latencyMs: 180 };
  }
  async regenerateTitle(id: string): Promise<void> {
    this.get(id); if (!this.titleSettings.titleModel?.baseUrl || !this.titleSettings.titleModel.model) throw new Error("请先配置标题模型");
    this.titleJobs.set(id, { at: this.now() + 1500, force: true });
  }
  private advance(): void {
    for (const [id, job] of this.titleJobs) if (job.at <= this.now()) {
      this.titleJobs.delete(id); const data = this.get(id);
      if (job.force || data.snapshot.run.titleSource !== "human") this.emit(data, { type: "run.updated", patch: { title: `实现${(this.prompts.get(id) ?? "搜索与协作").slice(0, 12)}`, titleSource: "generated", updatedAt: new Date(this.now()).toISOString() } });
    }
    for (const data of this.data.values()) {
      if (data.snapshot.run.status === "paused") {
        const ready = data.remaining.filter(event => event.type === "background" && Date.parse(event.ts) <= this.now());
        data.remaining = data.remaining.filter(event => !ready.includes(event)); ready.forEach(event => this.emit(data, event)); continue;
      }
      const ready = data.remaining.filter(event => Date.parse(event.ts) <= this.now());
      data.remaining = data.remaining.filter(event => Date.parse(event.ts) > this.now());
      for (const event of ready) {
        if (terminal(data.snapshot.run.status) && event.type !== "background") continue;
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
      if (!terminal(data.snapshot.run.status) && ready.some(event => event.seq === 0 && event.type !== "background") && data.snapshot.nodes.every(node => node.status === "idle" || terminal(node.status))) this.emit(data, { type: "run.updated", patch: { status: "idle", updatedAt: new Date(this.now()).toISOString() } });
    }
  }
  async createRun(request: CreateRunRequest): Promise<RunSnapshot> {
    if (!request.projectId) throw new Error("400 · projectId 必填");
    const project = this.projectRecords.get(request.projectId); if (!project) throw new Error("404 · 项目不存在");
    if (project.archived) throw new Error("400 · 项目已归档");
    const cwd = request.cwd ? demoPath(request.cwd) : project.path;
    if (cwd !== project.path && !cwd.startsWith(`${project.path === "/" ? "" : project.path}/`)) throw new Error("工作目录不能越出项目路径");
    demoDirs(cwd, [...this.projectRecords.values()]);
    if (request.team?.length && request.team.length > (request.policy?.maxTeamSize ?? 5)) throw new Error("团队人数超过 maxTeamSize");
    const id = `run-local-${++this.counter}`; const ts = new Date(this.now()).toISOString(); const rootNodeId = `${id}:root`;
    const preset = request.teamPresetId ? this.presets.get(request.teamPresetId) : undefined;
    if (request.teamPresetId && !preset) throw new Error("团队预设不存在");
    if (preset && preset.members.length > (request.policy?.maxTeamSize ?? 5)) throw new Error("预设团队人数超过 maxTeamSize");
    const lead = preset?.lead ?? { agentId: request.agent ?? "claude", model: request.model, modeId: request.modeId, thinking: request.thinking };
    const mode = preset ? "preset" : request.policy?.mode ?? "dynamic";
    const snapshot: RunSnapshot = { run: { id, projectId: project.id, title: request.title || request.prompt.slice(0, 28), titleSource: request.title ? "human" : "prompt", status: "active", cwd, rootNodeId, createdAt: ts, updatedAt: ts, policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, teamApproval: true, maxTeamSize: 5, stallMinutes: 10, ...request.policy, mode }, usage: emptyUsage() }, nodes: [{ id: rootNodeId, runId: id, parentNodeId: null, delegationId: null, depth: 0, ...lead, title: request.title || "处理用户请求", status: "running", activity: "分析任务", cwd, usage: emptyUsage(), turns: 1, createdAt: ts, updatedAt: ts }], turns: [{ id: `${id}:t1`, runId: id, nodeId: rootNodeId, status: "running", trigger: "user", startedAt: ts }], delegations: [], permissions: [], questions: [], escalations: [], toolSpans: [], lastSeq: 0 };
    const data = { snapshot, log: [], remaining: [] }; this.data.set(id, data);
    this.append(data, rootNodeId, { type: "user_message", text: request.prompt });
    this.append(data, rootNodeId, { type: "notice", level: "info", message: "这是浏览器内 demo。消息与操作保存在本次会话中，不会调用本机 agent。" });
    this.append(data, rootNodeId, { type: "assistant_message", text: "收到任务。我会先检查项目结构，再根据工作范围创建委派。\n\n当前为 demo 模式；连接 daemon 后会启动真实 agent。" });
    this.emit(data, { type: "node.updated", nodeId: rootNodeId, patch: { status: "idle", activity: "等待下一条消息" } });
    this.emit(data, { type: "turn.updated", turnId: `${id}:t1`, patch: { status: "completed", endedAt: ts } });
    this.emit(data, { type: "run.updated", patch: { status: "idle" } });
    const extra = mode === "solo" ? [] : (request.candidates ?? []).filter(candidate => !(preset?.candidates ?? []).some(existing => JSON.stringify(cleanCandidate(existing)) === JSON.stringify(cleanCandidate(candidate))));
    const candidates = [...preset?.candidates ?? [], ...extra].map((candidate, index) => ({ ...cleanCandidate(candidate), id: `c${index + 1}` }));
    const pool = candidates.length ? { candidates } : {};
    if (mode !== "solo") {
      const specs = preset?.members ?? request.team;
      if (specs?.length) {
        const issues = validateMembers(specs); if (issues.length) throw new Error(issues.join("；"));
        this.checkTeamSize(data, specs.length);
        const members = specs.map(spec => this.member(spec, preset ? "preset" : "human", "由创建 Run 时指定"));
        const team: TeamRecord = { source: preset ? "preset" : "dynamic", ...(preset ? { presetId: preset.id, presetName: preset.name } : {}), members, proposals: [], changes: [], ...pool, updatedAt: ts };
        this.teamUpdate(data, team, { kind: "formed", by: preset ? "preset" : "human", at: ts, reason: "创建 Run 时带入名单" });
      } else if (!preset && candidates.length) this.teamUpdate(data, { source: "dynamic", members: [], proposals: [], changes: [], ...pool, updatedAt: ts }, { kind: "formed", by: "human", at: ts, reason: "创建 Run 时带入候选成员" });
      else if (!preset) this.proposeTeam(id, [{ role: "engineer", ...defaultAgentSpec(demoAgents, "codex"), responsibilities: "实现功能与测试" }, ...((request.policy?.maxTeamSize ?? 5) > 1 ? [{ role: "reviewer", ...defaultAgentSpec(demoAgents, "pi"), responsibilities: "独立检查安全和边界" }] : [])], "实现与审查分开，由成员推进；名单确认后开工。");
      else this.teamUpdate(data, { source: "preset", presetId: preset.id, presetName: preset.name, members: [], proposals: [], changes: [], ...pool, updatedAt: ts }, { kind: "formed", by: "preset", at: ts, reason: candidates.length ? "预设只有候选成员，由主导者按任务招人" : "使用无成员预设，由 lead 处理任务" });
    }
    this.prompts.set(id, request.prompt);
    if (!request.title && this.titleSettings.titleModel?.enabled) this.titleJobs.set(id, { at: this.now() + 1500, force: false });
    return structuredClone(data.snapshot);
  }
  teams = async (): Promise<TeamPreset[]> => structuredClone([...this.presets.values()]);
  async createTeam(request: TeamPresetInput): Promise<TeamPresetResult> {
    const warnings = this.checkPreset(request); const ts = new Date(this.now()).toISOString(); const id = `preset-${++this.serial}`;
    const preset = { ...this.cleanPreset(request), id, createdAt: ts, updatedAt: ts };
    this.presets.set(id, preset); return { ...structuredClone(preset), warnings };
  }
  async updateTeam(id: string, request: TeamPresetInput): Promise<TeamPresetResult> {
    const warnings = this.checkPreset(request); const old = this.presets.get(id); if (!old) throw new Error("预设不存在");
    const preset = { ...this.cleanPreset(request), id, createdAt: old.createdAt, updatedAt: new Date(this.now()).toISOString() };
    this.presets.set(id, preset); return { ...structuredClone(preset), warnings };
  }
  deleteTeam = async (id: string): Promise<void> => { this.presets.delete(id); };
  /** Like the daemon: blank candidate fields are dropped and an empty candidate list is omitted. */
  private cleanPreset(request: TeamPresetInput): TeamPresetInput {
    const { candidates, ...rest } = structuredClone(request); const pool = (candidates ?? []).map(cleanCandidate);
    return { ...rest, ...(pool.length ? { candidates: pool } : {}) };
  }
  private checkPreset(request: TeamPresetInput): string[] {
    const issues = validatePreset(request); if (issues.length) throw new Error(issues.join("；"));
    const warnings: string[] = [];
    for (const id of new Set([request.lead.agentId, ...request.members.map(member => member.agentId), ...(request.candidates ?? []).map(candidate => candidate.agentId)])) {
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
    const candidates = (data.snapshot.run.team?.candidates ?? []).map(({ id: _id, ...candidate }) => candidate);
    return this.createTeam({ ...request, lead: { agentId: root.agentId, model: root.model, modeId: root.modeId, thinking: root.thinking }, members: activeMembers(this.teamFor(data)).map(cleanMember), ...(candidates.length ? { candidates } : {}) });
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
  /** Exposed only on the browser demo: the lead hires a preset candidate under a role it names — no roster approval. */
  hireCandidate(id: string, candidateId: string, role: string, brief: DelegationRecord["brief"]): { member: TeamMember; delegationId: string } {
    const data = this.get(id); const team = this.teamFor(data); const name = role.trim();
    const candidate = team.candidates?.find(entry => entry.id === candidateId); if (!candidate) throw new Error(`候选不存在：${candidateId}`);
    if (!name) throw new Error("请为招入的候选命名角色");
    if (activeMembers(team).some(member => member.role === name)) throw new Error(`角色已存在：${name}`);
    this.checkTeamSize(data, activeMembers(team).length + 1);
    const member: TeamMember = { ...this.member({ role: name, agentId: candidate.agentId, model: candidate.model, modeId: candidate.modeId, thinking: candidate.thinking, responsibilities: candidate.description }, "lead", `从预设候选 ${candidate.id} 招入`), candidateId: candidate.id };
    this.teamUpdate(data, { ...team, members: [...team.members, member] }, { kind: "member_added", by: "lead", at: member.addedAt, memberId: member.id, reason: member.reason });
    const delegationId = `delegation-${++this.serial}`; this.queueTask(data, member, brief, undefined, data.snapshot.run.rootNodeId, delegationId);
    return { member, delegationId };
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
    if (data.snapshot.run.status === "paused") { this.emit(data, { type: "delegation.created", delegation: edge }); this.emit(data, { type: "node.updated", nodeId: edge.toNodeId, patch: { status: "idle", activity: "等待会话继续" } }); return; }
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
  private notice(data: DemoRun, nodeId: string, text: string): void {
    const message = demoNoticePrompt("team", text);
    if (data.snapshot.run.status === "paused") this.heldMessages.set(nodeId, [...this.heldMessages.get(nodeId) ?? [], message]);
    else this.append(data, nodeId, { type: "user_message", text: message });
  }
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
    this.emit(data, { type: "run.updated", patch: { ...(request.title !== undefined ? { title: request.title, titleSource: "human" as const } : {}), policy: { ...data.snapshot.run.policy, ...request.policy }, updatedAt: new Date(this.now()).toISOString() } });
    if (request.policy?.autoApprove) for (const permission of data.snapshot.permissions.filter(entry => entry.status === "pending")) await this.resolve(permission.requestId, { response: { behavior: "allow" } }, "policy");
  }
  async updateNodeConfig(nodeId: string, request: UpdateNodeConfigRequest): Promise<UpdateNodeConfigResponse> {
    const data = this.forNode(nodeId);
    const node = data.snapshot.nodes.find(entry => entry.id === nodeId)!;
    if (["canceled", "replaced", "failed"].includes(node.status)) throw new HttpError(409, "该节点已结束，无法修改配置");
    const agent = demoAgents.find(entry => entry.id === node.agentId);
    const model = (request.model === undefined ? node.model : request.model) ?? agent?.models.find(entry => entry.isDefault)?.id;
    if (request.model != null && !findModel(agent, request.model)) throw new HttpError(400, "未知模型");
    if (request.modeId != null && !agent?.modes.some(mode => mode.id === request.modeId)) throw new HttpError(400, "未知权限模式");
    if (request.thinking != null && !thinkingOptions(agent, model).some(level => level.id === request.thinking)) throw new HttpError(400, "当前模型不支持此思考级别");
    const patch: Partial<NodeRecord> = { updatedAt: new Date(this.now()).toISOString() };
    for (const key of ["model", "modeId", "thinking"] as const) if (request[key] !== undefined) patch[key] = request[key] ?? undefined;
    if (request.model !== undefined && request.thinking === undefined && node.thinking && !compatibleThinking(agent, model, node.thinking)) patch.thinking = undefined;
    const applied = activeTurn(data.snapshot, nodeId) ? "next_turn" : "now";
    this.emit(data, { type: "node.updated", nodeId, patch });
    return { node: { ...node, ...patch }, applied };
  }
  async items(nodeId: string, after = 0): Promise<GetItemsResponse> {
    this.advance(); const data = this.forNode(nodeId);
    const rows = new Map<number, GetItemsResponse["items"][number]>();
    for (const event of data.log) if (event.type === "item" && event.nodeId === nodeId) rows.set(event.itemSeq, { seq: event.itemSeq, nodeId, ts: event.itemTs, item: event.item, turnId: event.turnId, ...(event.rolledBack ? { rolledBack: true } : {}) });
    const items = [...rows.values()].filter(row => row.seq > after).sort((a, b) => a.seq - b.seq);
    return structuredClone({ items, lastSeq: items.at(-1)?.seq ?? after });
  }
  async send(nodeId: string, text: string, clientId?: string, mode: SendMode = "queue"): Promise<SendMessageResponse> {
    this.advance();
    const data = this.forNode(nodeId); const node = data.snapshot.nodes.find(entry => entry.id === nodeId)!;
    if (node.status === "canceled" || node.status === "replaced") throw new Error("节点已取消或替换，请选择活跃节点");
    const previous = clientId ? data.log.findLast(event => event.type === "item" && event.nodeId === nodeId && event.item.type === "user_message" && event.item.clientId === clientId) : undefined;
    if (previous?.type === "item" && previous.item.type === "user_message") {
      if (previous.item.delivery === "retracted") throw new HttpError(409, "消息已撤回");
      return { accepted: true, delivery: previous.item.delivery ?? "turn", itemSeq: previous.itemSeq };
    }
    const positions = this.queuedMessages(data, nodeId).map(row => row.item.type === "user_message" ? row.item.queuePosition ?? 0 : 0);
    const itemSeq = this.append(data, nodeId, { type: "user_message", text, clientId, delivery: "queued", queuePosition: Math.max(0, ...positions) + 1 });
    return this.deliverMessage(data, nodeId, itemSeq, mode);
  }
  async deliver(nodeId: string, itemSeq: number, request: DeliverMessageRequest): Promise<SendMessageResponse> {
    this.advance(); return this.deliverMessage(this.forNode(nodeId), nodeId, itemSeq, request.mode);
  }
  private deliverMessage(data: DemoRun, nodeId: string, itemSeq: number, mode: SendMode): SendMessageResponse {
    const node = data.snapshot.nodes.find(entry => entry.id === nodeId)!;
    const row = data.log.findLast(event => event.type === "item" && event.nodeId === nodeId && event.itemSeq === itemSeq);
    if (row?.type !== "item" || row.item.type !== "user_message") throw new HttpError(404, "消息不存在");
    if (!["queued", ...(mode === "interrupt" ? ["steered"] : [])].includes(row.item.delivery ?? "")) throw new HttpError(409, "消息已送达或撤回");
    if (["canceled", "replaced"].includes(node.status)) throw new HttpError(409, "节点已结束");
    const active = data.snapshot.turns.findLast(turn => turn.nodeId === nodeId && turn.status === "running");
    const supported = demoAgents.find(agent => agent.id === node.agentId)?.capabilities.steer === true;
    if (data.snapshot.run.status === "paused") return { accepted: true, delivery: "queued", itemSeq };
    if (active && (mode === "queue" || mode === "steer" && !supported)) return { accepted: true, delivery: "queued", itemSeq, ...(mode === "steer" ? { steerUnsupported: true } : {}) };
    const interrupted = Boolean(active && mode === "interrupt");
    if (interrupted) this.interruptTurn(data, nodeId);
    const delivery = active && mode === "steer" ? "steered" : "turn";
    if (delivery === "turn") this.startReply(data, nodeId, row.item.text);
    const turnId = data.snapshot.turns.findLast(turn => turn.nodeId === nodeId && turn.status === "running")?.id;
    const { queuePosition: _position, steeredAfterSeq: _previousAnchor, ...item } = row.item;
    const anchor = delivery === "steered" ? this.prepareSteer(data, nodeId, turnId!) : undefined;
    this.emit(data, { type: "item", nodeId, itemSeq, turnId, itemTs: row.itemTs, item: { ...item, delivery, ...(interrupted ? { interrupted: true } : {}), ...(anchor !== undefined ? { escalated: true, steeredAfterSeq: anchor } : {}) } });
    if (delivery === "steered") this.appendSteerReply(data, nodeId, turnId!, item.text);
    return { accepted: true, delivery, itemSeq };
  }
  private prepareSteer(data: DemoRun, nodeId: string, turnId: string): number {
    const rows = demoRows(data.log, nodeId);
    const last = conversationRows(rows, [], nodeId).findLast(entry => !entry.row.rolledBack);
    const continued = new Map<number, number>();
    data.remaining = data.remaining.map(event => {
      if (event.type !== "item" || event.nodeId !== nodeId || event.turnId !== turnId) return event;
      const prior = rows.find(row => row.seq === event.itemSeq)?.item;
      if (prior && prior.type !== "reasoning" && prior.type !== "assistant_message") return event;
      const seq = continued.get(event.itemSeq) ?? this.nextItemSeq(data, nodeId);
      continued.set(event.itemSeq, seq);
      if ((event.item.type === "reasoning" || event.item.type === "assistant_message") && prior?.type === event.item.type && event.item.text.startsWith(prior.text)) {
        const text = event.item.text.slice(prior.text.length).trimStart();
        return { ...event, itemSeq: seq, item: { ...event.item, text } };
      }
      return { ...event, itemSeq: seq };
    });
    return last?.row.seq ?? 0;
  }
  private appendSteerReply(data: DemoRun, nodeId: string, turnId: string, text: string): void {
    if (data.remaining.some(event => event.type === "item" && event.nodeId === nodeId && event.turnId === turnId && (event.item.type === "assistant_message" || event.item.type === "reasoning"))) return;
    this.append(data, nodeId, { type: "assistant_message", text: `收到引导，我会按这条补充继续：${text}` });
  }
  async checkpoints(nodeId: string): Promise<ListCheckpointsResponse> {
    this.advance(); const data = this.forNode(nodeId);
    return structuredClone({ checkpoints: demoCheckpoints(data.snapshot, demoRows(data.log, nodeId), nodeId) });
  }
  private checkpoint(id: string) {
    const nodeId = demoCheckpointNode(id), data = nodeId ? this.forNode(nodeId) : undefined;
    const checkpoint = data && nodeId ? demoCheckpoints(data.snapshot, demoRows(data.log, nodeId), nodeId).find(entry => entry.id === id) : undefined;
    if (!data || !checkpoint) throw new HttpError(404, "检查点不存在"); return { data, checkpoint };
  }
  async checkpointChanges(id: string): Promise<CheckpointChangesResponse> {
    const { checkpoint } = this.checkpoint(id);
    await new Promise(resolve => setTimeout(resolve, 120));
    return demoChanges(checkpoint);
  }
  /** Simulated rollback: interrupts the node's turn, flags its rows from the checkpoint on and returns the draft. */
  async rollback(nodeId: string, request: RollbackRequest): Promise<RollbackResponse> {
    this.advance(); const { data, checkpoint } = this.checkpoint(request.checkpointId);
    if (checkpoint.nodeId !== nodeId) throw new HttpError(409, "检查点属于另一个节点");
    if (!["conversation", "files", "both"].includes(request.mode)) throw new HttpError(400, "mode 无效");
    const rows = demoRows(data.log, nodeId), target = rows.find(row => row.seq === checkpoint.itemSeq), conversation = request.mode !== "files";
    if (conversation && target?.rolledBack) throw new HttpError(409, "这条消息已经回退过了");
    await new Promise(resolve => setTimeout(resolve, 200));
    const node = data.snapshot.nodes.find(entry => entry.id === nodeId);
    if (node && ["running", "starting", "waiting_permission"].includes(node.status)) {
      this.interruptTurn(data, nodeId, "interrupted by rollback");
      this.emit(data, { type: "node.updated", nodeId, patch: { status: "idle", activity: "Interrupted by rollback", updatedAt: new Date(this.now()).toISOString() } });
    }
    if (conversation) for (const row of rows.filter(row => row.seq >= checkpoint.itemSeq && !row.rolledBack)) {
      const item = row.item.type === "user_message" && row.item.delivery === "queued" ? (({ queuePosition: _position, ...rest }) => ({ ...rest, delivery: "retracted" as const }))(row.item) : row.item;
      this.emit(data, { type: "item", nodeId, itemSeq: row.seq, turnId: row.turnId, itemTs: row.ts, item, rolledBack: true });
    }
    const files = request.mode !== "conversation" ? demoChanges(checkpoint).files.map(file => file.path) : undefined;
    return { mode: request.mode, ...(conversation ? { draft: target?.item.type === "user_message" ? target.item.text : "", conversation: checkpoint.conversation === "replay" ? "replay" as const : "native" as const, canceledDelegations: [] } : {}), ...(files ? { files } : {}) };
  }
  async retract(nodeId: string, itemSeq: number): Promise<void> {
    this.advance(); const data = this.forNode(nodeId);
    const row = data.log.findLast(event => event.type === "item" && event.nodeId === nodeId && event.itemSeq === itemSeq);
    if (row?.type !== "item" || row.item.type !== "user_message") throw new HttpError(404, "消息不存在");
    if (row.item.delivery !== "queued") throw new HttpError(409, "只有排队消息可以撤回");
    const { queuePosition: _position, ...item } = row.item;
    this.emit(data, { type: "item", nodeId, itemSeq, itemTs: row.itemTs, item: { ...item, delivery: "retracted" } });
  }
  async edit(nodeId: string, itemSeq: number, request: EditMessageRequest): Promise<void> {
    if (!request.text.trim()) throw new HttpError(400, "消息不能为空");
    this.advance(); const data = this.forNode(nodeId);
    const row = data.log.findLast(event => event.type === "item" && event.nodeId === nodeId && event.itemSeq === itemSeq);
    if (row?.type !== "item" || row.item.type !== "user_message") throw new HttpError(404, "消息不存在");
    if (row.item.delivery !== "queued" || ["canceled", "replaced"].includes(data.snapshot.nodes.find(node => node.id === nodeId)!.status)) throw new HttpError(409, "已送达，无法修改");
    this.emit(data, { type: "item", nodeId, itemSeq, itemTs: row.itemTs, item: { ...row.item, text: request.text, editedAt: new Date(this.now()).toISOString() } });
  }
  async reorderQueue(nodeId: string, request: ReorderQueueRequest): Promise<ReorderQueueResponse> {
    this.advance(); const data = this.forNode(nodeId); const queued = this.queuedMessages(data, nodeId);
    const order = request.order;
    if (order.length !== queued.length || new Set(order).size !== order.length || order.some(seq => !queued.some(row => row.itemSeq === seq))) throw new HttpError(409, "队列已变化，请重新拉取");
    order.forEach((seq, index) => {
      const row = queued.find(row => row.itemSeq === seq)!;
      if (row.item.type === "user_message") this.emit(data, { type: "item", nodeId, itemSeq: seq, itemTs: row.itemTs, item: { ...row.item, queuePosition: index + 1 } });
    });
    return { order: [...order] };
  }
  private interruptTurn(data: DemoRun, nodeId: string, reason = "interrupted by human message"): void {
    const ts = new Date(this.now()).toISOString();
    const turnIds = new Set(data.snapshot.turns.filter(turn => turn.nodeId === nodeId && turn.status === "running").map(turn => turn.id));
    data.remaining = data.remaining.filter(event => {
      if ("nodeId" in event && event.nodeId === nodeId) return false;
      if (event.type === "tool.span" && event.span.nodeId === nodeId) return false;
      if (event.type === "turn.updated" && turnIds.has(event.turnId)) return false;
      if (event.type === "turn.started" && event.turn.nodeId === nodeId) return false;
      if (event.type === "delegation.updated" && data.snapshot.delegations.some(edge => edge.id === event.delegationId && edge.toNodeId === nodeId)) return false;
      return true;
    });
    for (const id of turnIds) this.emit(data, { type: "turn.updated", turnId: id, patch: { status: "canceled", error: reason, endedAt: ts } });
    for (const span of data.snapshot.toolSpans) if (span.nodeId === nodeId && span.status === "running") this.emit(data, { type: "tool.span", span: { ...span, status: "canceled", endedAt: ts } });
    for (const question of data.snapshot.questions.filter(question => question.nodeId === nodeId && question.status === "pending" && question.delivery === "inline")) this.emit(data, { type: "question", question: question.source === "native" ? { ...question, status: "canceled", cancelReason: data.snapshot.run.status === "paused" ? "会话已暂停" : "回合已中断", answeredAt: ts } : { ...question, delivery: "async" } });
  }
  private startReply(data: DemoRun, nodeId: string, text: string, trigger: TurnTrigger = "user"): void {
    const node = data.snapshot.nodes.find(entry => entry.id === nodeId)!;
    const ts = new Date(this.now()).toISOString(); const turnId = `${nodeId}:user-${++this.serial}`;
    this.emit(data, { type: "turn.started", turn: { id: turnId, runId: data.snapshot.run.id, nodeId, trigger, status: "running", startedAt: ts } });
    this.emit(data, { type: "node.updated", nodeId, patch: { status: "running", endedAt: undefined, turns: node.turns + 1, activity: "已发送，等待响应…", updatedAt: ts } });
    if (node.delegationId) this.emit(data, { type: "delegation.updated", delegationId: node.delegationId, patch: { round: (data.snapshot.delegations.find(edge => edge.id === node.delegationId)?.round ?? 1) + 1 } });
    this.emit(data, { type: "run.updated", patch: { status: "active", endedAt: undefined, updatedAt: ts } });
    const first = this.nextItemSeq(data, nodeId, 3);
    const schedule = (seconds: number, event: RunEvent) => data.remaining.push({ ...event, runId: data.snapshot.run.id, seq: 0, ts: new Date(this.now() + seconds * 1000).toISOString() });
    const row = (seconds: number, itemSeq: number, item: TimelineItem) => schedule(seconds, { type: "item", nodeId, itemSeq, turnId, itemTs: new Date(this.now() + seconds * 1000).toISOString(), item });
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
    return [...rows.values()].filter(row => row.item.type === "user_message" && row.item.delivery === "queued" && !this.abandonedMessages.has(`${nodeId}:${row.itemSeq}`)).sort((a, b) => (a.item.type === "user_message" ? a.item.queuePosition ?? a.itemSeq : a.itemSeq) - (b.item.type === "user_message" ? b.item.queuePosition ?? b.itemSeq : b.itemSeq));
  }
  private deliverQueued(data: DemoRun, nodeId: string): void {
    if (data.snapshot.run.status === "paused") return;
    if (data.snapshot.nodes.some(node => node.id === nodeId && ["canceled", "replaced", "failed", "completed"].includes(node.status))) return;
    const queued = this.queuedMessages(data, nodeId);
    if (queued.length) {
      this.startReply(data, nodeId, queued.map(row => row.item.type === "user_message" ? row.item.text : "").join("\n\n"));
      const turnId = data.snapshot.turns.findLast(turn => turn.nodeId === nodeId && turn.status === "running")?.id;
      for (const [index, row] of queued.entries()) if (row.item.type === "user_message") {
        const { queuePosition: _position, ...item } = row.item;
        this.emit(data, { type: "item", nodeId, itemSeq: row.itemSeq, turnId, itemTs: row.itemTs, item: { ...item, delivery: "turn", ...(queued.length > 1 ? { deliveryOrder: index + 1 } : {}) } });
      }
    }
  }
  background = async (status: "running" | "all" = "running"): Promise<ListBackgroundResponse> => {
    this.advance(); return structuredClone([...this.data.values()].flatMap(data => (data.snapshot.backgroundProcesses ?? []).filter(process => status === "all" || backgroundActive(process)).map(process => ({ ...process, runTitle: data.snapshot.run.title }))));
  };
  private backgroundEntry(id: string): { data: DemoRun; process: BackgroundProcess } {
    for (const data of this.data.values()) { const process = data.snapshot.backgroundProcesses?.find(process => process.id === id); if (process) return { data, process }; }
    throw new Error("后台进程不存在");
  }
  async stopBackground(id: string, request: StopBackgroundRequest = {}): Promise<void> {
    const { data, process } = this.backgroundEntry(id); if (process.status !== "running") return;
    this.emit(data, { type: "background", process: { ...process, status: "stopping", stoppedBy: "human" } });
    const ts = new Date(this.now() + Math.min(request.graceMs ?? 1500, 5000)).toISOString();
    data.remaining.push({ type: "background", process: { ...process, status: "exited", stoppedBy: "human", exitedAt: ts, lastSeenAt: ts }, runId: data.snapshot.run.id, seq: 0, ts });
    data.remaining.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }
  async dismissBackground(id: string, request: DismissBackgroundRequest): Promise<void> {
    const { data, process } = this.backgroundEntry(id);
    data.remaining = data.remaining.map(event => event.type === "background" && event.process.id === id ? { ...event, process: { ...event.process, dismissed: request.dismissed } } : event);
    this.emit(data, { type: "background", process: { ...process, dismissed: request.dismissed } });
  }
  cancelRun = async (id: string, request: CancelRunRequest = {}): Promise<void> => {
    const data = this.get(id); if (request.stopBackground) for (const process of data.snapshot.backgroundProcesses ?? []) if (backgroundActive(process)) await this.stopBackground(process.id);
    await this.cancelNode(data.snapshot.run.rootNodeId);
  };
  async pauseRun(id: string): Promise<RunRecord> {
    this.advance(); const data = this.get(id); if (data.snapshot.run.status === "paused") return structuredClone(data.snapshot.run);
    if (terminal(data.snapshot.run.status)) throw new HttpError(409, "会话已结束");
    const ts = new Date(this.now()).toISOString(); const nodes = [...new Set(data.snapshot.turns.filter(turn => turn.status === "running").map(turn => turn.nodeId))];
    this.pausedNodes.set(id, nodes);
    this.emit(data, { type: "run.updated", patch: { status: "paused", updatedAt: ts, pauses: [...data.snapshot.run.pauses ?? [], { at: ts, by: "human" }] } });
    for (const nodeId of nodes) { this.interruptTurn(data, nodeId); this.emit(data, { type: "node.updated", nodeId, patch: { status: "idle", activity: "会话已暂停", updatedAt: ts } }); }
    for (const turn of data.snapshot.turns.filter(turn => turn.error === "interrupted by human message" && turn.endedAt === ts && nodes.includes(turn.nodeId))) this.emit(data, { type: "turn.updated", turnId: turn.id, patch: { error: "paused by human" } });
    for (const permission of data.snapshot.permissions.filter(permission => permission.status === "pending")) this.emit(data, { type: "permission", permission: { ...permission, status: "expired", resolvedAt: ts } });
    for (const question of data.snapshot.questions.filter(question => question.status === "pending" && question.delivery === "inline")) this.emit(data, { type: "question", question: question.source === "native" ? { ...question, status: "canceled", cancelReason: "会话已暂停", answeredAt: ts } : { ...question, delivery: "async" } });
    return structuredClone(data.snapshot.run);
  }
  async resumeRun(id: string): Promise<RunRecord> {
    const data = this.get(id); if (data.snapshot.run.status !== "paused") throw new HttpError(409, "会话未暂停");
    const ts = new Date(this.now()).toISOString(); const pauses = (data.snapshot.run.pauses ?? []).map(pause => pause.resumedAt ? pause : { ...pause, resumedAt: ts });
    this.emit(data, { type: "run.updated", patch: { status: "active", pauses, updatedAt: ts } });
    const nodes = this.pausedNodes.get(id) ?? []; this.pausedNodes.delete(id);
    for (const node of data.snapshot.nodes) {
      if (terminal(node.status)) continue;
      const queued = this.queuedMessages(data, node.id); const held = this.heldMessages.get(node.id) ?? []; this.heldMessages.delete(node.id);
      if (nodes.includes(node.id)) {
        const notice = demoNoticePrompt("system", "The human paused this run and has now resumed it. Continue where you left off.");
        this.append(data, node.id, { type: "user_message", text: [notice, ...held].join("\n\n") });
        this.startReply(data, node.id, [notice, ...held, ...queued.map(row => row.item.type === "user_message" ? row.item.text : "")].join("\n\n"), "resume");
        const turnId = data.snapshot.turns.findLast(turn => turn.nodeId === node.id && turn.status === "running")!.id;
        for (const [index, row] of queued.entries()) if (row.item.type === "user_message") { const { queuePosition: _position, ...item } = row.item; this.emit(data, { type: "item", nodeId: node.id, itemSeq: row.itemSeq, itemTs: row.itemTs, turnId, item: { ...item, delivery: "turn", ...(queued.length > 1 ? { deliveryOrder: index + 1 } : {}) } }); }
      } else {
        held.forEach(text => this.append(data, node.id, { type: "user_message", text }));
        if (queued.length) this.deliverQueued(data, node.id);
        else if (held.length) this.startReply(data, node.id, held.join("\n\n"), "result");
      }
    }
    for (const edge of data.snapshot.delegations.filter(edge => edge.status === "queued" && !edge.blockedByProposal)) this.startTask(data, edge, edge.memberId);
    return structuredClone(data.snapshot.run);
  }
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
      for (const question of data.snapshot.questions.filter(question => question.status === "pending")) this.emit(data, { type: "question", question: { ...question, status: "canceled", cancelReason: "会话已取消", answeredAt: ts } });
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
  async declineQuestion(id: string): Promise<void> {
    for (const data of this.data.values()) {
      const question = data.snapshot.questions.find(row => row.id === id && row.status === "pending"); if (!question) continue;
      this.emit(data, { type: "question", question: { ...question, status: "canceled", cancelReason: "用户选择不作答", declinedAt: new Date(this.now()).toISOString() } });
      if (question.delivery === "inline") {
        const tool = data.log.findLast(event => event.type === "item" && event.nodeId === question.nodeId && event.item.type === "tool_call" && event.item.callId === question.anchor?.callId);
        if (tool?.type === "item" && tool.item.type === "tool_call") this.emit(data, { type: "item", nodeId: question.nodeId, itemSeq: tool.itemSeq, itemTs: tool.itemTs, turnId: tool.turnId, item: { ...tool.item, status: "completed" } });
        const seq = this.append(data, question.nodeId, { type: "assistant_message", text: "没有收到回答，我按默认方案继续…" }); const turnId = question.anchor?.turnId;
        data.remaining.push({ type: "item", nodeId: question.nodeId, itemSeq: seq, itemTs: new Date(this.now()).toISOString(), turnId, item: { type: "assistant_message", text: "没有收到回答，我按默认方案继续：搜索范围取**当前项目**，验证覆盖中文与权限。" }, seq: 0, runId: question.runId, ts: new Date(this.now() + 2000).toISOString() });
        if (turnId) data.remaining.push({ type: "turn.updated", turnId, patch: { status: "completed", endedAt: new Date(this.now() + 3000).toISOString() }, seq: 0, runId: question.runId, ts: new Date(this.now() + 3000).toISOString() }, { type: "node.updated", nodeId: question.nodeId, patch: { status: "idle", activity: "等待下一条消息" }, seq: 0, runId: question.runId, ts: new Date(this.now() + 3000).toISOString() });
        data.remaining.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      } else await this.send(question.nodeId, `<baton-answer question="${id}" declined="true">\n用户选择不作答。\n</baton-answer>`); return;
    }
    throw new Error("提问已处理或不存在");
  }
  async answer(id: string, request: AnswerQuestionRequest): Promise<void> {
    if (!request.answer?.trim() && !Object.values(request.answers ?? {}).some(values => values.some(value => value.trim()))) throw new Error("请填写回答");
    for (const data of this.data.values()) {
      const question = data.snapshot.questions.find(row => row.id === id && row.status === "pending"); if (!question) continue;
      const prompts = questionPrompts(question); const answers = request.answers ?? { [prompts[0]!.id]: [request.answer!.trim()] };
      if (prompts.some(prompt => !answers[prompt.id]?.some(value => value.trim()) || !prompt.multiSelect && answers[prompt.id]!.length > 1 || !prompt.allowFreeText && answers[prompt.id]!.some(value => !prompt.options.some(option => option.label === value)))) throw new Error("请回答全部问题");
      const summary = request.answer?.trim() ?? prompts.map(prompt => `${prompts.length > 1 ? `${prompt.header ?? prompt.question}：` : ""}${answers[prompt.id]!.join("、")}`).join("\n");
      this.emit(data, { type: "question", question: { ...question, status: "answered", answer: summary, answers, answeredAt: new Date(this.now()).toISOString() } });
      if (question.delivery === "inline") {
        const tool = data.log.findLast(event => event.type === "item" && event.nodeId === question.nodeId && event.item.type === "tool_call" && event.item.callId === question.anchor?.callId);
        if (tool?.type === "item" && tool.item.type === "tool_call") this.emit(data, { type: "item", nodeId: question.nodeId, itemSeq: tool.itemSeq, itemTs: tool.itemTs, turnId: tool.turnId, item: { ...tool.item, status: "completed" } });
        const seq = this.append(data, question.nodeId, { type: "assistant_message", text: "已收到回答，继续执行…" }); const turnId = question.anchor?.turnId;
        data.remaining.push({ type: "item", nodeId: question.nodeId, itemSeq: seq, itemTs: new Date(this.now()).toISOString(), turnId, item: { type: "assistant_message", text: `已收到回答，继续执行。\n\n${summary}\n\n- [x] 根据回答调整计划\n- [x] 完成验证` }, seq: 0, runId: question.runId, ts: new Date(this.now() + 2000).toISOString() });
        if (turnId) data.remaining.push({ type: "turn.updated", turnId, patch: { status: "completed", endedAt: new Date(this.now() + 3000).toISOString() }, seq: 0, runId: question.runId, ts: new Date(this.now() + 3000).toISOString() }, { type: "node.updated", nodeId: question.nodeId, patch: { status: "idle", activity: "等待下一条消息" }, seq: 0, runId: question.runId, ts: new Date(this.now() + 3000).toISOString() });
        data.remaining.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      } else await this.send(question.nodeId, `<baton-answer question="${id}">\n${summary}\n</baton-answer>`); return;
    }
    throw new Error("提问已处理或不存在");
  }
  /** Demo-only provider hook; ask_human is available even in solo runs. */
  askHuman(nodeId: string, input: Pick<QuestionRecord, "question" | "options" | "blocking">): QuestionRecord {
    const data = this.forNode(nodeId); const node = data.snapshot.nodes.find(row => row.id === nodeId)!;
    if (terminal(node.status) || !input.question.trim()) throw new Error("节点已结束或问题为空");
    const question: QuestionRecord = { ...input, source: "ask_human", delivery: "async", question: input.question.trim(), id: `question-${++this.serial}`, nodeId, runId: node.runId, status: "pending", askedAt: new Date(this.now()).toISOString() };
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
    void this.createRun({ projectId: "project-atlas", agent: "claude", cwd: "/workspace/atlas", title: "人工介入 · API 与回归验证", prompt: "实现 API 并检查边界，遇到产品选择时请向我提问。", team: [{ role: "builder", ...defaultAgentSpec(demoAgents, "codex"), responsibilities: "实现 API" }, { role: "tester", ...defaultAgentSpec(demoAgents, "pi"), responsibilities: "验证边界" }], policy: { maxRoundsPerDelegation: 3, mode: "dynamic", teamApproval: true } });
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
  /** A preset run whose lead matches the task to a candidate's model and description and hires it. */
  private setupCandidateDemo(): void {
    void this.createRun({ projectId: "project-atlas", teamPresetId: "preset-product", cwd: "/workspace/atlas", title: "候选成员 · 主导者按需招人", prompt: "给设置页的主题切换加上过渡动画，并补充回归测试。" });
    const data = this.get(`run-local-${this.counter}`); const root = data.snapshot.run.rootNodeId;
    this.append(data, root, { type: "assistant_message", text: "过渡动画是前端交互细节：候选 **c1**（codex · gpt-5.3-codex · high，擅长前端、CSS 动画）最匹配，招入为 `motion` 角色；回归测试交给固定角色 `engineer`。" });
    const brief = { title: "主题切换过渡动画", task: "为设置页的主题切换加入颜色过渡动画，尊重 prefers-reduced-motion。", acceptance: ["切换无闪烁", "减少动态效果时无动画"] };
    const { delegationId } = this.hireCandidate(data.snapshot.run.id, "c1", "motion", brief);
    const edge = data.snapshot.delegations.find(entry => entry.id === delegationId)!;
    this.append(data, root, { type: "tool_call", callId: "hire-c1", name: "mcp__baton__delegate", status: "completed", detail: { type: "baton", tool: "delegate", input: { candidate: "c1", role: "motion", ...brief }, output: { delegationId, nodeId: edge.toNodeId, status: "queued" } } });
    const engineer = activeMembers(data.snapshot.run.team).find(member => member.role === "engineer")!;
    this.queueTask(data, engineer, { title: "主题切换回归测试", task: "补充主题切换的回归测试，覆盖亮色、暗色和跟随系统。" });
  }
  private setupQuestionDemo(): void {
    const scenario = createScenario(this.now() - 120_000, "run-questions"); const seed = scenario.events.reduce(applyEvent, scenario.initial);
    const root = seed.nodes[0]!; const child = seed.nodes.find(node => node.agentId === "pi")!; const ts = new Date(this.now()).toISOString();
    const snapshot: RunSnapshot = { ...seed, run: { ...seed.run, projectId: "project-notes", cwd: "/workspace/notes", title: "内联问答 · 选择后继续执行", status: "active", endedAt: undefined, updatedAt: ts }, nodes: [root, child].map(node => ({ ...node, cwd: "/workspace/notes", status: "running", endedAt: undefined, turns: 1, activity: "等你回答", updatedAt: ts })), delegations: seed.delegations.filter(edge => edge.toNodeId === child.id).map(edge => ({ ...edge, status: "running", endedAt: undefined, deliveredAt: undefined, result: undefined })), turns: [], toolSpans: [], permissions: [], questions: [], escalations: [], lastSeq: 0 };
    snapshot.run.usage = snapshot.nodes.reduce((usage, node) => ({ inputTokens: usage.inputTokens + node.usage.inputTokens, cachedInputTokens: usage.cachedInputTokens + node.usage.cachedInputTokens, outputTokens: usage.outputTokens + node.usage.outputTokens, costUsd: usage.costUsd + node.usage.costUsd }), emptyUsage());
    const data: DemoRun = { snapshot, log: [], remaining: [] }; this.data.set(snapshot.run.id, data);
    for (const node of snapshot.nodes) {
      const turnId = `${node.id}:ask`; const native = node.id === root.id; const callId = `${node.id}:question`;
      this.emit(data, { type: "turn.started", turn: { id: turnId, nodeId: node.id, runId: snapshot.run.id, trigger: "user", status: "running", startedAt: ts } });
      this.append(data, node.id, { type: "assistant_message", text: native ? "先确认两个产品选择，再继续实现。" : "我会在你的回答后，沿着这张卡片继续给出审查结果。" });
      const itemSeq = this.append(data, node.id, { type: "tool_call", callId, name: native ? "AskUserQuestion" : "mcp__baton__ask_human", status: "running", detail: { type: "unknown", input: { question: "请确认实现方案" }, output: null } });
      const prompts = native ? [{ id: "scope", header: "范围", question: "搜索默认范围是什么？", options: [{ label: "当前项目", description: "只搜索本项目，响应更快。" }, { label: "所有项目", description: "跨项目搜索，需要展示归属。" }], allowFreeText: true }, { id: "checks", header: "验证", question: "需要覆盖哪些验证？", options: [{ label: "中文", description: "验证中文关键词。" }, { label: "权限", description: "确认跨项目边界。" }, { label: "性能", description: "检查索引查询耗时。" }], multiSelect: true, allowFreeText: true }] : [{ id: "q1", header: "审查重点", question: "是否有需要优先检查的风险？", options: [{ label: "输入校验" }, { label: "访问权限" }], allowFreeText: true }];
      this.emit(data, { type: "question", question: { id: `${node.id}:q`, nodeId: node.id, runId: snapshot.run.id, question: prompts.map(prompt => prompt.question).join("\n"), prompts, source: native ? "native" : "ask_human", delivery: "inline", blocking: true, status: "pending", anchor: { itemSeq, callId, turnId }, askedAt: ts } });
    }
  }
  private setupConversationDemo(): void {
    const scenario = createScenario(this.now() - 180_000, "run-conversation");
    const root = scenario.initial.run.rootNodeId; const at = (offset: number) => new Date(this.now() + offset).toISOString();
    const seed = scenario.events.reduce(applyEvent, scenario.initial);
    const snapshot: RunSnapshot = { ...seed, run: { ...seed.run, title: "会话体验 · Markdown 与 Mermaid", projectId: "project-notes", cwd: "/workspace/notes", status: "active", endedAt: undefined, updatedAt: at(-90_000) }, nodes: seed.nodes.filter(node => [root, "run-conversation:review"].includes(node.id)).map(node => ({ ...node, cwd: "/workspace/notes", status: "running", endedAt: undefined, activity: "思考中…", updatedAt: at(-65_000) })), turns: [], toolSpans: [], permissions: [], questions: [], escalations: [], delegations: seed.delegations.filter(edge => edge.toNodeId === "run-conversation:review").map(edge => ({ ...edge, status: "running", endedAt: undefined, deliveredAt: undefined, result: undefined })), lastSeq: 0 };
    snapshot.run.usage = snapshot.nodes.reduce((usage, node) => ({ inputTokens: usage.inputTokens + node.usage.inputTokens, cachedInputTokens: usage.cachedInputTokens + node.usage.cachedInputTokens, outputTokens: usage.outputTokens + node.usage.outputTokens, costUsd: usage.costUsd + node.usage.costUsd }), emptyUsage());
    const data: DemoRun = { snapshot, log: [], remaining: [] }; this.data.set(snapshot.run.id, data);
    const history = (secondsAgo: number, event: RunEvent) => {
      const envelope = { ...event, runId: snapshot.run.id, seq: data.snapshot.lastSeq + 1, ts: at(-secondsAgo * 1000) } as RunEventEnvelope;
      data.snapshot = applyEvent(data.snapshot, envelope); data.log.push(envelope);
    };
    history(170, { type: "item", nodeId: root, itemSeq: 1, itemTs: at(-170_000), item: { type: "user_message", text: "请展示完整 Markdown、Mermaid，以及运行中继续发送消息的体验。", delivery: "turn" } });
    history(140, { type: "item", nodeId: root, itemSeq: 2, itemTs: at(-140_000), item: { type: "assistant_message", text: richConversation } });
    // Images: a pasted screenshot inline in the human message, a tool that returned a screenshot, and
    // an agent reply pointing at a local file relative to the node's cwd.
    history(130, { type: "item", nodeId: root, itemSeq: 3, itemTs: at(-130_000), item: { type: "user_message", text: "这是现在的搜索面板 ![搜索面板截图](attachment:att_demo_search) 结果行太挤，也看不到匹配数，帮我调一下？", delivery: "turn" } });
    history(120, { type: "item", nodeId: root, itemSeq: 4, itemTs: at(-120_000), item: { type: "tool_call", callId: "demo-screenshot", name: "mcp__browser__screenshot", status: "completed", detail: { type: "unknown", input: { url: "http://127.0.0.1:5173/search?q=权限" }, output: { saved: "docs/search-spacing.png" } }, images: [demoAttachments.att_demo_shot!] } });
    history(110, { type: "item", nodeId: root, itemSeq: 5, itemTs: at(-110_000), item: { type: "assistant_message", text: "已调整：结果行高 52px、行间距 12px，并在右侧显示匹配数。截图存到了 `docs/search-spacing.png`：\n\n![调整后的搜索面板](docs/search-spacing.png)" } });
    for (const node of snapshot.nodes) {
      const turnId = `${node.id}:quiet`;
      history(100, { type: "turn.started", turn: { id: turnId, nodeId: node.id, runId: snapshot.run.id, trigger: "user", status: "running", startedAt: at(-100_000) } });
    }
    for (const node of snapshot.nodes) {
      const turnId = `${node.id}:quiet`;
      history(65, { type: "item", nodeId: node.id, itemSeq: node.id === root ? 6 : 1, turnId, itemTs: at(-65_000), item: { type: "reasoning", text: "正在梳理复杂边界。此 demo 故意保持较长静默，仍会显示本轮计时与无新输出时长。\n默认发送会排队；Claude 可将消息改为引导，pi 不支持引导。尝试引导后可立即发送，中断本轮。" } });
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
