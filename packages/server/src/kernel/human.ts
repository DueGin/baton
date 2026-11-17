import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AnswerQuestionRequest, AskHumanInput, EscalationRecord, NodeRecord, QuestionRecord, ResolveEscalationRequest } from "@baton/protocol";
import type { Store } from "../store/index.js";
import { questionAnswers } from "./questions.js";
import { noticePrompt } from "./prompts.js";
interface HumanHooks {
  activity(id: string, text: string): void;
  enqueue(id: string, text: string): void;
  cancel(id: string, reason: string): Promise<void>;
  followup(delegationId: string, message: string): Promise<void>;
  nativeAnswer(question: QuestionRecord): Promise<void>;
  nativeDecline(question: QuestionRecord, message: string): Promise<void>;
}
const DECLINED_MESSAGE = "The human closed this question without answering. Do not ask it again; continue with your best judgment and state the assumption you made.";
export class HumanInteraction {
  private waiting = new Map<string, (question: QuestionRecord) => void>();
  private answering = new Set<string>();
  constructor(readonly store: Store, readonly hooks: HumanHooks) {}
  async ask(node: NodeRecord, input: AskHumanInput, anchor: QuestionRecord["anchor"], timeoutMs: number, forceAsync = false): Promise<unknown> {
    const inline = input.blocking && !forceAsync;
    const question: QuestionRecord = { ...input, id: randomUUID(), runId: node.runId, nodeId: node.id, source: "ask_human", delivery: inline ? "inline" : "async", prompts: [{ id: "q1", question: input.question, options: (input.options ?? []).map((label) => ({ label })), multiSelect: input.multiSelect, allowFreeText: true }], anchor, status: "pending", askedAt: new Date().toISOString() };
    this.store.append(node.runId, { type: "question", question });
    if (question.blocking) this.hooks.activity(node.id, `等你回答: ${question.question}`);
    if (!inline) return { questionId: question.id, status: "pending" };
    return new Promise((resolve) => {
      const finish = (q: QuestionRecord): void => {
        clearTimeout(timer); this.waiting.delete(q.id);
        resolve(q.status === "answered" ? { questionId: q.id, status: "answered", answer: q.answer, answers: q.answers } : q.declinedAt ? { questionId: q.id, status: "declined", message: DECLINED_MESSAGE } : { questionId: q.id, status: q.status === "canceled" ? "canceled" : "no_answer_yet" });
      };
      const timer = setTimeout(() => {
        const current = this.store.question(question.id);
        const asyncQuestion = { ...current, delivery: "async" as const };
        this.store.append(node.runId, { type: "question", question: asyncQuestion }); finish(asyncQuestion);
      }, timeoutMs); timer.unref();
      this.waiting.set(question.id, finish);
    });
  }
  async answer(id: string, input: string | AnswerQuestionRequest): Promise<QuestionRecord> {
    const q = this.store.question(id), node = this.store.node(q.nodeId);
    if (q.status !== "pending") throw new Error("Question is not pending");
    if (q.source === "native" && ["canceled", "replaced"].includes(node.status)) throw new Error("Question node is terminal");
    if (this.answering.has(id)) throw new Error("Question answer is already in progress");
    const prompts = q.prompts ?? [{ id: "q1", question: q.question, options: (q.options ?? []).map((label) => ({ label })), allowFreeText: true }];
    const result = questionAnswers(prompts, typeof input === "string" ? { answer: input } : input);
    const answered: QuestionRecord = { ...q, ...result, status: "answered", answeredAt: new Date().toISOString() };
    this.answering.add(id);
    try {
      this.store.append(q.runId, { type: "question", question: answered });
      if (q.source === "native") await this.hooks.nativeAnswer(answered);
      const waiting = this.waiting.get(id);
      if (q.delivery === "inline" && waiting) waiting(answered);
      else if (q.source !== "native") this.hooks.enqueue(q.nodeId, `<baton-answer question="${q.id}">\n${result.answer}\n${JSON.stringify(result.answers)}\n</baton-answer>`);
      this.refreshActivity(q.nodeId); return answered;
    } catch (error) {
      if (q.source === "native") {
        const ended = this.store.snapshot(q.runId).turns.some((turn) => turn.id === q.anchor?.turnId && turn.status !== "running");
        this.store.append(q.runId, { type: "question", question: ended ? { ...q, status: "canceled", cancelReason: "Question turn ended while answering" } : q });
      }
      throw error;
    }
    finally { this.answering.delete(id); }
  }
  /** The human closed the card without answering; tell the agent so it can carry on. */
  async decline(id: string): Promise<QuestionRecord> {
    const q = this.store.question(id);
    if (q.status !== "pending") throw new Error("Question is not pending");
    if (this.answering.has(id)) throw new Error("Question answer is already in progress");
    const declined: QuestionRecord = { ...q, status: "canceled", cancelReason: "用户选择不作答", declinedAt: new Date().toISOString() };
    this.answering.add(id);
    try {
      this.store.append(q.runId, { type: "question", question: declined });
      if (q.source === "native") await this.hooks.nativeDecline(declined, DECLINED_MESSAGE).catch(() => {});
      const waiting = this.waiting.get(id);
      if (waiting) waiting(declined);
      else if (q.source !== "native") this.hooks.enqueue(q.nodeId, `<baton-answer question="${q.id}" declined="true">\n${DECLINED_MESSAGE}\n</baton-answer>`);
      this.refreshActivity(q.nodeId); return declined;
    } finally { this.answering.delete(id); }
  }
  refreshActivity(id: string): void {
    const node = this.store.node(id), q = this.store.snapshot(node.runId).questions.find((q) => q.nodeId === id && q.blocking && q.status === "pending");
    if (q) this.hooks.activity(id, `等你回答: ${q.question}`);
    else if (node.activity?.startsWith("等你回答:")) this.hooks.activity(id, node.status === "running" ? "Thinking…" : "Idle");
  }
  endQuestions(id: string, reason: string, cancelAll = false, turnId?: string): void {
    const node = this.store.node(id);
    for (const q of this.store.snapshot(node.runId).questions) if (q.nodeId === id && q.status === "pending" && (!turnId || !q.anchor?.turnId || q.anchor.turnId === turnId)) {
      const next: QuestionRecord = cancelAll || q.source === "native" ? { ...q, status: "canceled", cancelReason: reason } : { ...q, delivery: "async" };
      if (next.status !== q.status || next.delivery !== q.delivery) this.store.append(q.runId, { type: "question", question: next });
      this.waiting.get(q.id)?.(next);
    }
  }
  shutdown(): void { for (const run of this.store.list()) for (const node of this.store.snapshot(run.id).nodes) this.endQuestions(node.id, "Daemon restarted"); }
  stall(node: NodeRecord, milliseconds: number): EscalationRecord {
    const record = this.escalate({ nodeId: node.id, runId: node.runId, delegationId: node.delegationId ?? undefined, kind: "stall", detail: `${node.title} (${node.agentId}) has sent no driver events for ${(milliseconds / 60000).toFixed(2)} minutes. Last activity: ${node.activity ?? "unknown"}.` });
    if (node.parentNodeId) this.hooks.enqueue(node.parentNodeId, noticePrompt("system", `Delegation ${node.delegationId} appears stalled (${record.id}). Consider send, reassign or cancel.\n${record.detail}`));
    return record;
  }
  limit(delegationId: string, message: string, maximum: number): { status: "escalated"; escalationId: string } {
    const d = this.store.delegation(delegationId);
    const existing = this.store.snapshot(d.runId).escalations.find((e) => e.kind === "round_limit" && e.delegationId === d.id && e.status === "pending");
    if (existing) throw new Error(`Round-limit escalation ${existing.id} is pending; end your turn and wait for the human`);
    const escalation = this.escalate({ runId: d.runId, nodeId: d.toNodeId, delegationId: d.id, kind: "round_limit", detail: `Follow-up would exceed the limit of ${maximum} rounds for "${d.brief.title}" (currently round ${d.round}).`, pendingMessage: message });
    return { status: "escalated", escalationId: escalation.id };
  }
  private escalate(input: Omit<EscalationRecord, "id" | "status" | "createdAt">): EscalationRecord {
    const escalation: EscalationRecord = { ...input, id: randomUUID(), status: "pending", createdAt: new Date().toISOString() };
    this.store.append(input.runId, { type: "escalation", escalation }); return escalation;
  }
  async resolve(id: string, input: ResolveEscalationRequest): Promise<EscalationRecord> {
    const valid = z.object({ resolution: z.enum(["extend", "cancel", "dismiss"]), extraRounds: z.number().int().positive().max(100).optional(), note: z.string().optional() }).parse(input);
    const e = this.store.escalation(id);
    if (e.status !== "pending") throw new Error("Escalation is not pending");
    if (valid.resolution === "extend" && e.kind !== "round_limit") throw new Error("Only round-limit escalations may be extended");
    const resolved: EscalationRecord = { ...e, status: "resolved", resolution: valid.resolution, note: valid.note, resolvedAt: new Date().toISOString() };
    // Resolve before any provider mutation to prevent two HTTP decisions delivering twice.
    this.store.append(e.runId, { type: "escalation", escalation: resolved });
    let extended = 0;
    try {
      if (valid.resolution === "extend" && e.delegationId) {
        const d = this.store.delegation(e.delegationId);
        if (["canceled", "replaced"].includes(d.status)) throw new Error(`Delegation is ${d.status}`);
        extended = valid.extraRounds ?? 2; this.store.extendRounds(d.id, extended);
        if (e.pendingMessage) await this.hooks.followup(d.id, e.pendingMessage);
      } else if (valid.resolution === "cancel") await this.hooks.cancel(e.nodeId, valid.note ?? "Canceled from escalation");
    } catch (error) {
      if (extended && e.delegationId) this.store.extendRounds(e.delegationId, -extended);
      this.store.append(e.runId, { type: "escalation", escalation: e }); throw error;
    }
    const node = this.store.node(e.nodeId), parent = e.delegationId ? this.store.delegation(e.delegationId).fromNodeId : node.id;
    this.hooks.enqueue(parent, noticePrompt("system", `Escalation ${e.id} (${e.kind}) resolved: ${valid.resolution}${valid.resolution === "extend" ? ` (+${valid.extraRounds ?? 2} rounds)` : ""}.\nHuman note: ${valid.note ?? "(none)"}`));
    return resolved;
  }
}
