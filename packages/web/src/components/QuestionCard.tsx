import { useState } from "react";
import type { AnswerQuestionRequest, QuestionPrompt, QuestionRecord } from "@baton/protocol";
import { answerPayload, questionCardId, questionPrompts, questionSummary, selectAnswer, type PromptDraft, type QuestionDraft } from "../lib/questions.js";
import { markdownPlainText } from "../lib/markdown.js";
import { clock } from "../lib/derive.js";
import { InlineMarkdown, Markdown } from "./Markdown.js";
import { Icon } from "./common.js";

function statusLabel(question: QuestionRecord): string {
  if (question.status === "pending") return "等你回答";
  if (question.status === "answered") return "已回答";
  return question.declinedAt ? "未作答" : "提问已取消";
}
function deliveryLabel(question: QuestionRecord): string {
  if (question.delivery !== "inline") return question.blocking ? "阻塞任务" : "不阻塞";
  if (question.status === "answered") return "已继续";
  if (question.status === "pending") return "等待本轮继续";
  return question.declinedAt ? "agent 自行判断" : "已结束";
}

function PromptOptions({ question, prompt, draft, busy, choose, toggleOther }: { question: QuestionRecord; prompt: QuestionPrompt; draft: PromptDraft; busy: boolean; choose: (label: string) => void; toggleOther: () => void }) {
  const role = prompt.multiSelect ? "checkbox" : "radio";
  return <div className="question-options" role={prompt.multiSelect ? "group" : "radiogroup"} aria-label={markdownPlainText(prompt.header ?? prompt.question)}>
    {prompt.options.map(option => { const selected = draft.selected.includes(option.label); return <button type="button" role={role} aria-checked={selected} className={`question-option${selected ? " selected" : ""}`} disabled={busy} key={option.label} onClick={() => choose(option.label)}>
      <i className="question-option-mark" aria-hidden="true">{selected ? "✓" : prompt.multiSelect ? "□" : "○"}</i>
      <span className="question-option-text"><span className="question-option-label"><InlineMarkdown text={option.label} /></span>{option.description && <span className="question-option-description"><InlineMarkdown text={option.description} /></span>}</span>
    </button>; })}
    {question.source === "native" && prompt.allowFreeText && prompt.options.length > 0 && <button type="button" role={role} aria-checked={Boolean(draft.other)} className={`question-option${draft.other ? " selected" : ""}`} disabled={busy} onClick={toggleOther}><i className="question-option-mark" aria-hidden="true">{draft.other ? "✓" : prompt.multiSelect ? "□" : "○"}</i><span className="question-option-text"><span className="question-option-label">其他</span></span></button>}
  </div>;
}

// compact: the docked variant above the composer (and the slim transcript record once answered). A
// pending card can be minimised to its heading without losing the draft, or closed — 不作答 — which
// tells the agent to carry on with its own judgment.
export function QuestionCard({ question, answer, decline, busy, inline = false, compact = false }: { question: QuestionRecord; answer: (id: string, request: AnswerQuestionRequest) => void; decline?: (id: string) => void; busy: boolean; inline?: boolean; compact?: boolean }) {
  const [drafts, setDrafts] = useState<QuestionDraft>({}); const [collapsed, setCollapsed] = useState(false);
  const prompts = questionPrompts(question); const payload = answerPayload(question, drafts);
  const pending = question.status === "pending"; const minimised = compact && collapsed && pending;
  const preview = `${markdownPlainText(prompts[0]?.question ?? question.question)}${prompts.length > 1 ? ` 等 ${prompts.length} 个问题` : ""}`;
  const body = <>{prompts.map((prompt, index) => {
    const draft = drafts[prompt.id] ?? { selected: [], text: "" };
    const free = prompt.allowFreeText && (question.source !== "native" || draft.other || !prompt.options.length);
    const update = (patch: Partial<PromptDraft>) => setDrafts(previous => ({ ...previous, [prompt.id]: { ...draft, ...patch } }));
    return <section className="question-prompt" key={prompt.id}>
      <div className="question-prompt-header">{prompt.header ?? (prompts.length > 1 ? `问题 ${index + 1}` : "问题")}{prompt.multiSelect && <span className="tag">多选</span>}</div>
      <div className="question-prompt-text"><Markdown text={prompt.question} /></div>
      {pending ? <><PromptOptions question={question} prompt={prompt} draft={draft} busy={busy} choose={label => setDrafts(previous => ({ ...previous, [prompt.id]: selectAnswer(prompt, draft, label) }))} toggleOther={() => update({ other: !draft.other, ...(prompt.multiSelect ? {} : { selected: [] }) })} />
        {free && <textarea aria-label={`${markdownPlainText(prompt.header ?? prompt.question)} · 自由回答`} rows={2} disabled={busy} value={draft.text} placeholder={question.source === "native" ? "填写其他回答…" : "也可以自由回答…"} onChange={event => update({ text: event.target.value, ...(!prompt.multiSelect ? { selected: [] } : {}) })} />}</>
        : question.status === "answered" && <div className="question-saved-answer"><Markdown text={question.answers?.[prompt.id]?.join("、") ?? question.answer ?? ""} /></div>}
    </section>;
  })}
    {question.delivery === "async" && pending && <p className="question-async">答案会作为新消息送达</p>}
    {question.status === "canceled" && <p className="question-cancel-reason">{question.declinedAt ? "你选择了不作答，agent 会自行判断后继续。" : question.cancelReason ?? "问题已取消"}</p>}
  </>;
  return <article id={inline ? questionCardId(question.id) : undefined} tabIndex={-1} className={`human-card question-card question-${question.status}${question.declinedAt ? " question-declined" : ""}${compact ? " is-compact" : ""}${minimised ? " is-minimised" : ""}`}>
    <div className="human-card-heading">
      <strong>{statusLabel(question)}</strong><span className="tag">{question.source === "native" ? "Agent 提问" : "ask_human"} · {deliveryLabel(question)}</span>
      {minimised && <span className="question-minimised-text" title={prompts.map(prompt => markdownPlainText(prompt.question)).join("\n")}>{preview}</span>}
      <time>{clock(question.askedAt)}</time>
      {compact && pending && <button type="button" className="icon-button question-collapse" aria-expanded={!collapsed} aria-label={collapsed ? "展开问题" : "收起问题"} title={collapsed ? "展开问题" : "收起问题"} onClick={() => setCollapsed(value => !value)}><Icon name="down" size={13} /></button>}
      {pending && decline && <button type="button" className="icon-button question-decline" disabled={busy} aria-label="不作答，关闭问题" title="不作答：关闭问题，agent 会自行判断后继续" onClick={() => decline(question.id)}><Icon name="close" size={13} /></button>}
    </div>
    {minimised ? null : question.status === "answered" ? <details className="question-answered"><summary>你的回答：{questionSummary(question)}</summary>{body}</details>
      : <>{body}{pending && <div className="question-submit"><button type="button" className="button small primary" disabled={busy || !payload} onClick={() => { if (payload) answer(question.id, payload); }}>提交回答</button><span className="muted">{prompts.length > 1 ? "请回答全部问题" : "选择选项或填写回答后提交"}{decline ? " · 不想回答可点右上角 ×" : ""}</span></div>}</>}
  </article>;
}
