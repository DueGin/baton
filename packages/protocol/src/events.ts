/**
 * Run event log. Every projection in records.ts is derived from these events; the web store
 * applies them to a RunSnapshot with the same reducer semantics (see `applyEvent` in reduce.ts).
 * Consumers must ignore unknown event types.
 */
import type {
  DelegationRecord,
  IsoTime,
  NodeRecord,
  PermissionRecord,
  RunRecord,
  ToolSpanRecord,
  TurnRecord,
} from "./records.js";
import type { TimelineItem } from "./timeline.js";

export type RunEvent =
  | { type: "run.created"; run: RunRecord }
  /** Shallow patch (status, title, policy, usage, updatedAt, endedAt). */
  | { type: "run.updated"; patch: Partial<RunRecord> }
  | { type: "node.created"; node: NodeRecord }
  /** Shallow patch (status, activity, error, model, modeId, usage, turns, persistence, endedAt…). */
  | { type: "node.updated"; nodeId: string; patch: Partial<NodeRecord> }
  | { type: "delegation.created"; delegation: DelegationRecord }
  /** Shallow patch (status, round, result, startedAt, endedAt, deliveredAt, deliveredVia, subtreeUsage). */
  | { type: "delegation.updated"; delegationId: string; patch: Partial<DelegationRecord> }
  | { type: "turn.started"; turn: TurnRecord }
  | { type: "turn.updated"; turnId: string; patch: Partial<TurnRecord> }
  /** Upsert by span id. */
  | { type: "tool.span"; span: ToolSpanRecord }
  /** Upsert by permission id. */
  | { type: "permission"; permission: PermissionRecord }
  /**
   * A transcript row was appended (or, for merged assistant/reasoning text, replaced) on a node.
   * `itemSeq` is the node-local item seq (ItemRecord.seq); the same itemSeq arriving again means
   * "replace that row". The envelope's `seq` stays the run-level event seq.
   * Text rows are coalesced to ≈1 event per 100 ms per node.
   */
  | { type: "item"; nodeId: string; itemSeq: number; turnId?: string; ts: IsoTime; item: TimelineItem }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; nodeId?: string };

export type RunEventEnvelope = RunEvent & {
  runId: string;
  /** Monotonic per run, starting at 1. */
  seq: number;
  ts: IsoTime;
};

export type RunEventType = RunEvent["type"];
