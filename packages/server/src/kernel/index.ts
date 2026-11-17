import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { descendantProcessIds, terminateProcessIds } from "@baton/providers";
import { BATON_TOOLS, LEAD_ONLY_TOOLS, emptyUsage, type AgentEntry, type AskHumanInput, type PermissionDecision, type BatonToolName, type CreateRunRequest, type DelegateInput, type DelegationRecord, type DelegationResult, type ItemRecord, type JsonValue, type NodeRecord, type PatchRunRequest, type PermissionRecord, type PermissionRequest, type PermissionResponse, type ReportResultInput, type FormTeamInput, type ReplaceMemberInput, type ReassignInput, type ReorderQueueResponse, type RunEvent, type RunPolicy, type RunSnapshot, type RunStatus, type SendMessageResponse, type SendMode, type TimelineItem, type ToolSpanRecord, type TurnTrigger, type Usage, type UsageTotals } from "@baton/protocol";
import type { DriverEvent, DriverRegistry, DriverSession, OpenSessionSpec, PromptInput } from "../driver/types.js";
import type { Attachments } from "../attachments/index.js";
import { attachmentLabel, attachmentPrompt, attachmentText, type AttachmentFile } from "./images.js";
import { Store } from "../store/index.js";
import { briefPrompt, correctionPrompt, followupPrompt, noticePrompt, resultsPrompt, systemPrompt } from "./prompts.js";
import { Teams, type ResolvedMember } from "./teams.js";
import { HumanInteraction } from "./human.js";
import { PermissionRules, HUMAN_DENIAL } from "./permission-rules.js";
import { validateSchema } from "./schema.js";
import type { TitleNaming } from "../titles/index.js";
import type { ProcessSource } from "../background/attribution.js";
import { Projects } from "../projects/index.js";
import { nativePrompts, nativeUpdatedInput } from "./questions.js";
import type { QuestionRecord } from "@baton/protocol";

/** True when a permission request is for one of baton's own MCP tools (Claude names them
 * mcp__baton__*, Codex asks via an MCP elicitation carrying serverName "baton"). */
export function isBatonToolPermission(request: PermissionRequest): boolean {
  if (/^(mcp__baton__|baton__|baton\.)/.test(request.name)) return true;
  if (request.detail?.type === "baton") return true;
  const server = request.input?.serverName ?? request.input?.server_name ?? request.input?.server;
  return server === "baton";
}
export const DEFAULT_POLICY: RunPolicy = { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, mode: "dynamic", teamApproval: true, maxTeamSize: 5, stallMinutes: 10, prFeedback: "notify" };
const now = (): string => new Date().toISOString();
const active = (status: string): boolean => ["starting", "running", "waiting_permission", "queued"].includes(status);
const done = (d: DelegationRecord): boolean => ["completed", "failed", "canceled", "replaced"].includes(d.status);
const addUsage = (a: UsageTotals, b: UsageTotals): UsageTotals => ({ inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd + b.costUsd });
interface QueuedPrompt { text: string; trigger: TurnTrigger; humanItem?: ItemRecord }
type HumanMessage = ItemRecord & { item: Extract<TimelineItem, { type: "user_message" }> };
type MessageDelivery = Omit<SendMessageResponse, "accepted">;
export class MessageError extends Error { readonly status = 409; }
const HUMAN_INTERRUPT = "interrupted by human message";
const PAUSE_REASON = "paused by human";
const RESUME_PROMPT = noticePrompt("system", "The human paused this run and has now resumed it. Continue where you left off.");
const RESTART_RESUME_PROMPT = noticePrompt("system", "baton was restarted while you were working, which interrupted your turn. The human has resumed the run. Check what you had already done (files, commands, delegations) and continue where you left off.");
interface Runtime {
  token: string; session?: DriverSession; opening?: Promise<DriverSession>; unsubscribe?: () => void;
  turnId?: string; driverTurnId?: string; report?: ReportResultInput; finalText: string; corrections: number;
  usage: UsageTotals; chain: Promise<void>; queued: QueuedPrompt[]; pendingMessages: Map<number, ItemRecord>;
  pendingItem?: ItemRecord; itemTimer?: NodeJS.Timeout; lastItem?: ItemRecord; closed: boolean;
  idleTimer?: NodeJS.Timeout; stallTimer?: NodeJS.Timeout;
  /** Hold other prompts while an interrupted turn is being replaced. */
  interrupting?: string;
  interruptReason?: string;
  starting?: Promise<{ turnId: string }>;
}
export interface KernelOptions { baseUrl: string; maxActiveNodes?: number; deliveryDebounceMs?: number; idleTimeoutMs?: number; stallTimeoutMs?: number; askTimeoutMinutes?: number; titles?: TitleNaming; platform?: NodeJS.Platform; attachments?: Attachments }
export class Kernel {
  private runtimes = new Map<string, Runtime>();
  private identities = new Map<string, string>();
  private deliveryTimers = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private titleController = new AbortController();
  private waits = new Map<string, Set<() => void>>();
  private canceling = new Set<string>();
  private delivering = new Set<string>();
  private replacing = new Set<string>();
  private decidingPermissions = new Set<string>();
  private messageActions = new Set<string>();
  private drainingMessages = new Set<string>();
  private pausing = new Map<string, Promise<void>>();
  private resuming = new Set<string>();
  readonly teams: Teams;
  readonly human: HumanInteraction;
  readonly rules: PermissionRules;
  readonly projects: Projects;
  constructor(readonly store: Store, readonly registry: DriverRegistry, readonly options: KernelOptions) {
    this.projects = new Projects(store, undefined, undefined, options.platform);
    this.rules = new PermissionRules(store);
    this.human = new HumanInteraction(store, {
      activity: (id, activity) => { this.patchNode(id, { activity }); this.armStall(id); },
      enqueue: (id, text) => this.enqueue(id, text),
      cancel: (id, reason) => this.cancelNode(id, reason),
      followup: (id, text) => this.sendFollowup(id, text),
      nativeAnswer: (question) => this.answerNative(question),
      nativeDecline: (question, message) => this.declineNative(question, message),
    });
    this.teams = new Teams(store, registry, {
      cancelForReplacement: (id, reason) => { const d = this.store.node(id).delegationId; if (d) this.replacing.add(d); return this.cancelNode(id, reason, true); },
      create: (id, input, target, replaces) => this.createDelegation(id, input, target, replaces),
      flush: (id) => this.flushItem(id),
      admission: (id, excluding) => this.admitDelegation(id, excluding),
      patchOld: (old, replacement, reason) => {
        if (!old.blockedByProposal) this.patchNode(old.toNodeId, { status: "replaced", activity: `Reassigned: ${reason}`, endedAt: now() });
        this.patchDelegation(old.id, { status: "replaced", replacedBy: replacement, replaceReason: reason, endedAt: now() });
      },
      release: (runId, proposalId) => this.releaseProposal(runId, proposalId),
      notify: (id, text) => this.enqueue(id, text),
    });
  }
  /** A stored attachment's file for delivery; undefined when the id or the file is gone. */
  private attachmentFile = (attachmentId: string): AttachmentFile | undefined => {
    const attachments = this.options.attachments, record = attachments?.get(attachmentId);
    if (!attachments || !record) return undefined;
    const path = attachments.path(record);
    return existsSync(path) ? { path, mimeType: record.mimeType, ...(record.name ? { name: record.name } : {}) } : undefined;
  };
  /** What a driver receives for prompt text: attachment markers become image parts when the
   * node's agent takes images, else path notes. The transcript keeps the markers. */
  private promptFor(id: string, text: string): PromptInput {
    return attachmentPrompt(text, this.attachmentFile, this.registry.get(this.store.node(id).agentId)?.capabilities.images === true);
  }
  private enqueue(id: string, text: string): void { this.store.queueNotice(randomUUID(), id, this.store.node(id).runId, text); this.scheduleDelivery(id); }
  private emit(runId: string, event: RunEvent): void { this.store.append(runId, event); }
  private patchNode(id: string, patch: Partial<NodeRecord>): void {
    const n = this.store.node(id);
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(n[key as keyof NodeRecord]) === JSON.stringify(value))) return;
    const next = { ...n, ...patch, updatedAt: now() };
    // JSON cannot encode undefined in a shallow patch. The existing upsert events can replace
    // a record when optional fields must be removed (follow-up / resume).
    this.emit(n.runId, Object.values(patch).some((value) => value === undefined)
      ? { type: "node.created", node: next }
      : { type: "node.updated", nodeId: id, patch: { ...patch, updatedAt: next.updatedAt } });
    if (patch.status && ["completed", "failed", "canceled", "replaced"].includes(patch.status)) this.human.endQuestions(id, `Node ${patch.status}`);
  }
  private patchDelegation(id: string, patch: Partial<DelegationRecord>): void {
    const d = this.store.delegation(id);
    this.emit(d.runId, Object.values(patch).some((value) => value === undefined)
      ? { type: "delegation.created", delegation: { ...d, ...patch } }
      : { type: "delegation.updated", delegationId: id, patch });
  }
  private runtime(id: string): Runtime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      const rows = new Map(this.store.items(id).filter((row) => row.item.type === "user_message" && row.item.delivery === "queued").map((row) => [row.seq, row]));
      rt = { token: randomBytes(32).toString("hex"), finalText: "", corrections: 0, usage: emptyUsage(), chain: Promise.resolve(), queued: this.store.heldPrompts(id).flatMap((p): QueuedPrompt[] => p.humanSeq === undefined ? [{ text: p.text, trigger: p.trigger }] : rows.has(p.humanSeq) ? [{ text: p.text, trigger: p.trigger, humanItem: rows.get(p.humanSeq)! }] : []), pendingMessages: rows, closed: false };
      this.runtimes.set(id, rt); this.identities.set(rt.token, id);
    }
    return rt;
  }
  identify(token: string): string | undefined { return this.identities.get(token); }
  private paused(runId: string): boolean { return this.store.snapshot(runId).run.status === "paused"; }
  private interruptedTurn(id: string, turnId: string): boolean {
    const rt = this.runtime(id);
    return rt.interrupting === turnId || this.store.snapshot(this.store.node(id).runId).turns.some((turn) => turn.id === turnId && turn.status === "canceled" && [HUMAN_INTERRUPT, PAUSE_REASON].includes(turn.error ?? ""));
  }
  private persistQueue(id: string): void { this.store.holdPrompts(id, this.runtime(id).queued.map((p) => ({ text: p.text, trigger: p.trigger, ...(p.humanItem ? { humanSeq: p.humanItem.seq } : {}) }))); }
  private queuePrompts(id: string, prompts: QueuedPrompt[]): void { this.runtime(id).queued.push(...prompts); this.persistQueue(id); }
  processSources(): ProcessSource[] {
    return this.store.list().flatMap((r) => {
      const snapshot = this.store.snapshot(r.id);
      return snapshot.nodes.map((n) => ({ runId: r.id, nodeId: n.id, cwd: n.cwd, pids: this.runtimes.get(n.id)?.session?.processIds?.() ?? [], spans: snapshot.toolSpans.filter((s) => s.nodeId === n.id && s.kind === "shell") }));
    });
  }
  async agents(force = false): Promise<Array<AgentEntry & { load: number }>> {
    const entries = await this.registry.detect({ force });
    const nodes = this.store.list().flatMap((r) => this.store.snapshot(r.id).nodes);
    return entries.map((a) => ({ ...a, load: nodes.filter((n) => n.agentId === a.id && active(n.status)).length }));
  }
  recover(): void {
    for (const notice of this.store.notices()) this.scheduleDelivery(notice.nodeId);
    for (const listed of this.store.list()) {
      // Agents were working when the daemon stopped (crash, quit, update): pause the run rather than
      // leave it half-interrupted, so 继续 resumes every interrupted agent from its saved session.
      if (listed.status === "active" && this.store.snapshot(listed.id).turns.some((t) => t.status === "running")) {
        this.emit(listed.id, { type: "run.updated", patch: { status: "paused", pauses: [...this.store.snapshot(listed.id).run.pauses ?? [], { at: now(), by: "restart" }], updatedAt: now() } });
      }
      const s = this.store.snapshot(listed.id), run = s.run;
      const byRestart = run.status === "paused" && run.pauses?.at(-1)?.by === "restart" && !run.pauses.at(-1)?.resumedAt;
      const normalized = this.validatePolicy(s.run.policy);
      if (JSON.stringify(s.run.policy) !== JSON.stringify(normalized)) this.emit(run.id, { type: "run.updated", patch: { policy: normalized } });
      for (const n of s.nodes) if (active(n.status)) { if (run.status === "paused" && s.turns.some((t) => t.nodeId === n.id && t.status === "running")) this.store.rememberPausedNode(run.id, n.id); this.patchNode(n.id, { status: "interrupted", activity: run.status === "paused" ? "Paused" : "Interrupted by daemon restart", error: run.status === "paused" ? undefined : "Daemon restarted" }); }
      for (const d of s.delegations) if (active(d.status) && !d.blockedByProposal && !(run.status === "paused" && d.status === "queued")) this.patchDelegation(d.id, { status: "interrupted" });
      for (const t of s.turns) if (t.status === "running") this.emit(run.id, { type: "turn.updated", turnId: t.id, patch: { status: run.status === "paused" && !byRestart ? "canceled" : "interrupted", endedAt: now(), error: run.status === "paused" && !byRestart ? PAUSE_REASON : "Daemon restarted" } });
      for (const p of s.permissions) if (p.status === "pending") this.emit(run.id, { type: "permission", permission: { ...p, status: "expired", resolvedAt: now() } });
      for (const span of s.toolSpans) if (span.status === "running") this.emit(run.id, { type: "tool.span", span: { ...span, status: "canceled", endedAt: now() } });
      for (const n of s.nodes) this.human.refreshActivity(n.id);
      for (const n of s.nodes) this.human.endQuestions(n.id, "Daemon restarted");
      this.updateRun(run.id);
      for (const parentId of new Set(s.delegations.filter((d) => done(d) && d.result && !d.deliveredAt).map((d) => d.fromNodeId))) this.scheduleDelivery(parentId);
    }
  }
  private async available(agent: string): Promise<AgentEntry> {
    const entry = (await this.registry.detect()).find((a) => a.id === agent);
    if (!entry || entry.status !== "ready" || !entry.enabled || !this.registry.get(agent)) throw new Error(`Agent unavailable: ${agent}`);
    return entry;
  }
  private checkGlobalLimit(): void {
    const count = this.store.list().reduce((sum, r) => sum + this.store.snapshot(r.id).nodes.filter((n) => active(n.status)).length, 0);
    if (count >= (this.options.maxActiveNodes ?? 12)) throw new Error("Global active node limit reached");
  }
  private budget(runId: string): void {
    const r = this.store.snapshot(runId).run, b = r.policy.budget;
    if (!b) return;
    if ((b.maxCostUsd !== undefined && r.usage.costUsd >= b.maxCostUsd) || (b.maxTokens !== undefined && r.usage.inputTokens + r.usage.outputTokens >= b.maxTokens) || (b.maxWallMinutes !== undefined && Date.now() - Date.parse(r.createdAt) >= b.maxWallMinutes * 60000)) throw new Error("Run budget exceeded");
  }
  async createRun(input: CreateRunRequest): Promise<RunSnapshot> {
    if (!input || typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("Nonempty prompt is required");
    const cwd = await this.projects.cwd(input.projectId, input.cwd);
    const preset = input.teamPresetId ? this.store.preset(input.teamPresetId) : undefined;
    const agent = input.agent ?? preset?.lead.agentId;
    const leadDefaults = input.agent && input.agent !== preset?.lead.agentId ? undefined : preset?.lead;
    if (typeof agent !== "string" || !agent) throw new Error("agent is required unless teamPresetId is given");
    const policy = this.validatePolicy({ ...DEFAULT_POLICY, ...input.policy, ...(preset ? { mode: "preset" } : {}) });
    if (policy.mode === "preset" && !preset) throw new Error("Preset mode requires teamPresetId");
    if (input.team && policy.mode !== "dynamic") throw new Error("Initial team is only supported in dynamic mode");
    const members = await this.teams.validateMembers(preset?.members ?? input.team ?? []);
    if (members.length > (policy.maxTeamSize ?? 5)) throw new Error(`Team size exceeds maxTeamSize (${policy.maxTeamSize ?? 5})`);
    await this.available(agent); this.checkGlobalLimit();
    if (this.store.project(input.projectId).archived) throw new Error("Project is archived");
    const runId = randomUUID(), nodeId = randomUUID(), ts = now();
    const promptTitle = attachmentLabel(input.prompt).slice(0, 100);
    this.emit(runId, { type: "run.created", run: { id: runId, rootNodeId: nodeId, projectId: input.projectId, title: input.title || promptTitle, titleSource: input.title ? "human" : "prompt", cwd, status: "active", policy, createdAt: ts, updatedAt: ts, usage: emptyUsage() } });
    this.emit(runId, { type: "node.created", node: { id: nodeId, runId, parentNodeId: null, delegationId: null, depth: 0, agentId: agent, model: input.model ?? leadDefaults?.model, modeId: input.modeId ?? leadDefaults?.modeId, thinking: input.thinking ?? leadDefaults?.thinking, title: input.title || promptTitle, cwd, status: "starting", createdAt: ts, updatedAt: ts, usage: emptyUsage(), turns: 0 } });
    if (preset || input.team) this.teams.initialize(runId, members, preset ? "preset" : "human", preset);
    try { await this.startTurn(nodeId, input.prompt, "user"); } catch (error) { this.failNode(nodeId, error); }
    if (!input.title) void this.generateTitle(runId, attachmentLabel(input.prompt));
    return this.store.snapshot(runId);
  }
  /** The run's first prompt for title naming; attachment markers read as "[图片 name]". */
  firstPrompt(id: string): string {
    const run = this.store.snapshot(id).run;
    const row = this.store.items(run.rootNodeId).find((r) => r.item.type === "user_message");
    return row?.item.type === "user_message" ? attachmentLabel(row.item.text) : run.title;
  }
  async regenerateTitle(id: string): Promise<RunSnapshot["run"]> {
    this.store.snapshot(id);
    await this.generateTitle(id, this.firstPrompt(id), true);
    return this.store.snapshot(id).run;
  }
  private async generateTitle(id: string, prompt: string, force = false): Promise<void> {
    try {
      if (!this.options.titles) { if (force) throw new Error("Title model is not configured"); return; }
      const title = await this.options.titles.generate(prompt, force, this.titleController.signal);
      if (!title || this.stopped) return;
      const run = this.store.snapshot(id).run;
      if (!force && (run.titleSource ?? "prompt") !== "prompt") return;
      this.emit(id, { type: "run.updated", patch: { title, titleSource: "generated", updatedAt: now() } });
    } catch (error) {
      if (!this.stopped) this.emit(id, { type: "log", level: "warn", message: `Title generation failed: ${error instanceof Error ? error.message : String(error)}` });
      if (force) throw error;
    }
  }
  private validatePolicy(policy: RunPolicy): RunPolicy {
    if (!Number.isInteger(policy.maxDepth) || policy.maxDepth < 0 || !Number.isInteger(policy.maxActiveChildren) || policy.maxActiveChildren < 1 || typeof policy.autoApprove !== "boolean") throw new Error("Invalid run policy");
    if (policy.budget) for (const [key, value] of Object.entries(policy.budget)) if (!["maxCostUsd", "maxTokens", "maxWallMinutes"].includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid run budget");
    if (policy.mode !== undefined && !["dynamic", "preset", "solo"].includes(policy.mode)) throw new Error("Invalid collaboration mode");
    const { delegation: _legacy, ...normalized } = policy as RunPolicy & { delegation?: unknown };
    if (policy.teamApproval !== undefined && typeof policy.teamApproval !== "boolean") throw new Error("Invalid teamApproval policy");
    if (policy.maxTeamSize !== undefined && (!Number.isInteger(policy.maxTeamSize) || policy.maxTeamSize < 1)) throw new Error("Invalid maxTeamSize");
    if (policy.maxRoundsPerDelegation !== undefined && (!Number.isInteger(policy.maxRoundsPerDelegation) || policy.maxRoundsPerDelegation < 0)) throw new Error("Invalid maxRoundsPerDelegation");
    if (policy.stallMinutes !== undefined && (!Number.isFinite(policy.stallMinutes) || policy.stallMinutes <= 0)) throw new Error("Invalid stallMinutes");
    if (policy.prFeedback !== undefined && !["off", "notify", "auto"].includes(policy.prFeedback)) throw new Error("Invalid prFeedback policy");
    const result: RunPolicy = { ...DEFAULT_POLICY, ...normalized, mode: normalized.mode ?? "dynamic", teamApproval: normalized.teamApproval ?? true };
    if (!result.maxRoundsPerDelegation) delete result.maxRoundsPerDelegation; // 0 = unlimited, stored as absent
    return result;
  }
  patchRun(id: string, input: PatchRunRequest): RunSnapshot {
    const s = this.store.snapshot(id);
    if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) throw new Error("Invalid title");
    if (input.policy?.maxTeamSize !== undefined && input.policy.maxTeamSize < (s.run.team?.members.filter((m) => m.status === "active").length ?? 0)) throw new Error("maxTeamSize cannot be smaller than the active roster");
    this.emit(id, { type: "run.updated", patch: { ...(input.title ? { title: input.title, titleSource: "human" } : {}), policy: this.validatePolicy({ ...s.run.policy, ...input.policy, mode: s.run.policy.mode, teamApproval: input.policy?.teamApproval ?? s.run.policy.teamApproval }), updatedAt: now() } });
    if (input.policy?.stallMinutes !== undefined) for (const n of s.nodes) if (this.runtimes.get(n.id)?.turnId) this.armStall(n.id);
    if (input.policy?.autoApprove) for (const p of s.permissions) if (p.status === "pending") void this.respondPermission(p.id, { behavior: "allow" }, "policy").catch((e: unknown) => this.log(id, e));
    return this.store.snapshot(id);
  }
  private async session(id: string): Promise<DriverSession> {
    const rt = this.runtime(id);
    if (this.stopped) throw new Error("Daemon is shutting down");
    if (rt.closed) {
      if (["canceled", "replaced"].includes(this.store.node(id).status)) throw new Error("Node session has been closed");
      rt.closed = false; rt.token = randomBytes(32).toString("hex"); this.identities.set(rt.token, id);
    }
    if (rt.session) return rt.session;
    if (rt.opening) return rt.opening;
    rt.opening = (async () => {
      const n = this.store.node(id), driver = this.registry.get(n.agentId);
      if (!driver) throw new Error(`Agent unavailable: ${n.agentId}`);
      const run = this.store.snapshot(n.runId).run;

      const spec: OpenSessionSpec = { cwd: n.cwd, model: n.model, modeId: n.modeId, thinking: n.thinking, title: n.title, env: { MCP_TOOL_TIMEOUT: String(Math.ceil(Math.max(60, this.options.askTimeoutMinutes ?? 60) * 60000 + 60000)) }, systemPrompt: systemPrompt(n, run.policy, (await this.registry.detect()).filter((a) => a.status === "ready" && a.enabled), run.team), mcpServers: { baton: { type: "http" as const, url: `${this.options.baseUrl}/mcp/n/${rt.token}` } } };
      const session = n.persistence !== undefined && driver.capabilities.resume ? await driver.resume(n.persistence, spec) : await driver.open(spec);
      if (rt.closed) { await session.close(); throw new Error("Node session closed during startup"); }
      rt.session = session;
      rt.unsubscribe = session.subscribe((event) => {
        if (!rt.closed && !this.stopped) this.armStall(id);
        rt.chain = rt.chain.then(() => this.onEvent(id, event)).catch((error: unknown) => { this.log(n.runId, error, id); this.failNode(id, error); });
      });
      const info = await session.runtimeInfo();
      this.patchNode(id, { ...(info.model ? { model: info.model } : {}), ...(info.modeId ? { modeId: info.modeId } : {}), persistence: session.persistence() ?? undefined });
      return session;
    })();
    try { return await rt.opening; } finally { rt.opening = undefined; }
  }
  private async startTurn(id: string, text: string, trigger: TurnTrigger): Promise<void> {
    await this.startPrompts(id, [{ text, trigger }]);
  }
  /** External CI/review feedback waits for the running turn; never steer or interrupt it. */
  async queueFeedback(id: string, text: string): Promise<void> {
    const node = this.store.node(id), rt = this.runtime(id);
    if (this.stopped || this.canceling.has(id) || ["canceled", "replaced"].includes(node.status)) throw new Error("Feedback node is canceled or replaced");
    if (rt.turnId || rt.interrupting || this.paused(node.runId)) this.queuePrompts(id, [{ text, trigger: "followup" }]);
    else await this.startTurn(id, text, "followup");
  }
  private async startPrompts(id: string, prompts: QueuedPrompt[], interrupt = false): Promise<MessageDelivery["delivery"]> {
    if (this.stopped) return "queued";
    const rt = this.runtime(id), n = this.store.node(id);
    // A cancel/close can abandon a message while session startup or steer is awaiting the driver.
    prompts = prompts.filter((p) => !p.humanItem || rt.pendingMessages.has(p.humanItem.seq));
    if (!prompts.length) return "queued";
    if (rt.turnId || this.paused(n.runId) || (rt.interrupting && !interrupt)) { this.queuePrompts(id, prompts); return "queued"; }
    if (["canceled", "replaced"].includes(n.status) || this.canceling.has(id)) throw new Error("Node is canceled");
    const session = await this.session(id);
    prompts = prompts.filter((p) => !p.humanItem || rt.pendingMessages.has(p.humanItem.seq));
    if (!prompts.length) return "queued";
    if (rt.turnId || this.paused(n.runId) || (rt.interrupting && !interrupt)) { this.queuePrompts(id, prompts); return "queued"; }
    const current = this.store.node(id);
    if (["canceled", "replaced"].includes(current.status) || this.canceling.has(id) || this.stopped) throw new Error("Node has been canceled or daemon stopped");
    if (!active(current.status)) this.checkGlobalLimit();
    // Read positions after session startup: a reorder may have arrived while this drain
    // was awaiting it. Reorder human slots only; kernel prompts retain their positions.
    const queued = new Map(this.queuedHumanMessages(id).map((row) => [row.seq, row]));
    const humans = prompts.filter((p) => p.humanItem).sort((a, b) => {
      const first = queued.get(a.humanItem!.seq) ?? a.humanItem!, second = queued.get(b.humanItem!.seq) ?? b.humanItem!;
      const position = (row: ItemRecord): number => row.item.type === "user_message" ? row.item.queuePosition ?? row.seq : row.seq;
      return position(first) - position(second) || first.seq - second.seq;
    });
    let humanIndex = 0;
    prompts = prompts.map((p) => p.humanItem ? humans[humanIndex++]! : p);
    clearTimeout(rt.idleTimer);
    const trigger = prompts[0]!.trigger, text = prompts.map((p) => p.text).join("\n\n");
    const turnId = randomUUID(); rt.turnId = turnId; rt.driverTurnId = undefined; rt.report = undefined; rt.finalText = ""; rt.usage = emptyUsage(); rt.lastItem = undefined;
    this.emit(n.runId, { type: "turn.started", turn: { id: turnId, runId: n.runId, nodeId: id, trigger, delegationId: n.delegationId ?? undefined, status: "running", startedAt: now() } });
    this.patchNode(id, { status: "running", activity: "Thinking…", turns: n.turns + 1, error: undefined, endedAt: undefined });
    let deliveryOrder = 0;
    for (const prompt of prompts) if (prompt.humanItem) this.deliverMessage(id, prompt.humanItem, "turn", turnId, humans.length >= 2 ? ++deliveryOrder : undefined);
    // Human rows already exist. Only kernel prompts need a new transcript row for this batch.
    const kernelText = prompts.filter((p) => !p.humanItem).map((p) => p.text).join("\n\n");
    if (kernelText) this.addItem(id, { type: "user_message", text: kernelText });
    if (n.delegationId) this.patchDelegation(n.delegationId, { status: "running", startedAt: now(), endedAt: undefined, ...(n.status === "completed" || n.status === "failed" ? { deliveredAt: undefined, deliveredVia: undefined, result: undefined } : {}) });
    this.updateRun(n.runId); this.armStall(id);
    try {
      const starting = session.startTurn(this.promptFor(id, text)); rt.starting = starting;
      const started = await starting;
      if (rt.turnId !== turnId) return "turn";
      rt.driverTurnId = started.turnId;
      this.emit(n.runId, { type: "turn.updated", turnId, patch: { driverTurnId: started.turnId } });
      this.patchNode(id, { persistence: session.persistence() ?? undefined });
    } catch (error) {
      await this.finishTurn(id, "failed", undefined, error instanceof Error ? error.message : String(error));
      throw error;
    } finally { rt.starting = undefined; }
    return "turn";
  }
  async message(id: string, text: string, clientId?: string, mode: SendMode = "queue"): Promise<MessageDelivery> {
    if (typeof text !== "string" || !text.trim()) throw new Error("Nonempty text is required");
    if (clientId !== undefined && typeof clientId !== "string") throw new Error("clientId must be a string");
    if (!["queue", "steer", "interrupt"].includes(mode)) throw new Error("Invalid send mode");
    const n = this.store.node(id), rt = this.runtime(id);
    if (this.stopped) throw new Error("Daemon is shutting down");
    if (["canceled", "replaced"].includes(n.status) || this.canceling.has(id)) throw new Error("Node is canceled");
    const queuePosition = Math.max(0, ...this.queuedHumanMessages(id).map((r) => r.item.queuePosition ?? r.seq)) + 1;
    const row = this.addItem(id, { type: "user_message", text, delivery: "queued", queuePosition, ...(clientId !== undefined ? { clientId } : {}) });
    rt.pendingMessages.set(row.seq, row);
    const key = `${id}:${row.seq}`; this.messageActions.add(key);
    try {
      return await this.sendHumanMessage(id, row, mode, false);
    } catch (error) {
      // A failed submission must not discard other messages already waiting on this node.
      rt.queued = rt.queued.filter((p) => p.humanItem?.seq !== row.seq);
      this.abandonMessage(id, row.seq); throw error;
    } finally { this.messageActions.delete(key); }
  }
  private queuedHumanMessages(id: string): HumanMessage[] {
    return this.store.items(id).flatMap((row) => row.item.type === "user_message" && row.item.delivery === "queued" ? [{ ...row, item: row.item }] : []);
  }
  reorderQueue(id: string, order: number[]): ReorderQueueResponse {
    const node = this.store.node(id);
    if (this.stopped || this.canceling.has(id) || ["canceled", "replaced"].includes(node.status)) throw new MessageError("Node is canceled or closed");
    const queued = this.queuedHumanMessages(id), bySeq = new Map(queued.map((row) => [row.seq, row]));
    if (!Array.isArray(order) || order.length !== queued.length || new Set(order).size !== queued.length || order.some((seq) => !bySeq.has(seq))) throw new MessageError("Queue changed; order must contain every queued human message exactly once");
    for (const [index, seq] of order.entries()) {
      const row = bySeq.get(seq)!, queuePosition = index + 1;
      if (row.item.queuePosition !== queuePosition) this.replaceMessage(id, { ...row, item: { ...row.item, queuePosition } });
    }
    return { order: [...order] };
  }
  private humanMessage(id: string, seq: number): HumanMessage {
    this.store.node(id);
    const row = this.store.items(id).find((r) => r.seq === seq);
    if (!row || row.item.type !== "user_message" || row.item.delivery === undefined) throw new MessageError("Item is not a human message of this node");
    return { ...row, item: row.item };
  }
  editMessage(id: string, seq: number, text: string): void {
    if (typeof text !== "string" || !text.trim()) throw new Error("Nonempty text is required");
    const row = this.humanMessage(id, seq), rt = this.runtime(id), key = `${id}:${seq}`;
    if (row.item.delivery !== "queued") throw new MessageError("Only queued messages can be edited");
    if (this.messageActions.has(key) || this.drainingMessages.has(key)) throw new MessageError("Message delivery is already in progress");
    if (this.stopped || this.canceling.has(id) || !rt.pendingMessages.has(seq)) throw new MessageError("Node is canceled or closed");
    const next = { ...row, item: { ...row.item, text, editedAt: now() } };
    rt.queued = rt.queued.map((prompt) => prompt.humanItem?.seq === seq ? { ...prompt, text, humanItem: next } : prompt);
    this.replaceMessage(id, next);
    this.persistQueue(id);
  }
  async deliverHumanMessage(id: string, seq: number, mode: "steer" | "interrupt"): Promise<MessageDelivery> {
    if (mode !== "steer" && mode !== "interrupt") throw new Error("Invalid delivery mode");
    const row = this.humanMessage(id, seq), rt = this.runtime(id), key = `${id}:${seq}`;
    if (this.messageActions.has(key)) throw new MessageError("Message delivery is already in progress");
    if (row.item.delivery !== "queued" && !(mode === "interrupt" && row.item.delivery === "steered")) throw new MessageError("Message already delivered or retracted");
    if (this.stopped || this.canceling.has(id) || ["canceled", "replaced"].includes(this.store.node(id).status)) throw new MessageError("Node is canceled or closed");
    this.messageActions.add(key);
    // Reserve before awaiting steer/interrupt so the old turn cannot drain this row too.
    rt.queued = rt.queued.filter((p) => p.humanItem?.seq !== seq);
    this.persistQueue(id);
    rt.pendingMessages.set(seq, row);
    try { return await this.sendHumanMessage(id, row, mode, true); }
    catch (error) {
      if (rt.pendingMessages.has(seq) && row.item.delivery === "queued" && !rt.queued.some((p) => p.humanItem?.seq === seq)) this.queuePrompts(id, [{ text: row.item.text, trigger: "user", humanItem: row }]);
      if (row.item.delivery === "steered") rt.pendingMessages.delete(seq);
      throw error;
    } finally { this.messageActions.delete(key); }
  }
  retractMessage(id: string, seq: number): void {
    const row = this.humanMessage(id, seq), rt = this.runtime(id);
    if (this.messageActions.has(`${id}:${seq}`)) throw new MessageError("Message delivery is already in progress");
    if (row.item.delivery !== "queued") throw new MessageError("Only queued messages can be retracted");
    rt.queued = rt.queued.filter((p) => p.humanItem?.seq !== seq);
    this.persistQueue(id);
    rt.pendingMessages.delete(seq);
    const { queuePosition: _position, ...item } = row.item;
    this.replaceMessage(id, { ...row, item: { ...item, delivery: "retracted" } });
  }
  private async sendHumanMessage(id: string, row: ItemRecord, mode: SendMode, escalated: boolean): Promise<MessageDelivery> {
    if (row.item.type !== "user_message") throw new Error("Expected human message");
    const rt = this.runtime(id), turnId = rt.turnId;
    if (this.paused(this.store.node(id).runId)) { const delivery = await this.startPrompts(id, [{ text: row.item.text, trigger: "user", humanItem: row }]); return { delivery, itemSeq: row.seq }; }
    let steerUnsupported = false;
    if (mode === "interrupt" && turnId) return this.interruptForMessage(id, row);
    if (mode === "steer" && turnId && !rt.interrupting) {
      let outcome: Awaited<ReturnType<DriverSession["steer"]>> | undefined;
      try { outcome = await rt.session?.steer(this.promptFor(id, row.item.text)); }
      catch (error) { this.log(this.store.node(id).runId, error, id); }
      if (!rt.pendingMessages.has(row.seq)) return { delivery: "queued", itemSeq: row.seq };
      const interrupted = this.interruptedTurn(id, turnId);
      if (outcome === "steered" && !interrupted) {
        this.deliverMessage(id, { ...row, item: { ...row.item, escalated } }, "steered", turnId);
        return { delivery: "steered", itemSeq: row.seq };
      }
      steerUnsupported = outcome === undefined || outcome === "unsupported";
      // A provider may finish just before refusing steer; consume its terminal event first.
      if (outcome === "no_active_turn") await rt.chain;
    }
    const delivery = await this.startPrompts(id, [{ text: row.item.text, trigger: "user", humanItem: row }]);
    return { delivery, itemSeq: row.seq, ...(steerUnsupported && delivery === "queued" ? { steerUnsupported: true } : {}) };
  }
  private async interruptForMessage(id: string, row: ItemRecord): Promise<MessageDelivery> {
    const rt = this.runtime(id), turnId = rt.turnId;
    if (rt.interrupting) throw new MessageError("A human interruption is already in progress");
    if (!turnId || row.item.type !== "user_message") throw new Error("No active turn to interrupt");
    rt.interrupting = turnId;
    rt.interruptReason = HUMAN_INTERRUPT;
    try {
      await rt.starting?.catch(() => {});
      await rt.session?.interrupt();
      // Driver.interrupt resolves when the old turn can no longer run. Its terminal event
      // may still be queued on the kernel event chain; finalize it before opening a turn.
      await rt.chain;
      if (rt.turnId === turnId) await this.finishTurn(id, "canceled", undefined, HUMAN_INTERRUPT);
      const delivery = await this.startPrompts(id, [{ text: row.item.text, trigger: "user", humanItem: { ...row, item: { ...row.item, interrupted: true } } }], true);
      return { delivery, itemSeq: row.seq };
    } finally {
      rt.interrupting = undefined;
      rt.interruptReason = undefined;
      // Notices/results held during the transition can now reach the replacement turn.
      if (this.store.notices(id).length || this.store.snapshot(this.store.node(id).runId).delegations.some((d) => d.fromNodeId === id && done(d) && d.result && !d.deliveredAt)) this.scheduleDelivery(id);
    }
  }
  private replaceMessage(id: string, row: ItemRecord): void {
    const rt = this.runtime(id);
    if (rt.pendingMessages.has(row.seq)) rt.pendingMessages.set(row.seq, row);
    this.store.appendItem(this.store.node(id).runId, row);
    if (rt.lastItem?.seq === row.seq) rt.lastItem = row;
  }
  private deliverMessage(id: string, row: ItemRecord, delivery: "turn" | "steered", turnId: string, deliveryOrder?: number): void {
    const rt = this.runtime(id);
    if (row.item.type !== "user_message" || !rt.pendingMessages.delete(row.seq)) return;
    const { queuePosition: _position, deliveryOrder: _order, ...item } = row.item;
    const next = { ...row, turnId, item: { ...item, delivery, ...(deliveryOrder !== undefined ? { deliveryOrder } : {}) } };
    this.replaceMessage(id, next);
  }
  private abandonMessages(id: string): void {
    const rt = this.runtime(id); rt.queued = []; this.store.clearHeldPrompts(id);
    for (const seq of rt.pendingMessages.keys()) this.abandonMessage(id, seq);
  }
  private abandonMessage(id: string, seq: number): void {
    if (this.runtime(id).pendingMessages.delete(seq)) this.addItem(id, { type: "notice", level: "warning", message: "未送达：节点已结束" });
  }
  private async drainMessages(id: string): Promise<void> {
    const rt = this.runtime(id);
    if (rt.queued.length && !rt.closed && !rt.interrupting && !this.paused(this.store.node(id).runId)) {
      const prompts = rt.queued.splice(0), keys = prompts.flatMap((prompt) => prompt.humanItem ? [`${id}:${prompt.humanItem.seq}`] : []);
      this.persistQueue(id);
      // Reserve before startPrompts awaits session startup; an edit must not race its
      // captured text, even while the persisted row still says queued.
      for (const key of keys) this.drainingMessages.add(key);
      try { await this.startPrompts(id, prompts); }
      finally { for (const key of keys) this.drainingMessages.delete(key); }
    }
  }
  private async sendPrompt(id: string, text: string, trigger: TurnTrigger): Promise<void> {
    const n = this.store.node(id), rt = this.runtime(id);
    if (["canceled", "replaced"].includes(n.status) || this.canceling.has(id)) throw new Error("Node is canceled");
    if (rt.interrupting || this.paused(n.runId)) { this.queuePrompts(id, [{ text, trigger }]); return; }
    if (rt.turnId) {
      const turnId = rt.turnId;
      const outcome = await rt.session?.steer(this.promptFor(id, text));
      if (outcome === "steered" && !this.interruptedTurn(id, turnId)) { this.addItem(id, { type: "user_message", text }); return; }
      this.queuePrompts(id, [{ text, trigger }]); return;
    }
    await this.startTurn(id, text, trigger);
  }
  private admitDelegation(parentId: string, excluding?: string): void {
    const parent = this.store.node(parentId), s = this.store.snapshot(parent.runId);
    if (s.run.policy.mode === "solo") throw new Error("Solo runs cannot delegate");
    if (["canceled", "replaced"].includes(parent.status) || this.canceling.has(parentId)) throw new Error("Parent node is closed");
    if (parent.depth + 1 > s.run.policy.maxDepth) throw new Error(`Maximum delegation depth ${s.run.policy.maxDepth} exceeded`);
    if (s.delegations.filter((d) => d.id !== excluding && d.fromNodeId === parentId && active(d.status)).length >= s.run.policy.maxActiveChildren) throw new Error("Active child fan-out limit reached");
    // An active predecessor frees a global slot when replaced.
    if (!excluding || !s.nodes.some((n) => n.delegationId === excluding && active(n.status))) this.checkGlobalLimit();
    this.budget(parent.runId);
  }
  async delegate(parentId: string, input: DelegateInput): Promise<{ delegationId: string; nodeId?: string; status: "queued" | "pending_approval"; proposalId?: string; note: string }> {
    this.admitDelegation(parentId);
    const target = await this.teams.resolve(this.store.node(parentId).runId, { ...input, nodeId: parentId });
    this.admitDelegation(parentId);
    return this.createDelegation(parentId, input, target);
  }
  private async createDelegation(parentId: string, input: DelegateInput, target: ResolvedMember, replaces?: string): Promise<{ delegationId: string; nodeId?: string; status: "queued" | "pending_approval"; proposalId?: string; note: string }> {
    const entry = await this.available(target.member.agentId);
    const parent = this.store.node(parentId);
    const team = this.store.snapshot(parent.runId).run.team;
    if (target.proposalId) {
      const proposal = team?.proposals.find((p) => p.id === target.proposalId);
      if (proposal?.status !== "pending") {
        const approved = proposal?.status === "approved" ? team?.members.find((m) => m.status === "active" && m.role === target.member.role) : undefined;
        if (!approved) throw new Error("Team proposal was rejected or the role was dropped");
        return this.createDelegation(parentId, input, { member: approved, model: approved.model, modeId: approved.modeId, thinking: approved.thinking }, replaces);
      }
    } else if (!team?.members.some((m) => m.id === target.member.id && m.status === "active")) throw new Error("Team member changed while delegating; use get_team and retry");
    this.admitDelegation(parentId, replaces);
    const nodeId = randomUUID(), delegationId = randomUUID(), ts = now();
    const d: DelegationRecord = { blockedByProposal: target.proposalId, id: delegationId, runId: parent.runId, kind: "delegate", fromNodeId: parentId, toNodeId: nodeId, role: target.member.role, memberId: target.member.id, replaces, brief: { title: input.title, task: input.task, context: input.context, acceptance: input.acceptance, readonly: input.readonly, outputSchema: input.outputSchema as Record<string, JsonValue> | undefined }, round: 1, status: "queued", createdAt: ts, subtreeUsage: emptyUsage() };
    if (!target.proposalId) this.emit(parent.runId, { type: "node.created", node: { id: nodeId, runId: parent.runId, parentNodeId: parentId, delegationId, depth: parent.depth + 1, agentId: target.member.agentId, role: target.member.role, memberId: target.member.id, model: target.model, thinking: target.thinking, modeId: input.readonly ? entry.modes.find((m) => m.isReadOnly)?.id ?? target.modeId : target.modeId, title: input.title, cwd: parent.cwd, status: "starting", createdAt: ts, updatedAt: ts, usage: emptyUsage(), turns: 0 } });
    this.emit(parent.runId, { type: "delegation.created", delegation: d });
    if (!target.proposalId) this.launchDelegation(nodeId, d);
    return { delegationId, nodeId: target.proposalId ? undefined : nodeId, status: target.proposalId ? "pending_approval" : "queued", proposalId: target.proposalId, note: "Result will be delivered automatically. Do not poll." };
  }
  private async releaseProposal(runId: string, proposalId: string): Promise<void> {
    const run = this.store.snapshot(runId).run, proposal = run.team?.proposals.find((p) => p.id === proposalId);
    for (const d of this.store.snapshot(runId).delegations.filter((d) => d.blockedByProposal === proposalId && d.status === "queued")) {
      const member = proposal?.status === "approved" ? run.team?.members.find((m) => m.status === "active" && m.role === d.role) : undefined;
      if (!member) {
        this.patchDelegation(d.id, { status: "canceled", endedAt: now(), result: { status: "failed", summary: proposal?.status === "rejected" ? "Team proposal rejected" : "Role dropped from approved team", finalText: "", reported: false } });
        continue;
      }
      // A direct-agent reassign must leave its predecessor working until the new member
      // is approved. Rejection cancels only the successor above.
      if (d.replaces) {
        const old = this.store.delegation(d.replaces);
        if (!old.blockedByProposal) { this.replacing.add(old.id); await this.cancelNode(old.toNodeId, "Reassignment approved", true); this.patchNode(old.toNodeId, { status: "replaced", endedAt: now() }); }
        this.patchDelegation(old.id, { status: "replaced", replacedBy: d.id, replaceReason: "Reassignment approved", endedAt: now() });
        const notice = noticePrompt("team", `Delegation ${old.id} → ${d.id} reassignment approved. Use the successor id for results.`);
        this.store.queueNotice(randomUUID(), old.fromNodeId, runId, notice); this.scheduleDelivery(old.fromNodeId);
      }
      // The human's approved spec wins over the proposal (including model/mode edits).
      try { this.admitDelegation(d.fromNodeId, d.id); }
      catch (error) { this.patchDelegation(d.id, { status: "failed", blockedByProposal: undefined, endedAt: now(), result: { status: "failed", summary: error instanceof Error ? error.message : String(error), finalText: "", reported: false } }); this.scheduleDelivery(d.fromNodeId); continue; }
      const parent = this.store.node(d.fromNodeId), entry = (await this.registry.detect()).find((a) => a.id === member.agentId);
      const ts = now();
      this.emit(runId, { type: "node.created", node: { id: d.toNodeId, runId, parentNodeId: parent.id, delegationId: d.id, depth: parent.depth + 1, agentId: member.agentId, memberId: member.id, role: member.role, model: member.model, modeId: d.brief.readonly ? entry?.modes.find((m) => m.isReadOnly)?.id ?? member.modeId : member.modeId, thinking: member.thinking, title: d.brief.title, cwd: parent.cwd, status: "starting", createdAt: ts, updatedAt: ts, usage: emptyUsage(), turns: 0 } });
      this.patchDelegation(d.id, { memberId: member.id, blockedByProposal: undefined });
      const ready = this.store.delegation(d.id);
      this.launchDelegation(d.toNodeId, ready);
    }
    this.updateRun(runId);
  }
  private launchDelegation(id: string, delegation: DelegationRecord): void {
    if (this.paused(delegation.runId)) { this.queuePrompts(id, [{ text: briefPrompt(delegation), trigger: "delegation" }]); return; }
    setImmediate(() => {
      if (this.stopped) return;
      if (this.store.node(id).turns > 0) return;
      void this.startTurn(id, briefPrompt(delegation), "delegation").catch((error: unknown) => this.failNode(id, error));
    });
  }
  private own(nodeId: string, delegationId: string): DelegationRecord {
    const d = this.store.delegation(delegationId);
    if (d.fromNodeId !== nodeId) throw new Error("Only your own direct child delegations may be accessed");
    return d;
  }
  async tool(nodeId: string, name: BatonToolName, raw: unknown): Promise<unknown> {
    if (this.canceling.has(nodeId) || this.stopped) throw new Error("Node is canceling or daemon is stopping");
    const node = this.store.node(nodeId);
    if (name !== "ask_human" && this.store.snapshot(node.runId).run.policy.mode === "solo") throw new Error("Solo runs have no baton tools and cannot delegate");
    if (LEAD_ONLY_TOOLS.includes(name) && node.parentNodeId !== null) throw new Error(`${name} is lead only`);
    const input = BATON_TOOLS[name].input.parse(raw) as Record<string, unknown>;
    switch (name) {
      case "list_agents": return this.agents();
      case "ask_human": {
        if (["completed", "failed", "canceled", "replaced"].includes(node.status)) throw new Error("Node is terminal");
        const session = this.runtime(nodeId).session;
        const result = this.human.ask(node, input as unknown as AskHumanInput, this.questionAnchor(nodeId, "ask_human"), (this.options.askTimeoutMinutes ?? 60) * 60000, session?.supportsLongToolCalls?.() !== true);
        // An inline answer travels back as MCP tool text: images in it become path notes.
        this.armStall(nodeId); return result.then((value) => this.textAttachments(value));
      }
      case "get_team": return this.teams.get(node.runId);
      case "form_team": {
        const form = input as unknown as FormTeamInput;
        return this.teams.form(node.runId, form.members.map((m) => ({ role: m.role, agentId: m.agent, model: m.model, modeId: m.mode, thinking: m.thinking, responsibilities: m.responsibilities, reason: m.reason })), form.rationale, nodeId);
      }
      case "replace_member": {
        const r = input as unknown as ReplaceMemberInput;
        return this.teams.replace(node.runId, r.role, { agentId: r.agent, model: r.model, modeId: r.mode, thinking: r.thinking, responsibilities: r.responsibilities, reason: r.reason, reassignActive: r.reassignActive }, "lead", nodeId);
      }
      case "reassign": {
        const r = input as unknown as ReassignInput, d = this.own(nodeId, r.delegationId);
        return this.teams.reassign(d.id, { memberId: r.role ? this.teams.member(node.runId, r.role).id : undefined, agentId: r.agent, model: r.model, modeId: r.mode, reason: r.reason }, nodeId);
      }
      case "delegate": return this.delegate(nodeId, input as unknown as DelegateInput);
      case "report_result": {
        const n = this.store.node(nodeId), rt = this.runtime(nodeId);
        if (!n.delegationId) throw new Error("Root nodes cannot report_result; answer the human");
        if (!rt.turnId) throw new Error("No active assignment");
        if (rt.report) throw new Error("report_result already called for this turn");
        rt.report = input as unknown as ReportResultInput; return { accepted: true, note: "End your turn now." };
      }
      case "get_result": {
        const d = this.own(nodeId, String(input.delegationId));
        if (done(d) && d.status !== "replaced" && d.result) this.delivered(d, "get_result");
        return { ...this.store.delegation(d.id), ...(d.status === "replaced" ? { result: undefined } : {}), usage: d.subtreeUsage };
      }
      case "send": {
        const d = this.own(nodeId, String(input.delegationId));
        if (d.blockedByProposal) throw new Error("Delegation is waiting for team approval");
        if (["canceled", "replaced"].includes(d.status)) throw new Error(`Delegation is ${d.status}${d.replacedBy ? `; replacement: ${d.replacedBy}` : ""}`);
        this.budget(d.runId);
        const limit = this.store.snapshot(d.runId).run.policy.maxRoundsPerDelegation; // absent or 0 = unlimited
        const maximum = limit ? limit + this.store.extraRounds(d.id) : Infinity;
        if (d.round + 1 > maximum) return this.human.limit(d.id, String(input.message), maximum);
        await this.sendFollowup(d.id, String(input.message)); return { sent: true, round: d.round + 1 };
      }
      case "cancel": {
        const d = this.own(nodeId, String(input.delegationId));
        if (d.status === "replaced") throw new Error(`Delegation was replaced by ${d.replacedBy}`);
        if (d.blockedByProposal) { this.patchDelegation(d.id, { status: "canceled", endedAt: now(), result: { status: "failed", summary: "Canceled by parent", finalText: "", reported: false } }); this.scheduleDelivery(d.fromNodeId); }
        else await this.cancelNode(d.toNodeId, typeof input.reason === "string" ? input.reason : "Canceled by parent"); return { canceled: true };
      }
      case "status": {
        const n = this.store.node(nodeId), s = this.store.snapshot(n.runId);
        const roots = input.delegationId ? [this.own(nodeId, String(input.delegationId))] : s.delegations.filter((d) => d.fromNodeId === nodeId);
        const ids = new Set(roots.map((d) => d.toNodeId));
        for (const n of [...s.nodes].sort((a, b) => a.depth - b.depth)) if (n.parentNodeId && ids.has(n.parentNodeId)) ids.add(n.id);
        return { delegations: s.delegations.filter((d) => ids.has(d.toNodeId)), nodes: s.nodes.filter((n) => ids.has(n.id)) };
      }
      case "wait": return this.wait(nodeId, input);
    }
  }
  private textAttachments(value: unknown): unknown {
    if (typeof value === "string") return attachmentText(value, this.attachmentFile);
    if (Array.isArray(value)) return value.map((entry) => this.textAttachments(entry));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.textAttachments(entry)]));
    return value;
  }
  private async sendFollowup(id: string, message: string): Promise<void> {
    const d = this.store.delegation(id); this.budget(d.runId);
    if (["canceled", "replaced"].includes(d.status)) throw new Error(`Delegation is ${d.status}`);
    this.patchDelegation(d.id, { round: d.round + 1, result: undefined, status: "running", deliveredAt: undefined, deliveredVia: undefined, endedAt: undefined });
    this.runtime(d.toNodeId).corrections = 0;
    await this.sendPrompt(d.toNodeId, followupPrompt(d.id, message), "followup");
  }
  private armStall(id: string): void {
    const rt = this.runtime(id); clearTimeout(rt.stallTimer);
    if (!rt.turnId || this.stopped) return;
    const n = this.store.node(id);
    if (this.paused(n.runId) || this.store.snapshot(n.runId).questions.some((q) => q.nodeId === id && q.status === "pending" && q.delivery === "inline")) return;
    const ms = this.options.stallTimeoutMs ?? (this.store.snapshot(n.runId).run.policy.stallMinutes ?? 10) * 60000;
    rt.stallTimer = setTimeout(() => { rt.stallTimer = undefined; if (rt.turnId && !rt.closed && !this.canceling.has(id) && !this.stopped) this.human.stall(this.store.node(id), ms); }, ms);
    rt.stallTimer.unref();
  }
  private wait(nodeId: string, input: Record<string, unknown>): Promise<unknown> {
    const n = this.store.node(nodeId), s = this.store.snapshot(n.runId);
    const ids = Array.isArray(input.delegationIds) ? input.delegationIds.map(String) : s.delegations.filter((d) => d.fromNodeId === nodeId && !d.deliveredAt && d.status !== "replaced").map((d) => d.id);
    ids.forEach((id) => this.own(nodeId, id));
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined, unsubscribe: (() => void) | undefined, finished = false;
      const cancel = (): void => finish(true);
      const finish = (timedOut: boolean): void => {
        if (finished) return; finished = true;
        clearTimeout(timer); unsubscribe?.(); this.waits.get(nodeId)?.delete(cancel);
        const completed = ids.map((id) => this.store.delegation(id)).filter(done);
        for (const d of completed) if (d.status !== "replaced") this.delivered(d, "wait");
        resolve({ timedOut, results: completed.map((d) => ({ ...this.store.delegation(d.id), ...(d.status === "replaced" ? { result: undefined } : {}) })) });
      };
      const ready = (): boolean => {
        const completed = ids.map((id) => this.store.delegation(id)).filter(done);
        return ids.length === 0 || (input.mode === "all" ? completed.length === ids.length : completed.length > 0);
      };
      const waiting = this.waits.get(nodeId) ?? new Set<() => void>(); waiting.add(cancel); this.waits.set(nodeId, waiting);
      unsubscribe = this.store.subscribe((event) => { if (event.runId === n.runId && ready()) finish(false); });
      timer = setTimeout(() => finish(true), Number(input.timeoutSec) * 1000);
      if (ready()) finish(false);
    });
  }
  private log(runId: string, error: unknown, nodeId?: string): void {
    if (!this.stopped) this.emit(runId, { type: "log", level: "error", message: error instanceof Error ? error.message : String(error), nodeId });
  }
  private questionAnchor(id: string, name: string, input?: Record<string, unknown>): QuestionRecord["anchor"] {
    this.flushItem(id);
    const rt = this.runtime(id), callId = input?.callId ?? input?.tool_use_id ?? input?.itemId;
    const calls = this.store.items(id).filter((row) => row.turnId === rt.turnId && row.item.type === "tool_call");
    const row = (typeof callId === "string" ? calls.findLast((row) => row.item.type === "tool_call" && row.item.callId === callId) : undefined)
      ?? calls.findLast((row) => row.item.type === "tool_call" && (row.item.name === name || row.item.name.endsWith(`__${name}`)));
    return { turnId: rt.turnId, ...(row ? { itemSeq: row.seq, callId: row.item.type === "tool_call" ? row.item.callId : undefined } : typeof callId === "string" ? { callId } : {}) };
  }
  private async declineNative(question: QuestionRecord, message: string): Promise<void> {
    const rt = this.runtime(question.nodeId), requestId = question.id.slice(question.nodeId.length + 1);
    if (!rt.session?.pendingPermissions().some((request) => request.id === requestId)) return;
    await rt.session.respondToPermission(requestId, { behavior: "deny", message });
    this.armStall(question.nodeId);
  }
  private async answerNative(question: QuestionRecord): Promise<void> {
    const rt = this.runtime(question.nodeId), requestId = question.id.slice(question.nodeId.length + 1);
    const request = rt.session?.pendingPermissions().find((request) => request.id === requestId);
    if (!rt.session || !request || !rt.turnId || rt.interrupting || this.paused(question.runId) || rt.turnId !== question.anchor?.turnId) throw new Error("Native question turn is no longer active");
    await rt.session.respondToPermission(requestId, { behavior: "allow", updatedInput: nativeUpdatedInput(request, question.prompts ?? nativePrompts(request), question.answers ?? {}) });
    this.armStall(question.nodeId);
  }
  private async onEvent(id: string, event: DriverEvent): Promise<void> {
    if (this.stopped) return;
    const rt = this.runtime(id), n = this.store.node(id);
    if (rt.closed || ["canceled", "replaced"].includes(n.status) || this.canceling.has(id)) return;
    this.armStall(id);
    if ((event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_canceled" || event.type === "item" || event.type === "usage") && "turnId" in event && event.turnId && rt.driverTurnId && event.turnId !== rt.driverTurnId) return;
    switch (event.type) {
      case "session": this.patchNode(id, { persistence: rt.session?.persistence() ?? undefined }); break;
      case "turn_started": if (rt.turnId) { rt.driverTurnId = event.turnId; this.emit(n.runId, { type: "turn.updated", turnId: rt.turnId, patch: { driverTurnId: event.turnId } }); } break;
      // The kernel records every prompt it sends as a user_message itself; drop provider echoes.
      case "item": if (event.item.type !== "user_message") this.addItem(id, event.item, event.timestamp); this.human.refreshActivity(id); break;
      case "usage": this.usage(id, event.usage); break;
      case "turn_completed": await this.finishTurn(id, "completed", event.usage); break;
      case "turn_failed": await this.finishTurn(id, "failed", undefined, event.error); break;
      case "turn_canceled": await this.finishTurn(id, "canceled", undefined, event.reason); break;
      case "permission_requested": {
        if (event.request.kind === "question" && !isBatonToolPermission(event.request)) {
          const prompts = nativePrompts(event.request);
          const question: QuestionRecord = { id: `${id}:${event.request.id}`, runId: n.runId, nodeId: id, question: prompts.map((prompt) => prompt.question).join("\n"), blocking: true, source: "native", delivery: "inline", prompts, anchor: this.questionAnchor(id, event.request.name, event.request.input), status: "pending", askedAt: now() };
          this.emit(n.runId, { type: "question", question }); this.human.refreshActivity(id); this.armStall(id); break;
        }
        const p: PermissionRecord = { id: `${id}:${event.request.id}`, runId: n.runId, nodeId: id, requestId: event.request.id, request: event.request, status: "pending", requestedAt: now() };
        this.emit(n.runId, { type: "permission", permission: p }); this.patchNode(id, { status: "waiting_permission", activity: event.request.title || event.request.name });
        // baton's own delegation tools never need a human: they only act on this node's own delegations.
        if (isBatonToolPermission(event.request)) await this.respondPermission(p.id, { behavior: "allow" }, "policy");
        else {
          const rule = this.rules.match(event.request, n);
          if (rule) await this.respondPermission(p.id, { behavior: rule.decision }, "rule", undefined, rule.id);
          else if (this.store.snapshot(n.runId).run.policy.autoApprove) await this.respondPermission(p.id, { behavior: "allow" }, "policy");
        }
        break;
      }
      case "permission_resolved": {
        const p = this.store.snapshot(n.runId).permissions.find((p) => p.id === `${id}:${event.requestId}`);
        if (p?.status === "pending") this.resolvePermission(p, event.response, "human"); break;
      }
      case "mode_changed": this.patchNode(id, { modeId: event.modeId ?? undefined }); break;
      case "model_changed": this.patchNode(id, { model: event.model ?? undefined }); break;
      case "closed": rt.closed = true; this.abandonMessages(id); if (rt.turnId) await this.finishTurn(id, "failed", undefined, event.error || "Agent session closed"); this.identities.delete(rt.token); rt.session = undefined; break;
    }
  }
  private addItem(id: string, incoming: TimelineItem, ts = now()): ItemRecord {
    const n = this.store.node(id), rt = this.runtime(id);
    let item = incoming;
    if (item.type === "tool_call") {
      const name = item.detail.type === "baton" ? item.detail.tool : item.name.replace(/^.*(?:mcp__baton__|baton__|baton\.|baton_)/, "");
      if (name in BATON_TOOLS) {
        const detail = item.detail;
        const output = detail.type === "baton" ? detail.output : detail.type === "unknown" ? detail.output : undefined;
        const input = detail.type === "baton" ? detail.input : detail.type === "unknown" ? detail.input : undefined;
        const getId = (value: unknown): string | undefined => {
          if (typeof value === "string") { try { return getId(JSON.parse(value) as unknown); } catch { return undefined; } }
          if (!value || typeof value !== "object") return undefined;
          if ("delegationId" in value && typeof value.delegationId === "string") return value.delegationId;
          if ("structuredContent" in value) return getId(value.structuredContent);
          if ("content" in value && Array.isArray(value.content)) for (const entry of value.content) { const id = entry && typeof entry === "object" && "text" in entry ? getId(entry.text) : undefined; if (id) return id; }
          return undefined;
        };
        item = { ...item, detail: { type: "baton", tool: name, delegationId: getId(output) ?? getId(input), input: input as JsonValue | undefined, output: output as JsonValue | undefined } };
      }
      const old = this.store.snapshot(n.runId).toolSpans.find((s) => s.id === `${id}:${item.type === "tool_call" ? item.callId : ""}`);
      // Additive runtime metadata until ToolSpanRecord exposes delegationId in the contract.
      const span: ToolSpanRecord & { delegationId?: string } = { id: `${id}:${item.callId}`, runId: n.runId, nodeId: id, turnId: rt.turnId, callId: item.callId, name: item.name, kind: item.detail.type, status: item.status, summary: item.detail.type === "shell" ? item.detail.command : item.name, startedAt: old?.startedAt ?? ts, ...(item.status !== "running" ? { endedAt: old?.endedAt ?? ts } : {}), ...(item.detail.type === "baton" && item.detail.delegationId ? { delegationId: item.detail.delegationId } : {}) };
      this.emit(n.runId, { type: "tool.span", span });
      this.patchNode(id, { activity: item.status === "running" ? item.name : "Thinking…" });
    } else if (item.type === "reasoning" || item.type === "assistant_message") this.patchNode(id, { activity: item.type === "reasoning" ? "Thinking…" : "Writing…" });
    const last = rt.lastItem;
    const text = item.type === "assistant_message" || item.type === "reasoning";
    const merge = text && last !== undefined && last.turnId === rt.turnId && last.item.type === item.type && (!("messageId" in item) || !("messageId" in last.item) || !item.messageId || !last.item.messageId || item.messageId === last.item.messageId);
    let row: ItemRecord;
    if (merge && last && (last.item.type === "assistant_message" || last.item.type === "reasoning") && (item.type === "assistant_message" || item.type === "reasoning")) {
      const mergedText = item.text.startsWith(last.item.text) ? item.text : last.item.text + item.text;
      row = { ...last, item: { ...item, text: mergedText } };
    } else {
      this.flushItem(id);
      const existing = this.store.items(id);
      // Tool updates replace their row instead of adding duplicate calls to the transcript.
      const previous = item.type === "tool_call" ? existing.find((r) => r.item.type === "tool_call" && r.item.callId === (item.type === "tool_call" ? item.callId : "")) : undefined;
      row = { nodeId: id, seq: previous?.seq ?? (existing.at(-1)?.seq ?? 0) + 1, turnId: item.type === "user_message" && item.delivery === "queued" ? undefined : rt.turnId, ts: previous?.ts ?? ts, item };
    }
    rt.lastItem = row;
    if (row.item.type === "assistant_message") rt.finalText = row.item.text;
    if (text) { rt.pendingItem = row; rt.itemTimer ??= setTimeout(() => this.flushItem(id), 100); }
    else this.store.appendItem(n.runId, row);
    if (item.type === "tool_call") {
      for (const question of this.store.snapshot(n.runId).questions) {
        if (question.nodeId !== id || question.status !== "pending" || question.anchor?.itemSeq || question.anchor?.turnId !== rt.turnId) continue;
        const request = question.source === "native" ? rt.session?.pendingPermissions().find((request) => question.id === `${id}:${request.id}`) : undefined;
        if (question.source === "ask_human" ? item.name.endsWith("ask_human") : question.anchor?.callId === item.callId || request?.name === item.name) this.emit(n.runId, { type: "question", question: { ...question, anchor: { ...question.anchor, itemSeq: row.seq, callId: item.callId } } });
      }
    }
    return row;
  }
  private flushItem(id: string): void {
    const rt = this.runtimes.get(id); if (!rt) return;
    clearTimeout(rt.itemTimer); rt.itemTimer = undefined;
    if (rt.pendingItem) { this.store.appendItem(this.store.node(id).runId, rt.pendingItem); rt.pendingItem = undefined; }
  }
  private usage(id: string, usage: Usage): void {
    const rt = this.runtime(id), n = this.store.node(id);
    const next = { inputTokens: usage.inputTokens ?? rt.usage.inputTokens, cachedInputTokens: usage.cachedInputTokens ?? rt.usage.cachedInputTokens, outputTokens: usage.outputTokens ?? rt.usage.outputTokens, costUsd: usage.totalCostUsd ?? rt.usage.costUsd };
    const delta = { inputTokens: Math.max(0, next.inputTokens - rt.usage.inputTokens), cachedInputTokens: Math.max(0, next.cachedInputTokens - rt.usage.cachedInputTokens), outputTokens: Math.max(0, next.outputTokens - rt.usage.outputTokens), costUsd: Math.max(0, next.costUsd - rt.usage.costUsd) };
    rt.usage = next;
    this.patchNode(id, { usage: addUsage(n.usage, delta) });
    const s = this.store.snapshot(n.runId);
    this.emit(n.runId, { type: "run.updated", patch: { usage: addUsage(s.run.usage, delta), updatedAt: now() } });
    let current: NodeRecord | undefined = n;
    while (current?.delegationId) {
      const d = this.store.delegation(current.delegationId); this.patchDelegation(d.id, { subtreeUsage: addUsage(d.subtreeUsage, delta) });
      current = current.parentNodeId ? this.store.node(current.parentNodeId) : undefined;
    }
  }
  private async finishTurn(id: string, status: "completed" | "failed" | "canceled", usage?: Usage, error?: string): Promise<void> {
    const rt = this.runtime(id), n = this.store.node(id); if (!rt.turnId) return;
    const interrupted = rt.interrupting === rt.turnId;
    if (interrupted) { status = "canceled"; error = rt.interruptReason ?? HUMAN_INTERRUPT; }
    if (status === "canceled" && !interrupted) this.abandonMessages(id);
    if (usage) this.usage(id, usage);
    this.flushItem(id);
    this.patchNode(id, { persistence: rt.session?.persistence() ?? undefined });
    const turnId = rt.turnId; rt.turnId = undefined; clearTimeout(rt.stallTimer);
    this.human.endQuestions(id, error ?? `Turn ${status}`, false, turnId);
    this.emit(n.runId, { type: "turn.updated", turnId, patch: { status, endedAt: now(), usage: { inputTokens: rt.usage.inputTokens, cachedInputTokens: rt.usage.cachedInputTokens, outputTokens: rt.usage.outputTokens, totalCostUsd: rt.usage.costUsd }, error } });
    for (const p of this.store.snapshot(n.runId).permissions) if (p.nodeId === id && p.status === "pending") this.emit(n.runId, { type: "permission", permission: { ...p, status: "expired", resolvedAt: now() } });
    for (const span of this.store.snapshot(n.runId).toolSpans) if (span.nodeId === id && span.status === "running") this.emit(n.runId, { type: "tool.span", span: { ...span, status: status === "completed" ? "completed" : status, endedAt: now() } });
    if (interrupted) {
      // A human redirect ends only this turn: no result capture, terminal node state,
      // descendant cancellation, or queue drain. The caller starts the replacement turn.
      this.patchNode(id, { status: "idle", activity: error === PAUSE_REASON ? "Paused" : "Interrupted by human message" });
      this.updateRun(n.runId);
      return;
    }
    const blocking = this.store.snapshot(n.runId).questions.find((q) => q.nodeId === id && q.blocking && q.status === "pending");
    if (status === "completed" && blocking && !rt.report) {
      this.patchNode(id, { status: "idle", activity: `等你回答: ${blocking.question}` }); this.updateRun(n.runId); this.armIdle(id); await this.drainMessages(id); await this.deliver(id); return;
    }
    if (n.delegationId) {
      const d = this.store.delegation(n.delegationId);
      const result: DelegationResult = { status: status === "completed" ? rt.report?.status ?? "success" : "failed", summary: rt.report?.summary ?? (rt.finalText || error || "No final response"), result: rt.report?.result as JsonValue | undefined, artifacts: rt.report?.artifacts, reported: !!rt.report, finalText: rt.finalText, error };
      const errors = d.brief.outputSchema && status === "completed" ? validateSchema(d.brief.outputSchema, result.result) : [];
      if (errors.length && rt.corrections < 2) {
        rt.corrections++; this.patchNode(id, { status: "idle", activity: "Correcting result" });
        await this.startTurn(id, correctionPrompt(errors), "correction"); return;
      }
      if (errors.length) { result.status = "failed"; result.error = `Output schema invalid after 2 corrections: ${errors.join("; ")}`; }
      const finalStatus = status === "canceled" ? "canceled" : result.status === "failed" ? "failed" : "completed";
      this.patchNode(id, { status: finalStatus, endedAt: now(), activity: result.summary.slice(0, 120), error: result.error });
      this.patchDelegation(d.id, { status: finalStatus, result, endedAt: now() }); this.scheduleDelivery(d.fromNodeId);
    } else this.patchNode(id, { status: status === "completed" ? "idle" : status, activity: status === "completed" ? "Idle" : error, error });
    this.human.refreshActivity(id);
    this.updateRun(n.runId);
    this.armIdle(id);
    await this.drainMessages(id);
    await this.deliver(id);
  }
  private failNode(id: string, error: unknown): void {
    const n = this.store.node(id); if (["canceled", "replaced"].includes(n.status) || this.canceling.has(id) || this.stopped) return;
    const message = error instanceof Error ? error.message : String(error);
    const rt = this.runtime(id); clearTimeout(rt.stallTimer); this.abandonMessages(id);
    if (rt.turnId) { this.emit(n.runId, { type: "turn.updated", turnId: rt.turnId, patch: { status: "failed", error: message, endedAt: now() } }); rt.turnId = undefined; }
    this.patchNode(id, { status: "failed", error: message, activity: message, endedAt: now() });
    if (n.delegationId) { const d = this.store.delegation(n.delegationId); this.patchDelegation(d.id, { status: "failed", result: { status: "failed", summary: message, finalText: "", reported: false, error: message }, endedAt: now() }); this.scheduleDelivery(d.fromNodeId); }
    this.updateRun(n.runId);
  }
  private armIdle(id: string): void {
    const rt = this.runtime(id); clearTimeout(rt.idleTimer);
    rt.idleTimer = setTimeout(() => {
      if (rt.turnId || this.paused(this.store.node(id).runId)) return;
      const n = this.store.node(id);
      const s = this.store.snapshot(n.runId);
      if (s.questions.some((q) => q.nodeId === id && q.status === "pending") || s.run.team?.proposals.some((p) => p.status === "pending") || this.store.notices(id).length || s.nodes.some((node) => active(node.status)) || s.delegations.some((d) => !done(d) || (d.status !== "replaced" && !d.deliveredAt))) { this.armIdle(id); return; }
      void this.closeSession(id).then(() => {
        if (!n.parentNodeId && n.status === "idle") { this.patchNode(id, { status: "completed", endedAt: now() }); this.updateRun(n.runId); }
      }).catch((e: unknown) => this.log(n.runId, e));
    }, this.options.idleTimeoutMs ?? 30 * 60 * 1000); rt.idleTimer.unref();
  }
  private updateRun(runId: string): void {
    const s = this.store.snapshot(runId), root = s.nodes.find((n) => n.id === s.run.rootNodeId);
    if (!root) return;
    const status: RunStatus = root.status === "canceled" ? "canceled" : s.run.status === "paused" ? "paused" : s.nodes.some((n) => active(n.status)) || s.delegations.some((d) => active(d.status)) ? "active" : root.status === "failed" ? "failed" : root.status === "completed" ? "completed" : "idle";
    const patch = { status, updatedAt: now(), endedAt: ["completed", "failed", "canceled"].includes(status) ? now() : undefined };
    if (s.run.endedAt && patch.endedAt === undefined) this.emit(runId, { type: "run.created", run: { ...s.run, ...patch } });
    else this.emit(runId, { type: "run.updated", patch });
  }
  private scheduleDelivery(parentId: string): void {
    clearTimeout(this.deliveryTimers.get(parentId));
    this.deliveryTimers.set(parentId, setTimeout(() => { this.deliveryTimers.delete(parentId); void this.deliver(parentId).catch((e: unknown) => this.log(this.store.node(parentId).runId, e)); }, this.options.deliveryDebounceMs ?? 1500));
  }
  private delivered(d: DelegationRecord, via: NonNullable<DelegationRecord["deliveredVia"]>): void {
    if (!d.deliveredAt) this.patchDelegation(d.id, { deliveredAt: now(), deliveredVia: via });
  }
  private async deliver(parentId: string): Promise<void> {
    if (this.stopped || this.deliveryTimers.has(parentId) || this.delivering.has(parentId) || this.canceling.has(parentId)) return;
    this.delivering.add(parentId);
    try {
    const parent = this.store.node(parentId), rt = this.runtime(parentId);
    if (rt.interrupting || this.paused(parent.runId) || this.resuming.has(parent.runId)) return;
    if (["canceled", "failed", "replaced"].includes(parent.status)) return;
    const pending = this.store.snapshot(parent.runId).delegations.filter((d) => d.fromNodeId === parentId && done(d) && d.status !== "replaced" && !this.replacing.has(d.id) && d.result && !d.deliveredAt);
    const notices = this.store.notices(parentId);
    if (!pending.length && !notices.length) return;
    const text = [pending.length ? resultsPrompt(pending) : "", ...notices.map((notice) => notice.text)].filter(Boolean).join("\n\n");
    if (rt.turnId) {
      const turnId = rt.turnId;
      // Reserve before awaiting the provider so a concurrent delivery cannot enqueue the
      // same results. A failed/unsupported steer releases the reservation.
      for (const d of pending) this.delivered(d, "steer");
      let outcome: Awaited<ReturnType<DriverSession["steer"]>> | undefined;
      try { outcome = await rt.session?.steer(this.promptFor(parentId, text)); }
      catch (error) { for (const d of pending) this.patchDelegation(d.id, { deliveredAt: undefined, deliveredVia: undefined }); throw error; }
      if (outcome !== "steered" || this.interruptedTurn(parentId, turnId)) {
        for (const d of pending) this.patchDelegation(d.id, { deliveredAt: undefined, deliveredVia: undefined });
        if (!rt.turnId) this.scheduleDelivery(parentId);
        return;
      }
      this.store.deleteNotices(notices.map((notice) => notice.id));
      this.addItem(parentId, { type: "user_message", text });
    } else {
      // Mark before starting a new provider turn, which can synchronously call get_result.
      for (const d of pending) this.delivered(d, "turn");
      try { await this.startTurn(parentId, text, text.includes("<baton-answer ") ? "user" : "result"); this.store.deleteNotices(notices.map((notice) => notice.id)); }
      catch (error) { for (const d of pending) this.patchDelegation(d.id, { deliveredAt: undefined, deliveredVia: undefined }); throw error; }
    }
    } finally { this.delivering.delete(parentId); }
  }
  async respondPermission(id: string, response: PermissionResponse, by: "human" | "policy" | "rule" = "human", remember?: PermissionDecision["remember"], ruleId?: string): Promise<void> {
    const nodeId = id.includes(":") ? id.slice(0, id.indexOf(":")) : undefined;
    const p = nodeId ? this.store.snapshot(this.store.node(nodeId).runId).permissions.find((p) => p.id === id) : this.store.list().flatMap((r) => this.store.snapshot(r.id).permissions).find((p) => p.requestId === id && p.status === "pending");
    if (!p || p.status !== "pending") throw new Error("Pending permission not found");
    if (!response || !["allow", "deny"].includes(response.behavior)) throw new Error("Invalid permission response");
    const session = this.runtime(p.nodeId).session; if (!session) throw new Error("Session unavailable");
    if (this.decidingPermissions.has(p.id)) throw new Error("Permission decision is already in progress");
    this.decidingPermissions.add(p.id);
    try {
    if (by === "human" && response.behavior === "deny") response = { ...response, message: HUMAN_DENIAL };
    if (by === "human" && remember) this.rules.remember(p, remember, this.store.node(p.nodeId), response.behavior, false);
    await session.respondToPermission(p.requestId, response);
    if (by === "human" && remember) this.rules.remember(p, remember, this.store.node(p.nodeId), response.behavior);
    this.resolvePermission(p, response, by, ruleId);
    } finally { this.decidingPermissions.delete(p.id); }
  }
  private resolvePermission(p: PermissionRecord, response: PermissionResponse, by: "human" | "policy" | "rule", ruleId?: string): void {
    this.emit(p.runId, { type: "permission", permission: { ...p, status: "resolved", resolution: response, resolvedBy: by, ruleId, resolvedAt: now() } });
    const pending = this.store.snapshot(p.runId).permissions.some((other) => other.nodeId === p.nodeId && other.status === "pending");
    this.patchNode(p.nodeId, { status: pending ? "waiting_permission" : "running", activity: pending ? "Waiting for permission" : "Thinking…" });
    this.human.refreshActivity(p.nodeId);
  }
  async cancelNode(id: string, reason = "Canceled by human", replacing = false): Promise<void> {
    const n = this.store.node(id), s = this.store.snapshot(n.runId);
    if (n.status === "replaced") throw new Error("Node was replaced; cancel its successor instead");
    const subtree = new Set([id]);
    for (const node of [...s.nodes].sort((a, b) => a.depth - b.depth)) if (node.parentNodeId && subtree.has(node.parentNodeId)) subtree.add(node.id);
    for (const descendant of subtree) this.canceling.add(descendant);
    for (const d of s.delegations) if (subtree.has(d.fromNodeId) && d.blockedByProposal && d.status === "queued") this.patchDelegation(d.id, { status: "canceled", endedAt: now(), result: { status: "failed", summary: reason, finalText: "", reported: false } });
    for (const child of s.nodes.filter((child) => child.parentNodeId === id && child.status !== "replaced")) await this.cancelNode(child.id, reason);
    const rt = this.runtime(id); rt.closed = true; this.abandonMessages(id);
    this.human.endQuestions(id, reason);
    clearTimeout(this.deliveryTimers.get(id)); this.deliveryTimers.delete(id);
    if (rt.session) await rt.session.interrupt().catch((error: unknown) => this.log(n.runId, error, id));
    this.flushItem(id);
    if (rt.turnId) { this.emit(n.runId, { type: "turn.updated", turnId: rt.turnId, patch: { status: "canceled", endedAt: now(), error: reason } }); rt.turnId = undefined; }
    await this.closeSession(id).catch((error: unknown) => this.log(n.runId, error, id));
    for (const p of this.store.snapshot(n.runId).permissions) if (p.nodeId === id && p.status === "pending") this.emit(n.runId, { type: "permission", permission: { ...p, status: "expired", resolvedAt: now() } });
    for (const span of this.store.snapshot(n.runId).toolSpans) if (span.nodeId === id && span.status === "running") this.emit(n.runId, { type: "tool.span", span: { ...span, status: "canceled", endedAt: now() } });
    this.patchNode(id, { status: "canceled", activity: reason, endedAt: now() });
    if (n.delegationId && !replacing) { const d = this.store.delegation(n.delegationId); this.patchDelegation(d.id, { status: "canceled", endedAt: now(), result: { status: "failed", summary: reason, finalText: "", reported: false } }); this.scheduleDelivery(d.fromNodeId); }
    this.updateRun(n.runId);
  }
  async cancelRun(id: string): Promise<void> {
    const s = this.store.snapshot(id);
    for (const node of s.nodes) this.human.endQuestions(node.id, "Run canceled", true);
    await this.cancelNode(s.run.rootNodeId);
  }
  async pauseRun(id: string): Promise<RunSnapshot["run"]> {
    const run = this.store.snapshot(id).run;
    if (this.pausing.has(id)) { await this.pausing.get(id); return this.store.snapshot(id).run; }
    if (run.status === "paused") return run;
    if (["completed", "failed", "canceled"].includes(run.status)) throw new MessageError("A terminal run cannot be paused");
    this.emit(id, { type: "run.updated", patch: { status: "paused", pauses: [...run.pauses ?? [], { at: now(), by: "human" }], updatedAt: now() } });
    const running = this.store.snapshot(id).nodes.filter((node) => this.runtime(node.id).turnId);
    for (const node of running) {
      const rt = this.runtime(node.id); this.store.rememberPausedNode(id, node.id);
      rt.interrupting = rt.turnId; rt.interruptReason = PAUSE_REASON; clearTimeout(rt.stallTimer); this.persistQueue(node.id);
    }
    const work = Promise.all(running.map(async (node) => {
      const rt = this.runtime(node.id), turnId = rt.turnId;
      try {
        await rt.starting?.catch(() => {});
        await rt.session?.interrupt(); await rt.chain;
        if (rt.turnId === turnId) await this.finishTurn(node.id, "canceled", undefined, PAUSE_REASON);
      } finally { rt.interrupting = undefined; rt.interruptReason = undefined; }
    })).then(() => {});
    this.pausing.set(id, work);
    try { await work; } finally { this.pausing.delete(id); }
    return this.store.snapshot(id).run;
  }
  async resumeRun(id: string): Promise<RunSnapshot["run"]> {
    await this.pausing.get(id);
    const run = this.store.snapshot(id).run;
    if (run.status !== "paused") throw new MessageError("Run is not paused");
    const interrupted = new Set(this.store.pausedNodes(id)); this.resuming.add(id);
    const resumePrompt = run.pauses?.at(-1)?.by === "restart" ? RESTART_RESUME_PROMPT : RESUME_PROMPT;
    this.emit(id, { type: "run.updated", patch: { status: "active", pauses: (run.pauses ?? []).map((pause, index, list) => index === list.length - 1 && !pause.resumedAt ? { ...pause, resumedAt: now() } : pause), updatedAt: now() } });
    try {
      for (const node of this.store.snapshot(id).nodes) {
        if (["canceled", "replaced"].includes(node.status)) { this.store.forgetPausedNode(node.id); continue; }
        const rt = this.runtime(node.id);
        const prompts: QueuedPrompt[] = interrupted.has(node.id) ? [{ text: resumePrompt, trigger: "resume" }] : [];
        const pending = this.store.snapshot(id).delegations.filter((d) => d.fromNodeId === node.id && done(d) && d.status !== "replaced" && d.result && !d.deliveredAt);
        const notices = this.store.notices(node.id);
        const content = [pending.length ? resultsPrompt(pending) : "", ...notices.map((notice) => notice.text)].filter(Boolean).join("\n\n");
        if (content) prompts.push({ text: content, trigger: "result" });
        prompts.push(...rt.queued.splice(0)); this.persistQueue(node.id);
        // A queued delegate may have been created just before a restart, before its
        // scheduled first prompt was persisted. Reconstruct the assignment in that case.
        if (!prompts.length && node.delegationId && node.turns === 0) {
          const d = this.store.delegation(node.delegationId); if (d.status === "queued" && !d.blockedByProposal) prompts.push({ text: briefPrompt(d), trigger: "delegation" });
        }
        if (prompts.length) {
          for (const d of pending) this.delivered(d, "turn");
          try { await this.startPrompts(node.id, prompts); this.store.deleteNotices(notices.map((notice) => notice.id)); }
          catch (error) { for (const d of pending) this.patchDelegation(d.id, { deliveredAt: undefined, deliveredVia: undefined }); throw error; }
        }
        this.store.forgetPausedNode(node.id);
      }
    } finally { this.resuming.delete(id); }
    this.updateRun(id);
    for (const node of this.store.snapshot(id).nodes) this.scheduleDelivery(node.id);
    return this.store.snapshot(id).run;
  }
  private async closeSession(id: string, preserveQueue = false): Promise<void> {
    const rt = this.runtime(id); clearTimeout(rt.idleTimer); clearTimeout(rt.stallTimer); this.identities.delete(rt.token); rt.unsubscribe?.(); rt.closed = true; if (preserveQueue) this.persistQueue(id); else this.abandonMessages(id);
    await rt.opening?.catch(() => {});
    await rt.session?.close(); rt.session = undefined;
    for (const finish of this.waits.get(id) ?? []) finish(); this.waits.delete(id);
  }
  async shutdown(): Promise<void> {
    this.stopped = true; this.titleController.abort();
    this.human.shutdown();
    for (const waits of this.waits.values()) for (const finish of waits) finish(); this.waits.clear();
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer); this.deliveryTimers.clear();
    await Promise.all([...this.runtimes].map(async ([id, rt]) => {
      this.flushItem(id); rt.unsubscribe?.(); clearTimeout(rt.idleTimer);
      const pids = await descendantProcessIds(rt.session?.processIds?.() ?? []);
      let timer: NodeJS.Timeout | undefined;
      const force = new Promise<void>((resolve) => { timer = setTimeout(() => { void descendantProcessIds([...pids, ...(rt.session?.processIds?.() ?? [])]).then(terminateProcessIds).catch(() => {}).finally(resolve); }, 5000); });
      const closing = (async () => { try { await rt.session?.interrupt(); } finally { await this.closeSession(id, this.paused(this.store.node(id).runId)); } })();
      try { await Promise.race([closing, force]); } finally { clearTimeout(timer); await terminateProcessIds(pids); }
    }));
    await this.registry.shutdown();
    await Promise.all([...this.runtimes.values()].map((rt) => rt.chain));
  }
}
