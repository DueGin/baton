import type { AnswerQuestionRequest, ItemRecord, QuestionPrompt, QuestionRecord } from "@baton/protocol";
import type { ConversationEntry } from "./conversation.js";

export interface PromptDraft { selected: string[]; text: string; other?: boolean }
export type QuestionDraft = Record<string, PromptDraft>;
export function questionPrompts(question: QuestionRecord): QuestionPrompt[] {
  return question.prompts?.length ? question.prompts : [{ id: "q1", question: question.question, options: (question.options ?? []).map(label => ({ label })), allowFreeText: true }];
}
export function selectAnswer(prompt: QuestionPrompt, draft: PromptDraft, label: string): PromptDraft {
  return prompt.multiSelect ? { ...draft, selected: draft.selected.includes(label) ? draft.selected.filter(value => value !== label) : [...draft.selected, label] } : { ...draft, selected: [label], other: false, text: "" };
}
export function answerPayload(question: QuestionRecord, drafts: QuestionDraft): AnswerQuestionRequest | null {
  const answers: Record<string, string[]> = {}; const summaries: string[] = []; const prompts = questionPrompts(question);
  for (const prompt of prompts) {
    const draft = drafts[prompt.id] ?? { selected: [], text: "" };
    const selected = draft.selected.filter(value => prompt.options.some(option => option.label === value));
    const freeText = prompt.allowFreeText && (question.source !== "native" || draft.other || !prompt.options.length) ? draft.text.trim() : "";
    const values = [...new Set([...selected, ...(freeText ? [freeText] : [])])];
    if (!values.length || !prompt.multiSelect && values.length > 1 || draft.other && !freeText) return null;
    answers[prompt.id] = values;
    summaries.push(`${prompts.length > 1 ? `${prompt.header ?? prompt.question}：` : ""}${values.join("、")}`);
  }
  return { answers, answer: summaries.join("\n") };
}
export function questionSummary(question: QuestionRecord): string {
  return question.answer ?? questionPrompts(question).map(prompt => question.answers?.[prompt.id]?.join("、")).filter(Boolean).join("；");
}
export function questionCardId(id: string): string { return `question-${encodeURIComponent(id)}`; }
export function pendingQuestion(question: QuestionRecord): boolean { return question.status === "pending" && (question.blocking || question.delivery === "inline"); }
export function questionToolName(name: string): boolean { return /askuserquestion|request_user_input|ask_human|(?:^|[._])ask$/i.test(name); }
export function representedQuestion(permission: { nodeId: string; requestId: string; request: { kind?: string } }, questions: QuestionRecord[]): boolean {
  return permission.request.kind === "question" && questions.some(question => question.nodeId === permission.nodeId && question.source === "native" && (question.anchor?.callId === permission.requestId || question.status === "pending"));
}
export type QuestionTranscriptEntry = { type: "row"; entry: ConversationEntry } | { type: "question"; question: QuestionRecord };
export function inlineQuestionEntries(entries: ConversationEntry[], questions: QuestionRecord[], nodeId: string): QuestionTranscriptEntry[] {
  const result: QuestionTranscriptEntry[] = []; const byIndex = new Map<number, QuestionRecord[]>();
  for (const question of questions.filter(question => question.nodeId === nodeId)) {
    const anchor = question.anchor;
    let index = anchor?.callId ? entries.findIndex(({ row }) => row.item.type === "tool_call" && row.item.callId === anchor.callId) : -1;
    if (index < 0 && anchor?.itemSeq !== undefined) index = entries.findIndex(({ row }) => row.seq === anchor.itemSeq);
    if (index < 0) {
      const before = entries.findIndex(({ row }) => Date.parse(row.ts) > Date.parse(question.askedAt));
      index = before < 0 ? entries.length - 1 : before - 1;
    }
    byIndex.set(index, [...byIndex.get(index) ?? [], question]);
  }
  const cards = (index: number) => { for (const question of byIndex.get(index) ?? []) result.push({ type: "question", question }); };
  cards(-1);
  entries.forEach((entry, index) => {
    const row: ItemRecord = entry.row;
    if (!(row.item.type === "tool_call" && byIndex.has(index) && questionToolName(row.item.name))) result.push({ type: "row", entry });
    cards(index);
  });
  return result;
}
