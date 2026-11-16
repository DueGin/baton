import { describe, expect, it } from "vitest";
import { applyEvent, type RunEventEnvelope } from "@baton/protocol";
import { DemoClient } from "./client.js";
import { inlineQuestionEntries } from "../lib/questions.js";
import { conversationRows } from "../lib/conversation.js";
import { snapshotInbox } from "../lib/inbox.js";

const base = Date.parse("2026-11-10T07:00:00Z");
describe("inline questions and pause browser demo", () => {
  it("shows native multi-prompt and ask_human cards at tools, then continues the same turn below", async () => {
    let now = base; const client = new DemoClient(() => now); const initial = await client.run("run-questions");
    expect(initial.questions.map(question => [question.source, question.delivery])).toEqual([["native", "inline"], ["ask_human", "inline"]]);
    const native = initial.questions[0]!; expect(native.prompts).toHaveLength(2); expect(native.prompts![1]!.multiSelect).toBe(true);
    await expect(client.answer(native.id, { answers: { scope: ["当前项目"] } })).rejects.toThrow("全部问题");
    await expect(client.answer(native.id, { answers: { scope: ["当前项目", "所有项目"], checks: ["中文"] } })).rejects.toThrow("全部问题");
    await client.answer(native.id, { answers: { scope: ["当前项目"], checks: ["中文", "权限"] }, answer: "范围：当前项目\n验证：中文、权限" });
    const ask = initial.questions[1]!; await client.answer(ask.id, { answers: { q1: ["优先检查跨项目数据"] }, answer: "优先检查跨项目数据" });
    const immediately = await client.run(initial.run.id);
    for (const question of immediately.questions) {
      const rows = (await client.items(question.nodeId)).items;
      expect(rows.at(-1)).toMatchObject({ turnId: question.anchor!.turnId, item: { type: "assistant_message", text: "已收到回答，继续执行…" } });
      const entries = inlineQuestionEntries(conversationRows(rows, [], question.nodeId), immediately.questions, question.nodeId);
      expect(entries.map(entry => entry.type)).toEqual(["row", "question", "row"]);
      expect(rows.some(row => row.item.type === "user_message" && row.item.text.includes("baton-answer"))).toBe(false);
    }
    now += 4000; const completed = await client.run(initial.run.id);
    expect(completed.turns).toHaveLength(initial.turns.length); expect(completed.turns.every(turn => turn.status === "completed")).toBe(true);
    expect(snapshotInbox(completed)).toHaveLength(0);
    const output = (await client.items(native.nodeId)).items.at(-1)!;
    expect(output.item).toMatchObject({ type: "assistant_message", text: expect.stringContaining("完成验证") });
  });
  it("interrupts all turns on pause, cancels native questions and holds ask_human answers/messages until resume", async () => {
    let now = base; const client = new DemoClient(() => now); const initial = await client.run("run-questions");
    const paused = await client.pauseRun(initial.run.id); expect(paused.status).toBe("paused"); expect(paused.pauses).toEqual([{ at: new Date(base).toISOString(), by: "human" }]);
    const stopped = await client.run(initial.run.id);
    expect(stopped.turns.every(turn => turn.status === "canceled" && turn.error === "paused by human")).toBe(true);
    expect(stopped.questions[0]).toMatchObject({ status: "canceled", cancelReason: "会话已暂停" });
    expect(stopped.questions[1]).toMatchObject({ status: "pending", delivery: "async" });
    const queued = await client.send(initial.run.rootNodeId, "继续时补充权限校验", "pause-queue", "interrupt"); expect(queued.delivery).toBe("queued");
    const ask = stopped.questions[1]!; await client.answer(ask.id, { answers: { q1: ["重点检查权限"] } });
    now += 120_000; const stillPaused = await client.run(initial.run.id);
    expect(stillPaused.run.status).toBe("paused"); expect(stillPaused.turns).toHaveLength(initial.turns.length);
    const resumed = await client.resumeRun(initial.run.id);
    expect(resumed.pauses![0]!.resumedAt).toBe(new Date(now).toISOString());
    const live = await client.run(initial.run.id);
    expect(live.turns.filter(turn => turn.status === "running").map(turn => turn.trigger)).toEqual(["resume", "resume"]);
    const rootRows = (await client.items(initial.run.rootNodeId)).items;
    expect(rootRows.find(row => row.seq === queued.itemSeq)!.item).toMatchObject({ delivery: "turn" });
    expect(rootRows.some(row => row.item.type === "user_message" && row.item.text.includes("Continue where you left off"))).toBe(true);
    const childRows = (await client.items(ask.nodeId)).items;
    expect(childRows.some(row => row.item.type === "user_message" && row.item.text.includes("baton-answer"))).toBe(true);
    now += 16_000; await client.run(initial.run.id);
    expect((await client.items(initial.run.rootNodeId)).items.at(-1)!.item).toMatchObject({ type: "assistant_message", text: expect.stringContaining("继续时补充权限校验") });
  });
  it("leaves background processes alive, expires permissions, and rejects terminal pause or nonpaused resume", async () => {
    const client = new DemoClient(() => base); const before = await client.run("run-background");
    await client.pauseRun(before.run.id); const paused = await client.run(before.run.id);
    expect(paused.backgroundProcesses).toEqual(before.backgroundProcesses);
    expect(paused.permissions.every(permission => permission.status !== "pending")).toBe(true);
    await expect(client.resumeRun("run-demo")).rejects.toThrow("未暂停");
    await expect(client.pauseRun("run-previous")).rejects.toThrow("已结束");
    const first = await client.pauseRun(before.run.id); expect(first.pauses).toHaveLength(1);
  });
  it("defers approved queued delegations until resume and preserves replayable event order", async () => {
    let now = base; const client = new DemoClient(() => now); const initial = await client.run("run-local-1"); const events: RunEventEnvelope[] = [];
    const controller = new AbortController(); const stream = client.events(initial.run.id, initial.lastSeq, event => events.push(event), controller.signal);
    await client.pauseRun(initial.run.id); await client.approveTeam(initial.run.id, initial.run.team!.proposals[0]!.id, {});
    const waiting = await client.run(initial.run.id); expect(waiting.delegations.every(edge => edge.status === "queued" && !edge.blockedByProposal)).toBe(true);
    expect(waiting.turns.every(turn => turn.status !== "running")).toBe(true);
    now += 10000; await client.resumeRun(initial.run.id);
    const resumed = await client.run(initial.run.id); expect(resumed.delegations.every(edge => edge.status === "running")).toBe(true);
    expect(resumed.turns.some(turn => turn.nodeId === initial.run.rootNodeId && turn.status === "running" && turn.trigger === "result")).toBe(true);
    controller.abort(); await stream;
    let replayed = initial;
    for (const event of events) { expect(event.seq).toBe(replayed.lastSeq + 1); replayed = applyEvent(replayed, JSON.parse(JSON.stringify(event)) as RunEventEnvelope); }
    expect(replayed).toEqual(resumed);
  });
});
