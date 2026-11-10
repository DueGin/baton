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

export type DelegationMode = "lead" | "auto";

export type RunStatus = "active" | "idle" | "completed" | "failed" | "canceled";

export interface RunPolicy {
  /** Max delegation depth below the root (root depth = 0). */
  maxDepth: number;
  /** Max simultaneously active child delegations per parent node. */
  maxActiveChildren: number;
  /** Auto-approve permission requests of every node in the run (recorded as by: "policy"). */
  autoApprove: boolean;
  /**
   * How strongly agents are steered toward delegating (default "lead").
   * - "lead": the root acts as the lead of the run — it splits separable work and delegates it in
   *   parallel to the best-suited agents, keeping planning, integration and verification for itself.
   * - "auto": every agent decides on its own whether delegating is worth it.
   */
  delegation?: DelegationMode;
  /** Optional run budget; exceeding it rejects new delegations and cancels nothing by itself. */
  budget?: { maxCostUsd?: number; maxTokens?: number; maxWallMinutes?: number };
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunRecord {
  id: string;
  title: string;
  cwd: string;
  status: RunStatus;
  rootNodeId: string;
  policy: RunPolicy;
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
  | "interrupted";

export const TERMINAL_NODE_STATUSES: readonly NodeStatus[] = ["completed", "failed", "canceled"];

export interface NodeRecord {
  id: string;
  runId: string;
  /** null for the root node. */
  parentNodeId: string | null;
  /** The delegation that created this node; null for the root. */
  delegationId: string | null;
  depth: number;
  agentId: string;
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
  resolvedBy?: "human" | "policy" | "parent";
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

export interface RunSnapshot {
  run: RunRecord;
  nodes: NodeRecord[];
  delegations: DelegationRecord[];
  turns: TurnRecord[];
  toolSpans: ToolSpanRecord[];
  permissions: PermissionRecord[];
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
  usage: UsageTotals;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  endedAt?: IsoTime;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
}
