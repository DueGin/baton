import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemRecord, TurnRecord } from "@baton/protocol";
import { createScenario, replay } from "../demo/scenario.js";
import { conversationRows } from "./conversation.js";
import { inlineQuestionEntries } from "./questions.js";
import { startTurnTicker, turnElapsed, turnFooter, turnFooters, turnTokens } from "./turns.js";
const base = Date.parse("2026-11-16T08:14:38Z"); const snapshot = replay(createScenario(base), base + 152000); const nodeId = snapshot.run.rootNodeId;
const turn: TurnRecord = { id: "turn-1", nodeId, runId: snapshot.run.id, status: "completed", trigger: "user", startedAt: new Date(base).toISOString(), endedAt: new Date(base + 152000).toISOString(), usage: { inputTokens: 1_000_000, outputTokens: 160_000 } };
afterEach(() => vi.useRealTimers());
describe("turn annotations", () => {
  it("ticks each second from the turn start and cleans up; formats million tokens without inflated k values", () => {
    vi.useFakeTimers(); vi.setSystemTime(base); const values: string[] = [];
    const stop = startTurnTicker(now => values.push(turnElapsed(turn.startedAt, now)));
    vi.advanceTimersByTime(2000); expect(values).toEqual(["1s", "2s"]); stop(); vi.advanceTimersByTime(3000); expect(values).toHaveLength(2);
    expect(turnElapsed(turn.startedAt, base + 152000)).toBe("2m 32s"); expect(turnElapsed(turn.startedAt, base - 1000)).toBe("0s");
    expect(turnTokens(1_160_000)).toBe("1.16M"); expect(turnTokens(2_847_200)).toBe("2.85M"); expect(turnTokens(1160)).toBe("1.16k"); expect(turnTokens(1000)).toBe("1k"); expect(turnTokens(0)).toBe("0");
  });
  it("describes ended turns, errors, interruption, pause and automatic triggers", () => {
    expect(turnFooter(turn)).toMatchObject({ label: "✓", elapsed: "2m 32s", tokens: 1_160_000, trigger: "" });
    expect(turnFooter({ ...turn, status: "failed", error: "provider stopped" })).toMatchObject({ label: "失败", error: "provider stopped" });
    expect(turnFooter({ ...turn, status: "canceled", error: "interrupted by human message" })).toMatchObject({ label: "已中断", error: undefined });
    expect(turnFooter({ ...turn, status: "canceled", error: "paused by human" }).label).toBe("已暂停");
    expect(turnFooter({ ...turn, status: "interrupted" }).label).toBe("已中断"); expect(turnFooter({ ...turn, status: "canceled" }).label).toBe("已取消");
    for (const trigger of ["result", "resume", "followup", "delegation", "correction"] as const) expect(turnFooter({ ...turn, trigger }).trigger).not.toBe("");
    expect(turnFooter({ ...turn, usage: undefined }).tokens).toBeUndefined();
  });
  it("anchors each footer after its last visible row or question and keeps later turns below", () => {
    const next = { ...turn, id: "turn-2", status: "running" as const, startedAt: new Date(base + 200000).toISOString(), endedAt: undefined };
    const row = (seq: number, turnId: string, text: string): ItemRecord => ({ seq, nodeId, turnId, ts: turn.startedAt, item: { type: "assistant_message", text } });
    const rows = [row(1, turn.id, "first"), row(2, turn.id, "last"), row(3, next.id, "new")];
    const value = { ...snapshot, turns: [turn, next] }; const entries = inlineQuestionEntries(conversationRows(rows, [], nodeId), [], nodeId);
    expect([...turnFooters(entries, value, nodeId)]).toEqual([[1, [turn]]]);
    const question = { id: "q", nodeId, runId: snapshot.run.id, question: "确认？", status: "answered" as const, blocking: true, askedAt: turn.startedAt, anchor: { itemSeq: 2, turnId: turn.id } };
    const questions = inlineQuestionEntries(conversationRows(rows, [], nodeId), [question], nodeId);
    expect([...turnFooters(questions, value, nodeId)]).toEqual([[2, [turn]]]);
    expect(turnFooters(entries.slice(2), value, nodeId).size).toBe(0);
    expect(turnFooters(inlineQuestionEntries(conversationRows([{ ...rows[0]!, turnId: undefined }], [], nodeId), [], nodeId), value, nodeId).get(0)).toEqual([turn]);
  });
});
