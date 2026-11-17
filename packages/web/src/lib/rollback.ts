/** Message rollback in the console (DESIGN §4.13): which checkpoint a message maps to and which choices are open. */
import type { CheckpointChangesResponse, CheckpointRecord, ItemRecord, RollbackMode } from "@baton/protocol";
import type { QuestionTranscriptEntry } from "./questions.js";

export type ChangesState = { status: "loading" } | { status: "ready"; files: CheckpointChangesResponse["files"] } | { status: "error"; message: string };
export interface RollbackChoice { mode: RollbackMode; label: string; disabled?: string; detail?: string }
export const rollbackLabels: Record<RollbackMode, string> = { conversation: "回退会话", files: "回退文件", both: "回退会话和文件" };

/**
 * The checkpoint a human message rolls back to: its own, or — when several queued messages were
 * delivered together — the checkpoint of the turn they opened. Steered messages have none.
 */
export function checkpointFor(row: ItemRecord, rows: ItemRecord[], checkpoints: CheckpointRecord[]): CheckpointRecord | undefined {
  const own = checkpoints.find(checkpoint => checkpoint.itemSeq === row.seq);
  if (own || row.item.type !== "user_message" || row.item.delivery !== "turn" || !row.turnId) return own;
  return checkpoints.find(checkpoint => rows.find(entry => entry.seq === checkpoint.itemSeq)?.turnId === row.turnId);
}
/** Human messages that get the 回退 action: delivered ones, and the run's first prompt. */
export function rollbackTarget(row: ItemRecord, first: boolean): boolean {
  if (row.item.type !== "user_message" || row.seq <= 0) return false;
  if (row.item.delivery === "turn" || row.item.delivery === "steered") return true;
  return first && row.item.delivery === undefined && !row.item.text.trimStart().startsWith("<baton-");
}
const changesDetail = (changes: ChangesState | undefined): string | undefined => !changes || changes.status === "loading" ? "正在计算改动…" : changes.status === "error" ? "无法预览改动" : changes.files.length ? `${changes.files.length} 个文件会改变` : "文件与快照一致，不会改变";
/** The three choices with the reason each is unavailable (shown as a tooltip). */
export function rollbackChoices(row: ItemRecord, checkpoint: CheckpointRecord | undefined, changes?: ChangesState): RollbackChoice[] {
  const steered = row.item.type === "user_message" && row.item.delivery === "steered";
  const missing = !checkpoint ? steered ? "这条消息是在运行中插入当前回合的，没有自己的检查点" : "这条消息没有检查点（可能发送于启用回退之前）" : undefined;
  const done = row.rolledBack ? "这条消息已经回退" : undefined;
  const conversation = missing ?? done ?? (checkpoint!.conversation === "unsupported" ? "这个 agent 不支持回退会话" : undefined);
  const files = missing ?? (checkpoint!.files ? undefined : "这个检查点没有文件快照（目录过大、不可读或没有 git），只能回退会话");
  const replay = checkpoint?.conversation === "replay" ? "这个 agent 不能原生回退：会新开会话并重放之前的对话" : undefined;
  return [
    { mode: "conversation", label: rollbackLabels.conversation, ...(conversation ? { disabled: conversation } : replay ? { detail: replay } : {}) },
    { mode: "files", label: rollbackLabels.files, ...(files ? { disabled: files } : { detail: changesDetail(changes) }) },
    { mode: "both", label: rollbackLabels.both, ...(conversation ?? files ? { disabled: conversation ?? files } : { detail: changesDetail(changes) }) },
  ];
}
export function confirmText(mode: RollbackMode, changes?: ChangesState): string {
  const files = changes?.status === "ready" ? changes.files.length : undefined;
  const fileText = files === undefined ? "把工作目录还原到这条消息发送前的状态（之后新建的文件会被删除）" : files ? `还原 ${files} 个文件到这条消息发送前的状态（之后新建的文件会被删除）` : "工作目录与快照一致，不会改动文件";
  const conversationText = "这条消息和之后的对话会被隐藏，这个节点在它之后发起的委派会被取消，消息内容会放回输入框";
  return mode === "conversation" ? `${conversationText}。` : mode === "files" ? `${fileText}；对话保持不变。` : `${conversationText}；同时${fileText}。`;
}
export const fileStatusLabels: Record<CheckpointChangesResponse["files"][number]["status"], string> = { added: "删除", modified: "还原", deleted: "恢复" };

/**
 * Runs of consecutive rolled-back rows: `start[i]` is the index of the run entry i belongs to (-1 when
 * it is not rolled back), `size` the number of rows per run start.
 */
export function rolledBackGroups(entries: QuestionTranscriptEntry[]): { start: number[]; size: Map<number, number> } {
  const start: number[] = [], size = new Map<number, number>();
  let current = -1;
  entries.forEach((entry, index) => {
    if (!(entry.type === "row" && entry.entry.row.rolledBack === true)) { current = -1; start.push(-1); return; }
    if (current < 0) current = index;
    start.push(current); size.set(current, (size.get(current) ?? 0) + 1);
  });
  return { start, size };
}
