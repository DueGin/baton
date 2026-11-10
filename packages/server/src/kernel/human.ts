import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AskHumanInput, EscalationRecord, NodeRecord, QuestionRecord, ResolveEscalationRequest } from "@baton/protocol";
import type { Store } from "../store/index.js";
interface HumanHooks {
  activity(id: string, text: string): void;
  enqueue(id: string, text: string): void;
  cancel(id: string, reason: string): Promise<void>;
  followup(delegationId: string, message: string): Promise<void>;
}
export class HumanInteraction {
  constructor(readonly store: Store, readonly hooks: HumanHooks) {}
  ask(node: NodeRecord, input: AskHumanInput): { questionId: string; status: "pending" } {
    const question: QuestionRecord = { ...input, id: randomUUID(), runId: node.runId, nodeId: node.id, status: "pending", askedAt: new Date().toISOString() };
    this.store.append(node.runId, { type: "question", question });
    if (question.blocking) this.hooks.activity(node.id, `等你回答: ${question.question}`);
    return { questionId: question.id, status: "pending" };
  }
  answer(id: string, answer: string): QuestionRecord {
    z.string().trim().min(1).parse(answer);
    const q = this.store.question(id), node = this.store.node(q.nodeId);
    if (q.status !== "pending") throw new Error("Question is not pending");
    if (["completed", "failed", "canceled", "replaced"].includes(node.status)) throw new Error("Question node is terminal");
    const answered: QuestionRecord = { ...q, answer, status: "answered", answeredAt: new Date().toISOString() };
    this.store.append(q.runId, { type: "question", question: answered });
    this.hooks.enqueue(q.nodeId, `<baton-answer question="${q.id}">\n${answer}\n</baton-answer>`);
    this.refreshActivity(q.nodeId); return answered;
  }
  refreshActivity(id: string): void {
    const node = this.store.node(id), q = this.store.snapshot(node.runId).questions.find((q) => q.nodeId === id && q.blocking && q.status === "pending");
    if (q) this.hooks.activity(id, `等你回答: ${q.question}`);
    else if (node.activity?.startsWith("等你回答:")) this.hooks.activity(id, node.status === "running" ? "Thinking…" : "Idle");
  }
  cancelQuestions(id: string): void {
    const node = this.store.node(id);
    for (const q of this.store.snapshot(node.runId).questions) if (q.nodeId === id && q.status === "pending") this.store.append(q.runId, { type: "question", question: { ...q, status: "canceled" } });
  }
  stall(node: NodeRecord, milliseconds: number): EscalationRecord {
    const record = this.escalate({ nodeId: node.id, runId: node.runId, delegationId: node.delegationId ?? undefined, kind: "stall", detail: `${node.title} (${node.agentId}) has sent no driver events for ${(milliseconds / 60000).toFixed(2)} minutes. Last activity: ${node.activity ?? "unknown"}.` });
    if (node.parentNodeId) this.hooks.enqueue(node.parentNodeId, `<baton-notice>\nDelegation ${node.delegationId} appears stalled (${record.id}). Consider send, reassign or cancel.\n${record.detail}\n</baton-notice>`);
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
    this.hooks.enqueue(parent, `<baton-notice>\nEscalation ${e.id} (${e.kind}) resolved: ${valid.resolution}${valid.resolution === "extend" ? ` (+${valid.extraRounds ?? 2} rounds)` : ""}.\nHuman note: ${valid.note ?? "(none)"}\n</baton-notice>`);
    return resolved;
  }
}
