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
  /** How to install it when unavailable (shown on the Agents page), e.g. "npm i -g opencode-ai". */
  installHint?: string;
  homepage?: string;
  /** Minimum supported CLI version; older installs are reported as error with a diagnostic. */
  minVersion?: string;
  /** "builtin" = shipped spec; "config" = user-defined in config.json agents. */
  source?: "builtin" | "config";
  capabilities: {
    steer: boolean;
    resume: boolean;
    reasoning: boolean;
    mcp: boolean;
    /**
     * Accepts images in a prompt, placed inline with the text (Claude, Codex, Pi with an image
     * model, ACP agents advertising promptCapabilities.image). When false, attached images reach the
     * agent as a text note with the image's local file path.
     */
    images?: boolean;
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

export type RunStatus = "active" | "idle" | "paused" | "completed" | "failed" | "canceled";

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
  /**
   * What to do when a PR of the run gets failing checks or "changes requested":
   * "notify" (default) = desktop notification + console badge; "auto" = also send the details to the
   * node that created it (as a queued follow-up message); "off".
   */
  prFeedback?: "off" | "notify" | "auto";
  /** Max active members on a team (form_team / additions beyond it are rejected). Default 5. */
  maxTeamSize?: number;
  /** A node with an active turn and no events for this long raises a "stall" escalation. Default 10. */
  stallMinutes?: number;
  /** A parent's `send` beyond this many rounds of one delegation is escalated to the human. Absent (or 0) = no limit (the default). */
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

// ───────────────────────────── project ─────────────────────────────

/** A registered working directory. Every run belongs to exactly one project (DESIGN §3). */
export interface ProjectRecord {
  id: string;
  /** Display name; defaults to the directory basename. */
  name: string;
  /** Absolute, symlink-resolved directory path; unique among projects. */
  path: string;
  /** Repository root when the path is inside a git work tree. */
  gitRoot?: string;
  /** Hidden from the sidebar (its runs stay available under 已归档项目). */
  archived?: boolean;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

/** Project plus live counters for the sidebar. */
export interface ProjectSummary extends ProjectRecord {
  runCount: number;
  activeRunCount: number;
  pendingTotal: number;
  backgroundCount: number;
  /** Open/draft pull requests across the project's runs. */
  openPrCount?: number;
  lastRunAt?: IsoTime;
  /** Current git branch (cheap `git branch --show-current`), if a git work tree. */
  gitBranch?: string;
  /** False when the directory no longer exists. */
  exists: boolean;
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

/**
 * A candidate in a team preset: an agent configuration the lead may hire, without a role yet. The
 * lead matches tasks to candidates by model and description and hires them on its own (the human
 * approved them by putting them in the preset, so hiring needs no roster approval).
 */
export interface TeamCandidateSpec {
  agentId: string;
  model?: string;
  modeId?: string;
  thinking?: string;
  /** What this candidate is good at, e.g. "前端、CSS 动画" or "便宜快速，适合跑测试". */
  description?: string;
}
/** A preset candidate inside a run's team (ids are stable within the run, e.g. "c1"). */
export interface TeamCandidate extends TeamCandidateSpec {
  id: string;
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
  /** Set when the lead hired this member from a preset candidate. */
  candidateId?: string;
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
  /** Preset candidates the lead may hire (preset runs). A candidate can be hired into several roles. */
  candidates?: TeamCandidate[];
  updatedAt: IsoTime;
}

export interface TeamPreset {
  id: string;
  name: string;
  description?: string;
  /** Agent that runs the root node when a run uses this preset. */
  lead: { agentId: string; model?: string; modeId?: string; thinking?: string };
  /** Fixed roles. May be empty when the preset only offers candidates. */
  members: TeamMemberSpec[];
  /** Agents the lead may hire and assign roles to itself. */
  candidates?: TeamCandidateSpec[];
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface RunRecord {
  id: string;
  /** Owning project. Always set for new runs; legacy runs are migrated on startup (DESIGN §3). */
  projectId?: string;
  title: string;
  /**
   * Where the title came from: "prompt" = provisional (start of the first prompt), "generated" =
   * named by the configured title model, "human" = renamed by the human (never overwritten).
   * Absent on runs created before titles were generated (treat as "prompt").
   */
  titleSource?: "prompt" | "generated" | "human";
  cwd: string;
  status: RunStatus;
  rootNodeId: string;
  policy: RunPolicy;
  /** Present in dynamic runs once a team is formed, and in preset runs from the start. */
  team?: TeamRecord;
  /** Pause history (DESIGN §4.10); the last entry without resumedAt means the run is paused now. */
  /**
   * by "restart": the daemon stopped (crash, quit or update) while agents were working; on restart
   * the run is paused instead of being left half-interrupted, so 继续 resumes every interrupted agent.
   */
  pauses?: Array<{ at: IsoTime; resumedAt?: IsoTime; by: "human" | "restart" }>;
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

/** `message`: a <baton-message> from another agent session (send_message). */
export type TurnTrigger = "user" | "delegation" | "result" | "followup" | "correction" | "resume" | "message";
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
  /** Hidden by a conversation rollback (POST /api/nodes/:nodeId/rollback). Kept for history. */
  rolledBack?: boolean;
}

/**
 * A restore point taken just before a human message started a turn on a node (DESIGN §4.13).
 * Files are a snapshot of the node's cwd in baton's own shadow git repository (BATON_HOME, never the
 * project's .git), respecting .gitignore, so it covers changes by every agent and every shell command.
 */
export interface CheckpointRecord {
  id: string;
  runId: string;
  nodeId: string;
  /** The human user_message item this checkpoint precedes. */
  itemSeq: number;
  createdAt: IsoTime;
  /** Absent when the cwd could not be snapshotted (e.g. too large or unreadable). */
  files?: { cwd: string; ref: string };
  /**
   * How the conversation can be rewound to this point: "native" = the provider's own rewind/fork,
   * "replay" = a fresh provider session seeded with the earlier transcript, "unsupported" = neither.
   */
  conversation: "native" | "replay" | "unsupported";
}
export type RollbackMode = "conversation" | "files" | "both";

// ───────────────────────────── human-in-the-loop (inbox) ─────────────────────────────

/** A question an agent asked the human with ask_human. */
/** One question of a question card (native multi-question tools have up to 4). */
export interface QuestionPrompt {
  /** Stable key used in answers (provider question id, header, or "q1"). */
  id: string;
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  /** A free-text answer is allowed (always for ask_human; the "Other" choice for native tools). */
  allowFreeText: boolean;
}

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
  /**
   * "ask_human" = baton's MCP tool; "native" = the agent's own question tool (Claude
   * AskUserQuestion, Codex request_user_input, pi ask) surfaced through its permission flow.
   */
  source?: "ask_human" | "native";
  /** Structured questions (native tools; ask_human produces one prompt). */
  prompts?: QuestionPrompt[];
  /** Structured answers: prompt id → chosen option labels and/or free text. */
  answers?: Record<string, string[]>;
  /**
   * "inline": the agent's tool call is waiting — the answer returns as the tool result and the agent
   * continues in the same turn, below the card. "async": delivered later as a <baton-answer> message.
   */
  delivery?: "inline" | "async";
  /** Where the card belongs in the transcript: the tool call that asked. */
  anchor?: { itemSeq?: number; callId?: string; turnId?: string };
  /** Why it was canceled (turn interrupted, run paused, node ended…). */
  cancelReason?: string;
  /** Set when the human closed the card without answering (status "canceled"). */
  declinedAt?: IsoTime;
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

// ───────────────────────────── pull requests ─────────────────────────────

/** A pull/merge request an agent of the run created or the human linked (DESIGN §4.11). */
export interface PullRequestRecord {
  /** `${runId}:${forge}:${repo}#${number}` — globally unique (the same PR tracked by two runs has two records). */
  id: string;
  runId: string;
  projectId?: string;
  /** Node that created it (gh pr create / report_result artifact), when known. */
  nodeId?: string;
  /** Tool span (ToolSpanRecord.id) whose output contained the URL; the console anchors a card there. */
  toolSpanId?: string;
  source: "created" | "artifact" | "mentioned" | "manual";
  url: string;
  forge: "github" | "gitlab" | "other";
  /** "owner/name". */
  repo: string;
  number: number;
  title?: string;
  state: "open" | "draft" | "merged" | "closed" | "unknown";
  headRef?: string;
  baseRef?: string;
  author?: string;
  checks: {
    state: "pending" | "success" | "failure" | "neutral" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
    /** Names (and links) of failed checks, at most 10. */
    failedChecks: Array<{ name: string; url?: string }>;
  };
  reviewDecision?: "approved" | "changes_requested" | "review_required" | null;
  mergeable?: "mergeable" | "conflicting" | "unknown";
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commentCount?: number;
  /** Remote timestamps. */
  remoteUpdatedAt?: IsoTime;
  mergedAt?: IsoTime;
  closedAt?: IsoTime;
  /** Last successful or failed status fetch. */
  lastCheckedAt?: IsoTime;
  /** Last fetch error (gh missing, auth, network…); status fields keep their last known values. */
  error?: string;
  createdAt: IsoTime;
  /** Feedback (CI failures / review comments) last sent to an agent, if any. */
  lastFeedbackAt?: IsoTime;
  /** Set when the human unlinked it (tombstone; polling stops, counts and lists exclude it). */
  unlinkedAt?: IsoTime;
}

// ───────────────────────────── background processes ─────────────────────────────

/** A long-running process an agent of the run started (dev server, watcher, daemon…). DESIGN §4.8. */
export interface BackgroundProcess {
  /** `${pid}:${startEpochSeconds}` — stable across scans and daemon restarts. */
  id: string;
  runId: string;
  /** Node that started it, when attributable. */
  nodeId?: string;
  pid: number;
  ppid: number;
  pgid: number;
  /** Full command line (truncated to 2000 chars). */
  command: string;
  cwd?: string;
  /** TCP ports it or its folded children listen on. */
  ports: number[];
  /** Descendant processes folded into this entry (e.g. `node vite` under `npm run dev`). */
  children: Array<{ pid: number; command: string; ports: number[] }>;
  startedAt: IsoTime;
  status: "running" | "stopping" | "exited";
  exitedAt?: IsoTime;
  /**
   * How it was attributed: "tree" = descendant of the agent process at scan time, "group" = same
   * process group as a tool shell seen in the agent's tree, "inferred" = orphan that started during
   * one of the node's shell tool calls in the node's working directory.
   */
  attribution: "tree" | "group" | "inferred";
  /** Shell tool span (ToolSpanRecord.id) that started it, if known. */
  toolSpanId?: string;
  stoppedBy?: "human";
  /** The human said it does not belong to this run / should not be listed. */
  dismissed?: boolean;
  lastSeenAt: IsoTime;
}

export interface RunSnapshot {
  run: RunRecord;
  nodes: NodeRecord[];
  delegations: DelegationRecord[];
  turns: TurnRecord[];
  toolSpans: ToolSpanRecord[];
  permissions: PermissionRecord[];
  questions: QuestionRecord[];
  escalations: EscalationRecord[];
  /** Pull requests created by the run's agents or linked by the human. */
  pullRequests?: PullRequestRecord[];
  /**
   * Background processes started by the run's agents. Snapshots omit entries that exited more than
   * 24 h ago (there is no deletion event — consumers replaying events should apply the same filter).
   */
  backgroundProcesses?: BackgroundProcess[];
  /** Last event seq included in this snapshot; subscribe with after=lastSeq. */
  lastSeq: number;
  /** Timestamp of the event at lastSeq (the run's latest activity; absent for an empty log). */
  lastEventAt?: IsoTime;
}

export interface RunSummary {
  id: string;
  projectId?: string;
  title: string;
  titleSource?: RunRecord["titleSource"];
  /** Timestamp of the run's latest event. */
  lastEventAt?: IsoTime;
  status: RunStatus;
  cwd: string;
  rootAgentId: string;
  agents: string[];
  nodeCount: number;
  activeNodeCount: number;
  pendingPermissions: number;
  /** Pending permissions + proposals + questions + escalations. */
  pendingTotal: number;
  /** Background processes that are not exited (running or stopping) and not dismissed. */
  backgroundCount?: number;
  /** Pull requests of the run that are open or draft. */
  openPrCount?: number;
  usage: UsageTotals;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  endedAt?: IsoTime;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
}
