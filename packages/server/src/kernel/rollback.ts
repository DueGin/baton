/**
 * Message rollback (DESIGN §4.13): POST /api/nodes/:nodeId/rollback.
 *
 * Order: interrupt every running turn in the run (the run is not paused), cancel delegations the node
 * started after the checkpoint (conversation), restore the cwd (files), then hide the rolled-back rows
 * and rewind the provider conversation — natively when the driver can, else by replaying the earlier
 * transcript into a fresh session. Interrupted turns of other nodes are restarted with a notice.
 */
import type { CheckpointChangesResponse, DelegationRecord, ItemRecord, JsonValue, ListCheckpointsResponse, NodeRecord, RollbackRequest, RollbackResponse } from "@baton/protocol";
import type { DriverSession } from "../driver/types.js";
import type { Store } from "../store/index.js";
import { CheckpointError, replayPrompt, type Checkpoints, type CheckpointEntry } from "../checkpoints/index.js";
import { noticePrompt } from "./prompts.js";

export interface RollbackHooks {
  /** Interrupt every running turn in the run; resolves with the nodes whose turn was interrupted. */
  interruptRun(runId: string): Promise<string[]>;
  /** Refuses (throws) while another interruption or a pause is replacing a turn in the run. */
  assertQuiet(runId: string): void;
  cancelNode(id: string, reason: string): Promise<void>;
  patchDelegation(id: string, patch: Partial<DelegationRecord>): void;
  patchNode(id: string, patch: Partial<NodeRecord>): void;
  flush(id: string): void;
  /** Drop the node's queued human messages from its delivery queue (they go back with the conversation). */
  takeQueuedMessages(id: string): void;
  endQuestions(id: string, reason: string, turnId: string): void;
  session(id: string): Promise<DriverSession>;
  closeSession(id: string): Promise<void>;
  resetConversation(id: string): void;
  /** Resume a node after the rollback: an optional notice prompt plus whatever it had queued. */
  restart(id: string, notice?: string): Promise<void>;
  log(runId: string, error: unknown, nodeId?: string): void;
  closed(id: string): boolean;
}
const CANCEL_REASON = "Rolled back by human";
const now = (): string => new Date().toISOString();
const terminal = (d: DelegationRecord): boolean => ["completed", "failed", "canceled", "replaced"].includes(d.status);

export class Rollbacks {
  private running = new Set<string>();
  constructor(private store: Store, private checkpoints: Checkpoints | undefined, private hooks: RollbackHooks) {}
  /** True while a rollback is changing this run: new turns and result deliveries wait. */
  active(runId: string): boolean { return this.running.has(runId); }
  list(nodeId: string): ListCheckpointsResponse { this.store.node(nodeId); return { checkpoints: this.checkpoints?.list(nodeId) ?? [] }; }
  changes(id: string): Promise<CheckpointChangesResponse> {
    if (!this.checkpoints) throw new CheckpointError("Rollback checkpoints are disabled");
    return this.checkpoints.changes(id);
  }
  async rollback(nodeId: string, input: RollbackRequest): Promise<RollbackResponse> {
    const checkpoints = this.checkpoints;
    if (!checkpoints) throw new CheckpointError("Rollback checkpoints are disabled");
    if (!input || typeof input !== "object" || typeof input.checkpointId !== "string") throw new Error("checkpointId is required");
    if (!["conversation", "files", "both"].includes(input.mode)) throw new Error("mode must be conversation, files or both");
    const node = this.store.node(nodeId), entry = checkpoints.get(input.checkpointId), record = entry.record;
    if (record.nodeId !== nodeId) throw new CheckpointError("Checkpoint belongs to another node");
    const conversation = input.mode !== "files", files = input.mode !== "conversation";
    if (files && !record.files) throw new CheckpointError("这个检查点没有文件快照（目录过大、不可读或没有 git），只能回退会话");
    if (conversation && record.conversation === "unsupported") throw new CheckpointError("这个 agent 不支持回退会话");
    if (this.hooks.closed(nodeId)) throw new CheckpointError("Node is canceled or closed");
    if (conversation && this.store.items(nodeId).find((row) => row.seq === record.itemSeq)?.rolledBack) throw new CheckpointError("这条消息已经回退过了");
    if (this.running.has(node.runId)) throw new CheckpointError("A rollback is already in progress in this run");
    this.hooks.assertQuiet(node.runId);
    this.running.add(node.runId);
    let interrupted: string[] = [], response: RollbackResponse;
    try {
      interrupted = await this.hooks.interruptRun(node.runId);
      const canceledDelegations = conversation ? await this.cancelLaterDelegations(nodeId, record.createdAt) : undefined;
      const restored = files ? (await checkpoints.restore(record)).map((change) => change.path) : undefined;
      let rewound: { draft: string; conversation: "native" | "replay" } | undefined;
      if (conversation) rewound = await this.rewind(nodeId, entry, checkpoints);
      // Files only, node idle: it hears about the restore with its next prompt (an interrupted one is resumed below).
      else if (!interrupted.includes(nodeId)) checkpoints.addPreamble(nodeId, noticePrompt("system", `The human restored the files in ${record.files!.cwd} to the checkpoint taken before one of their earlier messages (${record.createdAt}). Every change made after it, by you or anyone else, was undone${restored!.length ? `; changed paths: ${restored!.slice(0, 50).join(", ")}${restored!.length > 50 ? ", …" : ""}` : ""}. Re-read files before relying on what you saw earlier.`));
      response = { mode: input.mode, ...(rewound ? { draft: rewound.draft, conversation: rewound.conversation, canceledDelegations } : {}), ...(restored ? { files: restored } : {}) };
    } finally { this.running.delete(node.runId); }
    // Interrupted nodes resume with a notice, except the node whose conversation was rolled back: it
    // waits for the human's edited message.
    const notice = noticePrompt("system", files ? `The human restored the files in ${record.files!.cwd} to an earlier checkpoint while you were working, which interrupted your turn. Files may have changed: re-read before editing. Continue where you left off.` : "The human rolled back part of this run's conversation, which interrupted your turn. Continue where you left off.");
    for (const id of this.store.snapshot(node.runId).nodes.map((entry) => entry.id)) {
      try { await this.hooks.restart(id, interrupted.includes(id) && !(id === nodeId && conversation) ? notice : undefined); }
      catch (error) { this.hooks.log(node.runId, error, id); }
    }
    return response;
  }
  /** Delegations the node started at or after the checkpoint: cancel live ones (with subtrees); none report back. */
  private async cancelLaterDelegations(nodeId: string, since: string): Promise<string[]> {
    const canceled: string[] = [];
    for (const d of this.store.snapshot(this.store.node(nodeId).runId).delegations.filter((d) => d.fromNodeId === nodeId && d.createdAt >= since)) {
      const current = this.store.delegation(d.id);
      if (!terminal(current)) {
        if (current.blockedByProposal) this.hooks.patchDelegation(d.id, { status: "canceled", endedAt: now(), result: { status: "failed", summary: CANCEL_REASON, finalText: "", reported: false } });
        else await this.hooks.cancelNode(current.toNodeId, CANCEL_REASON);
        canceled.push(d.id);
      }
      if (!this.store.delegation(d.id).deliveredAt) this.hooks.patchDelegation(d.id, { deliveredAt: now() });
    }
    return canceled;
  }
  private async rewind(nodeId: string, entry: CheckpointEntry, checkpoints: Checkpoints): Promise<{ draft: string; conversation: "native" | "replay" }> {
    const record = entry.record, runId = record.runId;
    this.hooks.flush(nodeId);
    this.hooks.takeQueuedMessages(nodeId);
    const turns = new Set(this.store.snapshot(runId).turns.filter((turn) => turn.nodeId === nodeId && (turn.id === entry.turnId || turn.startedAt > record.createdAt)).map((turn) => turn.id));
    const rows = this.store.items(nodeId);
    const opened = rows.filter((row) => row.item.type === "user_message" && (entry.turnId ? row.turnId === entry.turnId && (row.item.delivery === "turn" || row.seq === record.itemSeq) : row.seq === record.itemSeq));
    const order = (row: ItemRecord): number => row.item.type === "user_message" ? row.item.deliveryOrder ?? 0 : 0;
    const draft = opened.sort((a, b) => order(a) - order(b) || a.seq - b.seq).map((row) => row.item.type === "user_message" ? row.item.text : "").join("\n\n");
    for (const row of rows) {
      if (row.rolledBack) continue;
      const queued = row.item.type === "user_message" && row.item.delivery === "queued";
      if (!(row.turnId ? turns.has(row.turnId) : queued || row.ts >= record.createdAt)) continue;
      let item = row.item;
      if (item.type === "user_message" && queued) { const { queuePosition: _position, ...rest } = item; item = { ...rest, delivery: "retracted" }; }
      this.store.appendItem(runId, { ...row, item, rolledBack: true });
    }
    for (const turnId of turns) this.hooks.endQuestions(nodeId, CANCEL_REASON, turnId);
    this.hooks.resetConversation(nodeId);
    let conversation: "native" | "replay" = record.conversation === "native" && entry.point !== null && entry.point !== undefined ? "native" : "replay";
    if (conversation === "native") {
      try {
        const session = await this.hooks.session(nodeId);
        if (!session.rewindConversation) throw new Error("this session cannot rewind natively");
        await session.rewindConversation(entry.point as JsonValue);
        const persistence = session.persistence();
        await this.hooks.closeSession(nodeId);
        this.hooks.patchNode(nodeId, { persistence: persistence ?? undefined });
        checkpoints.clearPreamble(nodeId);
      } catch (error) {
        this.hooks.log(runId, `Native conversation rewind failed; replaying the transcript into a new session instead: ${error instanceof Error ? error.message : String(error)}`, nodeId);
        conversation = "replay";
      }
    }
    if (conversation === "replay") {
      await this.hooks.closeSession(nodeId);
      this.hooks.patchNode(nodeId, { persistence: undefined });
      const replay = replayPrompt(this.store.items(nodeId));
      if (replay) checkpoints.setPreamble(nodeId, replay); else checkpoints.clearPreamble(nodeId);
    }
    return { draft, conversation };
  }
}
