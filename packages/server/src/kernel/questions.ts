/**
 * Ported from Paseo packages/server/src/server/agent/providers/claude/agent.ts,
 * providers/codex/async-questions.ts and providers/question-card-answer.ts (Apache-2.0).
 * Modified for baton's structured QuestionPrompt/answers and native permission bridge.
 */
import type { AnswerQuestionRequest, PermissionRequest, QuestionPrompt } from "@baton/protocol";

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
export function nativePrompts(request: PermissionRequest): QuestionPrompt[] {
  const input = request.input ?? {}, params = record(input.params);
  const list = Array.isArray(input.questions) ? input.questions : Array.isArray(params.questions) ? params.questions : [input];
  return list.slice(0, 4).map((value, index) => {
    const q = record(value), fallback = request.description || request.title || request.name;
    return {
      id: text(q.id) || text(q.header) || `q${index + 1}`,
      ...(text(q.header) || text(q.title) ? { header: text(q.header) || text(q.title) } : {}),
      question: text(q.question) || text(q.message) || text(q.title) || fallback,
      options: (Array.isArray(q.options) ? q.options : []).flatMap((option) => {
        const label = typeof option === "string" ? option : text(record(option).label);
        return label ? [{ label, ...(text(record(option).description) ? { description: text(record(option).description) } : {}) }] : [];
      }),
      multiSelect: q.multiSelect === true || q.multi_select === true,
      allowFreeText: true,
    };
  });
}
/** Preserve labels containing commas when a legacy free-text multi-select answer is used. */
function splitAnswer(answer: string, labels: string[]): string[] {
  let remaining = answer;
  const selected: string[] = [];
  while (remaining) {
    const label = labels.filter((value) => !selected.includes(value)).sort((a, b) => b.length - a.length).find((value) => remaining === value || remaining.startsWith(`${value}, `));
    if (!label) break;
    selected.push(label); remaining = remaining === label ? "" : remaining.slice(label.length + 2);
  }
  return remaining ? [...selected, remaining] : selected;
}
export function questionAnswers(prompts: QuestionPrompt[], input: AnswerQuestionRequest): { answer: string; answers: Record<string, string[]> } {
  if (input.answer !== undefined && typeof input.answer !== "string") throw new Error("answer must be a string");
  if (input.answers !== undefined && (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers))) throw new Error("answers must be an object");
  const answers: Record<string, string[]> = {};
  for (const prompt of prompts) {
    const supplied = input.answers?.[prompt.id];
    if (supplied !== undefined && (!Array.isArray(supplied) || supplied.some((value) => typeof value !== "string"))) throw new Error("Each answer must be an array of strings");
    const values = supplied?.map((value) => value.trim()).filter(Boolean) ?? (prompts.length === 1 && input.answer?.trim() ? prompt.multiSelect ? splitAnswer(input.answer.trim(), prompt.options.map((option) => option.label)) : [input.answer.trim()] : []);
    if (!values.length) throw new Error(`Answer ${prompt.header || prompt.id} before submitting`);
    answers[prompt.id] = values;
  }
  return { answers, answer: input.answer?.trim() || prompts.map((prompt) => `${prompts.length > 1 ? `${prompt.question}: ` : ""}${answers[prompt.id]!.join(", ")}`).join("\n") };
}
export function nativeUpdatedInput(request: PermissionRequest, prompts: QuestionPrompt[], answers: Record<string, string[]>): Record<string, unknown> {
  const original = request.input ?? {};
  if (/^(acp_elicitation|cursor_ask_question)$/.test(request.name)) return { ...original, answers };
  if (/AskUserQuestion/i.test(request.name)) {
    const questions = (Array.isArray(original.questions) ? original.questions : []).map((value) => { const { allowOther: _ui, ...question } = record(value); return question; });
    return { ...original, questions, answers: Object.fromEntries(prompts.map((prompt) => [prompt.question, answers[prompt.id]!.join(", ")])) };
  }
  if (/request_user_input|requestUserInput/i.test(request.name)) return { ...original, answers: Object.fromEntries(prompts.map((prompt) => [prompt.id, { answers: answers[prompt.id]! }])) };
  return { ...original, value: prompts[0]?.multiSelect ? answers[prompts[0].id] : answers[prompts[0]?.id ?? ""]?.join(", ") };
}
