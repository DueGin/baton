/**
 * Persistent records (projections of the event log). Single source of truth for the data model;
 * semantics in docs/DESIGN.md §3–§4.
 */
import type { JsonValue, PermissionRequest, PermissionResponse, Usage } from "./timeline.js";

/** ISO-8601 timestamps everywhere (`new Date().toISOString()`). */
export type IsoTime = string;

// ───────────────────────────── catalog ─────────────────────────────

export type AgentKind = "native" | "acp";
export type AgentAvailability = "ready" | "unavailable" | "error" | "loading";

export interface AgentModel {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  /** Thinking/reasoning levels the model accepts, if any. */
  thinkingOptions?: Array<{ id: string; label: string; isDefault?: boolean }>;
}

export interface AgentModeInfo {
  id: string;
  label: string;
  description?: string;
  /** True when the mode runs tools without asking (bypass / full-access style). */
  isUnattended?: boolean;
  /** True when the mode cannot modify files (plan / read-only style). */
  isReadOnly?: boolean;
}

export interface AgentEntry {
  /** Stable id used everywhere: "claude", "codex", "pi", "gemini", … or a custom id from config. */
  id: string;
  label: string;
  kind: AgentKind;
  status: AgentAvailability;
  enabled: boolean;
  /** Resolved executable path(s) and `--version` output when available. */
  command?: string[];
  version?: string;
  /** Human-readable reason when not ready (binary missing, probe failed, …). */
  diagnostic?: string;
  models: AgentModel[];
  modes: AgentModeInfo[];
  defaultModeId?: string | null;
  /** From config profiles: when the orchestrating agent should pick this agent. */
  notes?: string;
  capabilities: {
    steer: boolean;
    resume: boolean;
    reasoning: boolean;
    mcp: boolean;
  };
  checkedAt: IsoTime;
}

// ───────────────────────────── run / node / delegation ─────────────────────────────

/**
 * How a run collaborates (DESIGN §4.5):
 * - "dynamic": the root is the lead; it forms a team for the request (form_team), delegates by role,
 *   and may replace members or reassign tasks at any time.
 * - "preset": the team comes from a saved TeamPreset; the root is the preset's lead and delegates only
 *   to the preset's roles (members can still be replaced).
 * - "solo": the root does everything itself; no delegation tools are injected.
 */
export type CollaborationMode = "dynamic" | "preset" | "solo";

export type RunStatus = "active" | "idle" | "completed" | "failed" | "canceled";

export interface RunPolicy {
  /** Max delegation depth below the root (root depth = 0). */
  maxDepth: number;
  /** Max simultaneously active child delegations per parent node. */
  maxActiveChildren: number;
  /** Auto-approve permission requests of every node in the run (recorded as by: "policy"). */
  autoApprove: boolean;
  /** Collaboration mode; default "dynamic". */
  mode?: CollaborationMode;
  /**
   * Roster changes proposed by agents (form_team, replace_member, ad-hoc members) wait for the
   * human to approve them in the console before they take effect. Default true. Human changes
   * always apply immediately.
   */
  teamApproval?: boolean;
  /** Max active members on a team (form_team / additions beyond it are rejected). Default 5. */
  maxTeamSize?: number;
  /** A node with an active turn and no events for this long raises a "stall" escalation. Default 10. */
  stallMinutes?: number;
  /** A parent's `send` beyond this many rounds of one delegation is escalated to the human. Default 3. */
  maxRoundsPerDelegation?: number;
  /** Optional run budget; exceeding it rejects new delegations and cancels nothing by itself. */
  budget?: { maxCostUsd?: number; maxTokens?: number; maxWallMinutes?: number };
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// ───────────────────────────── team ─────────────────────────────

/** A role slot: which agent (and model/mode) does a kind of work. Delegating to a role opens a new
 * node with this spec; one member can have several delegations. */
export interface TeamMemberSpec {
  /** Unique within the team, short and descriptive: "frontend", "assets", "reviewer"… */
  role: string;
  agentId: string;
  model?: string;
  modeId?: string;
  thinking?: string;
  /** What this role is responsible for; shown to the lead and to the member's delegates. */
  responsibilities?: string;
}

export type TeamActor = "human" | "lead" | "preset" | "agent";

export interface TeamMember extends TeamMemberSpec {
  id: string;
  status: "active" | "replaced" | "removed";
  addedBy: TeamActor;
  addedAt: IsoTime;
  /** Why this member was chosen (or, once replaced/removed, why it left). */
  reason?: string;
  /** Member id that took over this role. */
  replacedBy?: string;
  /** Member id this one took over from. */
  replaces?: string;
}

/** A roster change an agent asked for, waiting for (or decided by) the human. */
export interface TeamProposal {
  id: string;
  kind: "formation" | "addition" | "replacement";
  status: "pending" | "approved" | "rejected";
  by: "lead" | "agent";
  /** Node that proposed it. */
  nodeId: string;
  proposedAt: IsoTime;
  rationale?: string;
  /** formation / addition: the proposed members. */
  members?: TeamMemberSpec[];
  /** replacement: which member, by whom, and whether its unfinished work moves along. */
  replace?: { memberId: string; with: TeamMemberSpec; reassignActive: boolean; reason: string };
  decidedAt?: IsoTime;
  /** What the human actually approved when they edited the proposal (same shape as members/replace.with). */
  approvedMembers?: TeamMemberSpec[];
  approvedReplacement?: TeamMemberSpec;
  /** Human note on approval, or the reason for rejection; forwarded to the proposing node. */
  feedback?: string;
}

export interface TeamChange {
  kind:
    | "proposed"
    | "approved"
    | "rejected"
    | "formed"
    | "member_added"
    | "member_replaced"
    | "member_removed";
  by: TeamActor;
  at: IsoTime;
  memberId?: string;
  previousMemberId?: string;
  proposalId?: string;
  reason?: string;
}

export interface TeamRecord {
  source: "dynamic" | "preset";
  presetId?: string;
  presetName?: string;
  /** The lead's explanation of the team design (form_team rationale). */
  rationale?: string;
  /** All members ever, including replaced/removed ones (status tells). */
  members: TeamMember[];
  /** Roster history, oldest first. */
  changes: TeamChange[];
  /** Agent-proposed changes (all of them; at most one is "pending" at a time). */
  proposals: TeamProposal[];
  updatedAt: IsoTime;
}

export interface TeamPreset {
  id: string;
  name: string;
  description?: string;
  /** Agent that runs the root node when a run uses this preset. */
  lead: { agentId: string; model?: string; modeId?: string; thinking?: string };
  members: TeamMemberSpec[];
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface RunRecord {
  id: string;
  title: string;
  cwd: string;
  status: RunStatus;
  rootNodeId: string;
  policy: RunPolicy;
  /** Present in dynamic runs once a team is formed, and in preset runs from the start. */
  team?: TeamRecord;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  endedAt?: IsoTime;
  /** Sum over all nodes. */
  usage: UsageTotals;
}

export type NodeStatus =
  | "starting"
  | "running"
  | "idle"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "canceled"
  /** Its delegation was reassigned to another agent; see the delegation's replacedBy. */
  | "replaced"
  | "interrupted";

export const TERMINAL_NODE_STATUSES: readonly NodeStatus[] = ["completed", "failed", "canceled", "replaced"];

export interface NodeRecord {
  id: string;
  runId: string;
  /** null for the root node. */
  parentNodeId: string | null;
  /** The delegation that created this node; null for the root. */
  delegationId: string | null;
  depth: number;
  agentId: string;
  /** Team role this node works as (delegations to a role), if any. */
  role?: string;
  memberId?: string;
  model?: string;
  modeId?: string;
  thinking?: string;
  title: string;
  cwd: string;
  status: NodeStatus;
  /** Last error message when status is failed / interrupted. */
  error?: string;
  /** Short live activity text for cards, e.g. "shell: npm test" or "thinking…". */
  activity?: string;
  /** Provider persistence handle (opaque JSON) used to resume after restart. */
  persistence?: JsonValue;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  endedAt?: IsoTime;
  usage: UsageTotals;
  /** Count of turns so far. */
  turns: number;
}

export type DelegationKind = "delegate";
export type DelegationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  /** Reassigned to another agent; `replacedBy` is the delegation that took over. */
  | "replaced"
  | "interrupted";

export interface DelegationBrief {
  title: string;
  task: string;
  context?: string;
  acceptance?: string[];
  readonly?: boolean;
  /** JSON Schema the child's `result` must satisfy. */
  outputSchema?: Record<string, JsonValue>;
}

export interface DelegationResult {
  status: "success" | "partial" | "failed";
  summary: string;
  /** Structured result (validated against brief.outputSchema when given). */
  result?: JsonValue;
  artifacts?: Array<{ kind: "file" | "url" | "note"; value: string; description?: string }>;
  /** False when the child ended its turn without calling report_result (summary = final message). */
  reported: boolean;
  /** Full text of the child's final assistant message for the round. */
  finalText: string;
  error?: string;
}

export interface DelegationRecord {
  id: string;
  runId: string;
  kind: DelegationKind;
  fromNodeId: string;
  toNodeId: string;
  brief: DelegationBrief;
  status: DelegationStatus;
  /** Team role / member the work was delegated to, if delegated by role. */
  role?: string;
  memberId?: string;
  /** Set while a "queued" delegation waits for a pending team proposal to be approved. */
  blockedByProposal?: string;
  /** Delegation this one took over from (reassignment), and the one that took over from it. */
  replaces?: string;
  replacedBy?: string;
  /** Why it was reassigned (on the replaced delegation). */
  replaceReason?: string;
  /** 1 for the first assignment; +1 for every follow-up `send` that reopens it. */
  round: number;
  result?: DelegationResult;
  createdAt: IsoTime;
  startedAt?: IsoTime;
  endedAt?: IsoTime;
  /** When the latest result reached the parent (steer, new turn, or wait). */
  deliveredAt?: IsoTime;
  deliveredVia?: "steer" | "turn" | "wait" | "get_result";
  /** Usage of the child subtree (child + all descendants). */
  subtreeUsage: UsageTotals;
}

export type TurnTrigger = "user" | "delegation" | "result" | "followup" | "correction";
export type TurnStatus = "running" | "completed" | "failed" | "canceled" | "interrupted";

export interface TurnRecord {
  /** Server-assigned id, unique in the run. */
  id: string;
  runId: string;
  nodeId: string;
  /** Driver turn id when known. */
  driverTurnId?: string;
  trigger: TurnTrigger;
  /** Delegation that caused this turn (trigger delegation/result/followup/correction). */
  delegationId?: string;
  status: TurnStatus;
  startedAt: IsoTime;
  endedAt?: IsoTime;
  usage?: Usage;
  error?: string;
}

export interface ToolSpanRecord {
  /** `${nodeId}:${callId}` */
  id: string;
  runId: string;
  nodeId: string;
  turnId?: string;
  callId: string;
  name: string;
  kind: string;
  /** Set when the call is one of baton's own tools acting on a delegation. */
  delegationId?: string;
  status: "running" | "completed" | "failed" | "canceled";
  /** One-line summary for timeline tooltips (command, file path, query, …). */
  summary?: string;
  startedAt: IsoTime;
  endedAt?: IsoTime;
}

export interface PermissionRecord {
  /** `${nodeId}:${requestId}` */
  id: string;
  runId: string;
  nodeId: string;
  requestId: string;
  request: PermissionRequest;
  status: "pending" | "resolved" | "expired";
  resolution?: PermissionResponse;
  resolvedBy?: "human" | "policy" | "parent" | "rule";
  /** PermissionRule that decided it (resolvedBy "rule"). */
  ruleId?: string;
  requestedAt: IsoTime;
  resolvedAt?: IsoTime;
}

/** Stored transcript row (merged chunks). */
export interface ItemRecord {
  /** Monotonic per node, starting at 1. */
  seq: number;
  nodeId: string;
  turnId?: string;
  ts: IsoTime;
  item: import("./timeline.js").TimelineItem;
}

// ───────────────────────────── human-in-the-loop (inbox) ─────────────────────────────

/** A question an agent asked the human with ask_human. */
export interface QuestionRecord {
  id: string;
  runId: string;
  nodeId: string;
  question: string;
  /** Suggested answers rendered as buttons; free text is always allowed. */
  options?: string[];
  /** True when the node stopped and waits for the answer (it ended its turn). */
  blocking: boolean;
  status: "pending" | "answered" | "canceled";
  answer?: string;
  askedAt: IsoTime;
  answeredAt?: IsoTime;
}

/** Something the kernel hands to the human because agents should not decide it alone. */
export interface EscalationRecord {
  id: string;
  runId: string;
  nodeId: string;
  delegationId?: string;
  kind: "stall" | "round_limit";
  /** Human-readable explanation (who, how long / how many rounds, last activity). */
  detail: string;
  /** round_limit: the follow-up message the parent tried to send (delivered if the human extends). */
  pendingMessage?: string;
  status: "pending" | "resolved";
  resolution?: "extend" | "cancel" | "dismiss";
  /** Optional note from the human, forwarded to the parent in a <baton-notice>. */
  note?: string;
  createdAt: IsoTime;
  resolvedAt?: IsoTime;
}

/** A remembered permission decision, matched deterministically before asking the human. */
export interface PermissionRule {
  id: string;
  /** Limit to one agent id; omitted = any agent. */
  agentId?: string;
  /** Permission request name (tool), exact match, case-insensitive; "*" = any. */
  toolName: string;
  /**
   * Optional input matcher. Shell requests: command prefix after whitespace normalisation
   * ("npm test" matches "npm test -- --watch"). File requests (read/edit/write): glob on the path
   * relative to the run cwd ("src/**"). Omitted = any input.
   */
  pattern?: string;
  decision: "allow" | "deny";
  scope: "global" | "run";
  /** Set when scope is "run". */
  runId?: string;
  /** Permission record the rule was created from. */
  createdFrom?: string;
  createdAt: IsoTime;
  hits: number;
  lastHitAt?: IsoTime;
}

/** One entry of the cross-run "待处理" inbox. */
export type InboxItem =
  | { kind: "permission"; runId: string; runTitle: string; permission: PermissionRecord }
  | { kind: "proposal"; runId: string; runTitle: string; proposal: TeamProposal }
  | { kind: "question"; runId: string; runTitle: string; question: QuestionRecord }
  | { kind: "escalation"; runId: string; runTitle: string; escalation: EscalationRecord };

export interface RunSnapshot {
  run: RunRecord;
  nodes: NodeRecord[];
  delegations: DelegationRecord[];
  turns: TurnRecord[];
  toolSpans: ToolSpanRecord[];
  permissions: PermissionRecord[];
  questions: QuestionRecord[];
  escalations: EscalationRecord[];
  /** Last event seq included in this snapshot; subscribe with after=lastSeq. */
  lastSeq: number;
}

export interface RunSummary {
  id: string;
  title: string;
  status: RunStatus;
  cwd: string;
  rootAgentId: string;
  agents: string[];
  nodeCount: number;
  activeNodeCount: number;
  pendingPermissions: number;
  /** Pending permissions + proposals + questions + escalations. */
  pendingTotal: number;
  usage: UsageTotals;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  endedAt?: IsoTime;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
}
