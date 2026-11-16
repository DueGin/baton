import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AddMemberRequest, ApproveTeamProposalRequest, TeamProposal, DelegateInput, DelegationRecord, ReplaceMemberRequest, ReassignRequest, TeamActor, TeamChange, TeamMember, TeamMemberSpec, TeamPreset, TeamPresetInput, TeamRecord } from "@baton/protocol";
import type { DriverRegistry } from "../driver/types.js";
import type { Store } from "../store/index.js";
import { noticePrompt } from "./prompts.js";
const specSchema = z.object({ role: z.string().trim().min(1).max(40), agentId: z.string().min(1), model: z.string().optional(), modeId: z.string().optional(), thinking: z.string().optional(), responsibilities: z.string().optional() });
const presetSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().optional(), lead: specSchema.omit({ role: true, responsibilities: true }), members: z.array(specSchema).max(12) });
const replacementSchema = specSchema.omit({ role: true }).extend({ reason: z.string().optional(), reassignActive: z.boolean().optional() });
export interface ResolvedMember { member: TeamMember; model?: string; modeId?: string; thinking?: string; proposalId?: string }
export interface TeamHooks {
  cancelForReplacement(nodeId: string, reason: string): Promise<void>;
  create(parentId: string, input: DelegateInput, target: ResolvedMember, replaces: string): Promise<{ delegationId: string; nodeId?: string; proposalId?: string; status?: string }>;
  patchOld(old: DelegationRecord, replacement: string, reason: string): void;
  flush(nodeId: string): void;
  notify(parentId: string, message: string): void;
  admission(parentId: string, excluding?: string): void;
  release(runId: string, proposalId: string): Promise<void>;
}
export class Teams {
  private locks = new Map<string, Promise<unknown>>();
  constructor(readonly store: Store, readonly registry: DriverRegistry, readonly hooks: TeamHooks) {}
  private locked<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(runId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(runId, next); void next.finally(() => { if (this.locks.get(runId) === next) this.locks.delete(runId); }).catch(() => {}); return next;
  }
  private team(runId: string): TeamRecord {
    const r = this.store.snapshot(runId).run;
    if (r.policy.mode === "solo") throw new Error("Solo runs cannot have a team or delegate");
    return r.team ? { ...r.team, proposals: r.team.proposals ?? [] } : { source: "dynamic", members: [], changes: [], proposals: [], updatedAt: new Date().toISOString() };
  }
  private change(runId: string, team: TeamRecord, input: Omit<TeamChange, "at">): TeamRecord {
    const change: TeamChange = { ...input, at: new Date().toISOString() };
    const next = { ...team, changes: [...team.changes, change], updatedAt: change.at };
    this.store.append(runId, { type: "team.updated", team: next, change }); return next;
  }
  async ready(agentId: string): Promise<void> {
    const a = (await this.registry.detect()).find((a) => a.id === agentId);
    if (!a || a.status !== "ready" || !a.enabled || !this.registry.get(agentId)) throw new Error(`Agent unavailable: ${agentId}`);
  }
  private checkSize(runId: string, additions: number): void {
    const run = this.store.snapshot(runId).run;
    if ((run.team?.members.filter((m) => m.status === "active").length ?? 0) + additions > (run.policy.maxTeamSize ?? 5)) throw new Error(`Team size exceeds maxTeamSize (${run.policy.maxTeamSize ?? 5}); reuse existing members`);
  }
  async validateMembers(specs: TeamMemberSpec[]): Promise<TeamMemberSpec[]> {
    const entries = z.array(specSchema).max(12).parse(specs);
    if (new Set(entries.map((m) => m.role)).size !== entries.length) throw new Error("Duplicate active roles; use replace_member to change a role");
    await Promise.all(entries.map((m) => this.ready(m.agentId))); return entries;
  }
  initialize(runId: string, specs: TeamMemberSpec[], by: TeamActor, preset?: TeamPreset): TeamRecord {
    const ts = new Date().toISOString();
    const team: TeamRecord = { source: preset ? "preset" : "dynamic", presetId: preset?.id, presetName: preset?.name, members: specs.map((s) => ({ ...s, id: randomUUID(), status: "active", addedBy: by, addedAt: ts })), changes: [], proposals: [], updatedAt: ts };
    return this.change(runId, team, { kind: "formed", by, reason: preset ? `Preset: ${preset.name}` : "Initial team" });
  }
  form(runId: string, specs: Array<TeamMemberSpec & { reason?: string }>, rationale: string, nodeId: string): Promise<TeamRecord | { status: "pending_approval"; proposalId: string }> {
    return this.locked(runId, async () => {
      if ((this.store.snapshot(runId).run.policy.mode ?? "dynamic") !== "dynamic") throw new Error("form_team is only available in dynamic runs");
      const valid = await this.validateMembers(specs), team = this.team(runId);
      if (valid.some((m) => team.members.some((old) => old.status === "active" && old.role === m.role))) throw new Error("Duplicate active role; use replace_member instead");
      this.checkSize(runId, valid.length);
      if (this.needsApproval(runId)) return this.propose(runId, { kind: team.members.length ? "addition" : "formation", by: "lead", nodeId, rationale, members: valid });
      const first = team.members.length === 0; let next: TeamRecord = { ...team, rationale };
      for (const [index, spec] of valid.entries()) {
        const member: TeamMember = { ...spec, id: randomUUID(), status: "active", addedBy: "lead", addedAt: new Date().toISOString(), reason: specs[index]?.reason };
        next = this.change(runId, { ...next, members: [...next.members, member] }, { kind: first && index === 0 ? "formed" : "member_added", by: "lead", memberId: member.id, reason: member.reason ?? rationale });
      }
      return next;
    });
  }
  async add(runId: string, input: AddMemberRequest, by: TeamActor = "human"): Promise<TeamMember> {
    const spec = specSchema.parse(input); await this.ready(spec.agentId);
    return this.addReady(runId, spec, by, input.reason);
  }
  private addReady(runId: string, spec: TeamMemberSpec, by: TeamActor, reason?: string): TeamMember {
    const team = this.team(runId); this.checkSize(runId, 1);
    if (team.members.some((m) => m.status === "active" && m.role === spec.role)) throw new Error("Duplicate active role; use replace_member instead");
    const member: TeamMember = { ...spec, id: randomUUID(), status: "active", addedBy: by, reason, addedAt: new Date().toISOString() };
    this.change(runId, { ...team, members: [...team.members, member] }, { kind: "member_added", by, memberId: member.id, reason }); return member;
  }
  remove(runId: string, memberId: string): TeamRecord {
    const team = this.team(runId), old = this.member(runId, memberId);
    return this.change(runId, { ...team, members: team.members.map((m) => m.id === old.id ? { ...m, status: "removed" } : m) }, { kind: "member_removed", by: "human", memberId, reason: "Removed by human; existing tasks are unchanged" });
  }
  member(runId: string, idOrRole: string): TeamMember {
    const team = this.team(runId), member = team.members.find((m) => m.status === "active" && (m.id === idOrRole || m.role === idOrRole));
    if (!member) throw new Error(`Active team member not found: ${idOrRole}. Available roles: ${team.members.filter((m) => m.status === "active").map((m) => m.role).join(", ") || "(none)"}`);
    return member;
  }
  get(runId: string): unknown {
    const team = this.team(runId), s = this.store.snapshot(runId);
    return { ...team, members: team.members.map((m) => ({ ...m, delegations: s.delegations.filter((d) => d.memberId === m.id) })) };
  }
  async resolve(runId: string, input: Pick<DelegateInput, "role" | "agent" | "model" | "mode"> & { thinking?: string; nodeId?: string; human?: boolean; /** Reassignment: role and responsibilities the ad-hoc member continues. */ basis?: { role: string; responsibilities?: string } }): Promise<ResolvedMember> {
    const run = this.store.snapshot(runId).run;
    if (run.policy.mode === "solo") throw new Error("Solo runs cannot delegate");
    if (input.role && input.agent) throw new Error("Specify either role or agent, not both");
    let member: TeamMember;
    if (input.role) {
      const pending = this.team(runId).proposals.find((p) => p.status === "pending" && (p.members?.some((m) => m.role === input.role) || p.replace?.with.role === input.role));
      const proposed = pending?.members?.find((m) => m.role === input.role) ?? pending?.replace?.with;
      if (pending && proposed) {
        await this.ready(proposed.agentId);
        member = { ...proposed, id: `${pending.id}:${proposed.role}`, status: "active", addedBy: pending.by, addedAt: pending.proposedAt };
        return { member, model: input.model ?? member.model, modeId: input.mode ?? member.modeId, thinking: input.thinking ?? member.thinking, proposalId: pending.id };
      }
      member = this.member(runId, input.role);
    }
    else {
      if (run.policy.mode === "preset") throw new Error(`Preset runs require a role at every depth. Available roles: ${run.team?.members.filter((m) => m.status === "active").map((m) => m.role).join(", ") || "(none)"}`);
      if (!input.agent) throw new Error("Specify a team role or agent");
      await this.ready(input.agent);
      // A reassigned task keeps its role lineage ("renderer" → "renderer-claude") and responsibilities.
      const base = (input.basis ? `${input.basis.role}-${input.agent}` : input.agent).slice(0, 40);
      const team = this.team(runId); let role = base, suffix = 1;
      while (team.members.some((m) => m.role === role)) role = `${base}-${++suffix}`;
      const spec = { role, agentId: input.agent, model: input.model, modeId: input.mode, thinking: input.thinking, responsibilities: input.basis?.responsibilities ?? "Ad-hoc delegated task" };
      if (!input.human && this.needsApproval(runId)) {
        this.checkSize(runId, 1);
        const proposal = this.propose(runId, { kind: "addition", by: "agent", nodeId: input.nodeId ?? run.rootNodeId, members: [spec], rationale: "Ad-hoc member for direct agent delegation" });
        return { member: { ...spec, id: `${proposal.proposalId}:${role}`, status: "active", addedBy: "agent", addedAt: new Date().toISOString() }, model: spec.model, modeId: spec.modeId, thinking: spec.thinking, proposalId: proposal.proposalId };
      }
      member = this.addReady(runId, spec, input.human ? "human" : "agent");
    }
    await this.ready(member.agentId);
    return { member, model: input.model ?? member.model, modeId: input.mode ?? member.modeId, thinking: input.thinking ?? member.thinking };
  }
  replace(runId: string, memberId: string, input: ReplaceMemberRequest, by: "human" | "lead", initiator?: string): Promise<unknown> {
    return this.locked(runId, async () => {
      const valid = replacementSchema.parse(input), old = this.member(runId, memberId);
      await this.ready(valid.agentId);
      if (by === "lead" && this.needsApproval(runId)) return this.propose(runId, { kind: "replacement", by, nodeId: initiator ?? this.store.snapshot(runId).run.rootNodeId, replace: { memberId: old.id, with: { role: old.role, agentId: valid.agentId, model: valid.model, modeId: valid.modeId, thinking: valid.thinking, responsibilities: valid.responsibilities ?? old.responsibilities }, reassignActive: valid.reassignActive !== false, reason: valid.reason ?? "Member replaced" }, rationale: valid.reason });
      return this.applyReplace(runId, old, valid, by, initiator);
    });
  }
  private async applyReplace(runId: string, old: TeamMember, valid: ReplaceMemberRequest, by: "human" | "lead", initiator?: string): Promise<unknown> {
    const team = this.team(runId), member: TeamMember = { role: old.role, agentId: valid.agentId, model: valid.model, modeId: valid.modeId, thinking: valid.thinking, responsibilities: valid.responsibilities ?? old.responsibilities, id: randomUUID(), status: "active", addedBy: by, addedAt: new Date().toISOString(), reason: valid.reason, replaces: old.id };
    this.change(runId, { ...team, members: [...team.members.map((m) => m.id === old.id ? { ...m, status: "replaced" as const, replacedBy: member.id, reason: valid.reason } : m), member] }, { kind: "member_replaced", by, memberId: member.id, previousMemberId: old.id, reason: valid.reason });
    const replacements: Array<{ delegationId: string; nodeId?: string; replaces: string; status?: string; proposalId?: string }> = [];
    const warnings: string[] = [];
    if (valid.reassignActive !== false) {
      // Failed assignments still need a successful successor; completed/canceled/replaced
      // assignments are historical and are not restarted by a roster change.
      for (const d of this.store.snapshot(runId).delegations.filter((d) => d.memberId === old.id && !["completed", "canceled", "replaced"].includes(d.status))) {
        try { replacements.push(await this.move(d.id, { memberId: member.id, reason: valid.reason ?? "Member replaced" }, initiator)); }
        catch (error) { warnings.push(`${d.id}: ${error instanceof Error ? error.message : String(error)}`); }

      }
    }
    return { member, replacements, warnings };
  }
  reassign(delegationId: string, input: ReassignRequest, initiator?: string): Promise<{ delegationId: string; nodeId?: string; replaces: string; status?: string; proposalId?: string }> {
    return this.locked(this.store.delegation(delegationId).runId, () => this.move(delegationId, input, initiator));
  }
  private async move(id: string, input: ReassignRequest, initiator?: string): Promise<{ delegationId: string; nodeId?: string; replaces: string; status?: string; proposalId?: string }> {
    const old = this.store.delegation(id);
    const request = z.object({ memberId: z.string().optional(), agentId: z.string().optional(), model: z.string().optional(), modeId: z.string().optional(), thinking: z.string().optional(), reason: z.string().optional() }).parse(input);
    input = request;
    if (old.status === "replaced" || old.status === "canceled") throw new Error(`Delegation is ${old.status}${old.replacedBy ? `; replacement: ${old.replacedBy}` : ""}`);
    if (input.memberId && input.agentId) throw new Error("Specify either memberId or agentId");
    const role = input.memberId ? this.member(old.runId, input.memberId).role : undefined;
    const previous = old.memberId ? this.team(old.runId).members.find((m) => m.id === old.memberId) : undefined;
    const basis = old.role ? { role: old.role, responsibilities: previous?.responsibilities } : undefined;
    const target = await this.resolve(old.runId, { role, agent: input.agentId, model: input.model, mode: input.modeId, thinking: input.thinking, nodeId: initiator ?? old.fromNodeId, human: initiator === undefined, basis });
    this.hooks.admission(old.fromNodeId, old.id);
    if (!old.blockedByProposal) this.hooks.flush(old.toNodeId);
    const rows = this.store.items(old.toNodeId), last = rows.filter((r) => r.item.type === "assistant_message").at(-1);
    const files = [...new Set(rows.flatMap((r) => r.item.type === "tool_call" && (r.item.detail.type === "edit" || r.item.detail.type === "write") ? [r.item.detail.filePath] : []))];
    const text = last?.item.type === "assistant_message" ? last.item.text.slice(-2000) : "(No assistant progress yet.)";
    const reason = input.reason || "Task reassigned";
    const context = [old.brief.context, `Predecessor progress (${old.id}; ${reason}):\n${text}\nFiles touched: ${files.length ? files.join(", ") : "(none recorded)"}`].filter(Boolean).join("\n\n");
    if (target.proposalId) {
      const queued = await this.hooks.create(old.fromNodeId, { ...old.brief, context, role: target.member.role, model: input.model, mode: input.modeId }, target, old.id);
      return { ...queued, replaces: old.id };
    }
    if (!old.blockedByProposal) await this.hooks.cancelForReplacement(old.toNodeId, reason);
    const created = await this.hooks.create(old.fromNodeId, { ...old.brief, context, role: target.member.role, model: input.model, mode: input.modeId }, target, old.id);
    this.hooks.patchOld(old, created.delegationId, reason);
    if (initiator !== old.fromNodeId) this.hooks.notify(old.fromNodeId, noticePrompt("team", `Delegation ${old.id} → ${created.delegationId} was reassigned to role "${target.member.role}" (${target.member.agentId}).\nReason: ${reason}\nThe predecessor is replaced; use the new delegation id for follow-ups and results.`));
    return { ...created, replaces: old.id };
  }
  private needsApproval(runId: string): boolean { return this.store.snapshot(runId).run.policy.teamApproval !== false; }
  private propose(runId: string, input: Omit<TeamProposal, "id" | "status" | "proposedAt">): { status: "pending_approval"; proposalId: string } {
    const team = this.team(runId);
    if (team.proposals.some((p) => p.status === "pending")) throw new Error("A team proposal is already pending; end your turn and wait for the human's decision");
    const proposal: TeamProposal = { ...input, id: randomUUID(), status: "pending", proposedAt: new Date().toISOString() };
    this.change(runId, { ...team, proposals: [...team.proposals, proposal] }, { kind: "proposed", by: input.by, proposalId: proposal.id, reason: input.rationale });
    return { status: "pending_approval", proposalId: proposal.id };
  }
  approve(runId: string, proposalId: string, input: ApproveTeamProposalRequest): Promise<TeamRecord> {
    return this.locked(runId, async () => {
      if (this.store.snapshot(runId).run.status === "canceled") throw new Error("Run is canceled");
      const proposal = this.team(runId).proposals.find((p) => p.id === proposalId && p.status === "pending");
      if (!proposal) throw new Error("Pending team proposal not found");
      const request = z.object({ members: z.array(specSchema).optional(), replacement: specSchema.optional(), note: z.string().optional() }).parse(input);
      const approved = proposal.replace ? undefined : await this.validateMembers(request.members ?? proposal.members ?? []);
      const replacement = proposal.replace ? specSchema.parse(request.replacement ?? proposal.replace.with) : undefined;
      if (replacement) { await this.ready(replacement.agentId); if (replacement.role !== proposal.replace?.with.role) throw new Error("Replacement must preserve the existing role; add a new role separately"); }
      const current = this.team(runId);
      if (approved) this.checkSize(runId, approved.length);
      if (proposal.replace) this.member(runId, proposal.replace.memberId);
      if (approved?.some((spec) => current.members.some((m) => m.status === "active" && m.role === spec.role))) throw new Error("Approved role conflicts with an active member; use replace_member");
      const decision: TeamProposal = { ...proposal, status: "approved", approvedMembers: approved, approvedReplacement: replacement, feedback: request.note, decidedAt: new Date().toISOString() };
      this.change(runId, { ...current, proposals: current.proposals.map((p) => p.id === proposalId ? decision : p) }, { kind: "approved", by: "human", proposalId, reason: request.note });
      if (replacement && proposal.replace) {
        await this.applyReplace(runId, this.member(runId, proposal.replace.memberId), { ...replacement, reassignActive: proposal.replace.reassignActive, reason: proposal.replace.reason }, "human");
      } else {
        const roster = this.team(runId);
        this.change(runId, { ...roster, rationale: proposal.rationale ?? roster.rationale }, { kind: proposal.kind === "formation" ? "formed" : "member_added", by: proposal.by, proposalId, reason: proposal.rationale });
        for (const spec of approved ?? []) this.addReady(runId, spec, proposal.by);
      }
      await this.hooks.release(runId, proposalId);
      this.hooks.notify(proposal.nodeId, noticePrompt("team", `Team proposal ${proposalId} approved.\nProposed: ${JSON.stringify(proposal.members ?? proposal.replace?.with)}\nApproved: ${JSON.stringify(approved ?? replacement)}\nFeedback: ${request.note ?? "(none)"}\nUse get_team for the current roster.`));
      return this.team(runId);
    });
  }
  reject(runId: string, proposalId: string, feedback: string): Promise<TeamRecord> {
    return this.locked(runId, async () => {
      z.string().trim().min(1).parse(feedback);
      const team = this.team(runId), proposal = team.proposals.find((p) => p.id === proposalId && p.status === "pending");
      if (!proposal) throw new Error("Pending team proposal not found");
      this.change(runId, { ...team, proposals: team.proposals.map((p) => p.id === proposalId ? { ...p, status: "rejected", feedback, decidedAt: new Date().toISOString() } : p) }, { kind: "rejected", by: "human", proposalId, reason: feedback });
      await this.hooks.release(runId, proposalId);
      this.hooks.notify(proposal.nodeId, noticePrompt("team", `Team proposal ${proposalId} rejected. No proposed roster changes were applied; queued tasks for it were canceled.\nProposed: ${JSON.stringify(proposal.members ?? proposal.replace?.with)}\nFeedback: ${feedback}\nRevise the plan before proposing another team.`));
      return this.team(runId);
    });
  }
  async savePreset(input: TeamPresetInput, id?: string): Promise<TeamPreset & { warnings: string[] }> {
    const valid = presetSchema.parse(input), catalog = await this.registry.detect();
    if (new Set(valid.members.map((m) => m.role)).size !== valid.members.length) throw new Error("Duplicate roles in preset");
    const warnings: string[] = [];
    for (const agentId of new Set([valid.lead.agentId, ...valid.members.map((m) => m.agentId)])) {
      const entry = catalog.find((a) => a.id === agentId); if (!entry) throw new Error(`Unknown agent id: ${agentId}`);
      if (entry.status !== "ready" || !entry.enabled) warnings.push(`${agentId} is currently ${entry.status}${!entry.enabled ? " and disabled" : ""}; it must be ready to start a run`);
    }
    const ts = new Date().toISOString(), old = id ? this.store.preset(id) : undefined;
    const preset: TeamPreset = { ...valid, id: id ?? randomUUID(), createdAt: old?.createdAt ?? ts, updatedAt: ts };
    this.store.savePreset(preset); return { ...preset, warnings };
  }
  async saveRun(runId: string, input: { name: string; description?: string }): Promise<TeamPreset> {
    const s = this.store.snapshot(runId), root = s.nodes.find((n) => n.id === s.run.rootNodeId)!;
    return this.savePreset({ ...input, lead: { agentId: root.agentId, model: root.model, modeId: root.modeId, thinking: root.thinking }, members: (s.run.team?.members ?? []).filter((m) => m.status === "active").map(({ role, agentId, model, modeId, thinking, responsibilities }) => ({ role, agentId, model, modeId, thinking, responsibilities })) });
  }
}
