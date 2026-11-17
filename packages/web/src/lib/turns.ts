import type { ItemRecord, RunSnapshot, TurnRecord } from "@baton/protocol";
import type { QuestionTranscriptEntry } from "./questions.js";
import { duration } from "./derive.js";
import { usageTokens } from "./conversation.js";

export const turnTriggerLabels: Record<TurnRecord["trigger"], string> = { user: "", delegation: "委派任务", result: "子任务结果", followup: "后续消息", correction: "结果修正", resume: "继续会话" };
export function turnTokens(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : value >= 1000 ? `${(value / 1000).toFixed(2).replace(/\.?0+$/, "")}k` : String(Math.round(value));
}
export function turnElapsed(since: string, now: number): string { return duration(since, now); }
export function startTurnTicker(tick: (now: number) => void, clock = Date.now): () => void {
  const timer = setInterval(() => tick(clock()), 1000); return () => clearInterval(timer);
}
export function rowTurn(row: ItemRecord, turns: TurnRecord[]): TurnRecord | undefined {
  if (row.turnId) return turns.find(turn => turn.id === row.turnId && turn.nodeId === row.nodeId);
  if (row.item.type === "user_message" && ["queued", "retracted"].includes(row.item.delivery ?? "")) return undefined;
  const time = Date.parse(row.ts);
  return turns.findLast(turn => turn.nodeId === row.nodeId && time >= Date.parse(turn.startedAt) && (!turn.endedAt || time <= Date.parse(turn.endedAt)));
}
/** Insert a footer after the last visible artifact of each ended turn, including inline questions. */
export function turnFooters(entries: QuestionTranscriptEntry[], snapshot: RunSnapshot, nodeId: string): Map<number, TurnRecord[]> {
  const turns = snapshot.turns.filter(turn => turn.nodeId === nodeId);
  const last = new Map<string, number>();
  entries.forEach((entry, index) => {
    const turn = entry.type === "row" ? rowTurn(entry.entry.row, turns) : entry.question.anchor?.turnId ? turns.find(turn => turn.id === entry.question.anchor?.turnId) : rowTurn({ nodeId, seq: 0, ts: entry.question.askedAt, item: { type: "notice", message: "", level: "info" } }, turns);
    if (turn) last.set(turn.id, index);
  });
  const result = new Map<number, TurnRecord[]>();
  for (const turn of turns) {
    const index = last.get(turn.id);
    if (turn.status !== "running" && index !== undefined) result.set(index, [...result.get(index) ?? [], turn]);
  }
  return result;
}
export function turnFooter(turn: TurnRecord) {
  const label = turn.status === "completed" ? "✓" : /paused|暂停/i.test(turn.error ?? "") ? "已暂停" : turn.status === "interrupted" || turn.error === "interrupted by human message" || turn.error === "interrupted by rollback" ? "已中断" : turn.status === "failed" ? "失败" : "已取消";
  const error = turn.error === "interrupted by rollback" ? "因回退中断" : turn.error && !["paused by human", "interrupted by human message"].includes(turn.error) ? turn.error : undefined;
  return { label, elapsed: turn.endedAt ? duration(turn.startedAt, turn.endedAt) : undefined, tokens: usageTokens(turn.usage), trigger: turnTriggerLabels[turn.trigger], error };
}
