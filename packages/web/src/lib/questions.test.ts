import { describe, expect, it } from "vitest";
import type { ItemRecord, QuestionRecord } from "@baton/protocol";
import { answerPayload, inlineQuestionEntries, pendingQuestion, questionPrompts, questionSummary, representedQuestion, selectAnswer } from "./questions.js";

const ts = "2026-11-10T07:00:00Z";
export const nativeQuestion: QuestionRecord = {
  id: "q/native", runId: "r", nodeId: "n", source: "native", delivery: "inline", question: "确认产品选择", blocking: true, status: "pending", askedAt: ts,
  anchor: { callId: "call", itemSeq: 2, turnId: "turn" },
  prompts: [
    { id: "scope", header: "范围", question: "搜索范围？", options: [{ label: "当前项目", description: "只搜索当前项目" }, { label: "全部项目" }], allowFreeText: true },
    { id: "checks", header: "验证", question: "检查哪些内容？", options: [{ label: "中文" }, { label: "权限" }], multiSelect: true, allowFreeText: true },
  ],
};
const row = (seq: number, item: ItemRecord["item"]): ItemRecord => ({ seq, item, ts, nodeId: "n", turnId: "turn" });
const before = row(1, { type: "assistant_message", text: "先确认选择" });
const tool = row(2, { type: "tool_call", callId: "call", name: "AskUserQuestion", status: "running", detail: { type: "unknown", input: {}, output: null } });
const later = row(3, { type: "assistant_message", text: "继续执行" });

describe("inline question anchors", () => {
  it("replaces the represented tool at its anchor and leaves later output underneath", () => {
    const entries = inlineQuestionEntries([before, tool, later].map(row => ({ row })), [nativeQuestion], "n");
    expect(entries.map(entry => entry.type === "question" ? entry.question.id : entry.entry.row.seq)).toEqual([1, nativeQuestion.id, 3]);
    expect(inlineQuestionEntries([before, tool, later].map(row => ({ row })), [{ ...nativeQuestion, nodeId: "other" }], "n")).toHaveLength(3);
  });
  it("prefers callId, supports itemSeq fallback and preserves unrelated tool rows", () => {
    const rows = [before, tool, later].map(row => ({ row }));
    const fallback = { ...nativeQuestion, anchor: { callId: "missing", itemSeq: 2 } };
    expect(inlineQuestionEntries(rows, [fallback], "n")[1]?.type).toBe("question");
    const different = { ...tool, item: { ...tool.item, name: "shell" } } as ItemRecord;
    expect(inlineQuestionEntries([before, different, later].map(row => ({ row })), [nativeQuestion], "n").map(entry => entry.type)).toEqual(["row", "row", "question", "row"]);
    expect(inlineQuestionEntries(rows, [{ ...nativeQuestion, anchor: { itemSeq: 1, callId: "call" } }], "n")[1]?.type).toBe("question");
  });
  it("places unanchored legacy cards by time, including before the first row", () => {
    const question = { ...nativeQuestion, anchor: undefined, askedAt: "2026-11-10T06:59:59Z" };
    expect(inlineQuestionEntries([{ row: later }], [question], "n").map(entry => entry.type)).toEqual(["question", "row"]);
    expect(inlineQuestionEntries([], [question], "n")).toEqual([{ type: "question", question }]);
  });
  it("hides represented native question permissions and retains the legacy fallback", () => {
    const permission = { nodeId: "n", requestId: "call", request: { kind: "question" } };
    expect(representedQuestion(permission, [nativeQuestion])).toBe(true);
    expect(representedQuestion(permission, [])).toBe(false);
    expect(representedQuestion({ ...permission, request: { kind: "tool" } }, [nativeQuestion])).toBe(false);
    expect(pendingQuestion({ ...nativeQuestion, blocking: false })).toBe(true);
    expect(pendingQuestion({ ...nativeQuestion, delivery: "async", blocking: false })).toBe(false);
  });
});

describe("structured question answers", () => {
  it("creates the exact multi-prompt single/multi answer payload and summary", () => {
    expect(answerPayload(nativeQuestion, { scope: { selected: ["当前项目"], text: "" }, checks: { selected: ["中文", "权限"], text: "" } })).toEqual({ answers: { scope: ["当前项目"], checks: ["中文", "权限"] }, answer: "范围：当前项目\n验证：中文、权限" });
    const [single, multi] = questionPrompts(nativeQuestion);
    expect(selectAnswer(single!, { selected: ["当前项目"], text: "另一个", other: true }, "全部项目")).toEqual({ selected: ["全部项目"], text: "", other: false });
    expect(selectAnswer(multi!, { selected: ["中文"], text: "" }, "权限").selected).toEqual(["中文", "权限"]);
    expect(selectAnswer(multi!, { selected: ["中文", "权限"], text: "" }, "中文").selected).toEqual(["权限"]);
  });
  it("validates all prompts, single-select cardinality and native Other text", () => {
    const checks = { selected: ["中文"], text: "" };
    expect(answerPayload(nativeQuestion, {})).toBeNull();
    expect(answerPayload(nativeQuestion, { scope: { selected: ["当前项目"], text: "" } })).toBeNull();
    expect(answerPayload(nativeQuestion, { scope: { selected: ["当前项目", "全部项目"], text: "" }, checks })).toBeNull();
    expect(answerPayload(nativeQuestion, { scope: { selected: [], text: "  ", other: true }, checks })).toBeNull();
    expect(answerPayload(nativeQuestion, { scope: { selected: [], text: " 自定义目录 ", other: true }, checks })).toMatchObject({ answers: { scope: ["自定义目录"] } });
    expect(answerPayload(nativeQuestion, { scope: { selected: ["当前项目"], text: "ignored" }, checks: { selected: ["中文"], text: "回归", other: true } })).toMatchObject({ answers: { scope: ["当前项目"], checks: ["中文", "回归"] } });
  });
  it("supports ask_human and legacy free text without selecting Other", () => {
    const question: QuestionRecord = { ...nativeQuestion, source: "ask_human", prompts: undefined, options: ["JSON", "Markdown"] };
    expect(answerPayload(question, { q1: { selected: [], text: "  自由回答  " } })).toEqual({ answers: { q1: ["自由回答"] }, answer: "自由回答" });
    expect(answerPayload(question, { q1: { selected: ["JSON"], text: "自由回答" } })).toBeNull();
    expect(questionSummary({ ...question, answer: "已选择 JSON" })).toBe("已选择 JSON");
    expect(questionSummary({ ...nativeQuestion, answers: { scope: ["当前项目"], checks: ["中文", "权限"] } })).toBe("当前项目；中文、权限");
  });
});
