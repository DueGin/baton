import type { AgentEntry, DelegationStatus, RunSnapshot, TeamActor, TeamChange, TeamMember, TeamMemberSpec, TeamPresetInput, TeamRecord } from "@baton/protocol";

export const collaborationLabels = { dynamic: "动态组队", preset: "预设团队", solo: "单独完成" };
export const actorLabels: Record<TeamActor, string> = { human: "你", lead: "主导者", preset: "预设", agent: "Agent" };
export const changeLabels: Record<TeamChange["kind"], string> = { proposed: "提案待确认", approved: "已批准名单", rejected: "已驳回名单", formed: "组队", member_added: "加人", member_replaced: "换人", member_removed: "移除" };
export const activeMembers = (team?: TeamRecord): TeamMember[] => team?.members.filter(member => member.status === "active") ?? [];
export const pendingProposals = (team?: TeamRecord) => team?.proposals?.filter(proposal => proposal.status === "pending") ?? [];
export function rosterRows(snapshot: RunSnapshot): Array<{ member: TeamMember; total: number; counts: Partial<Record<DelegationStatus, number>> }> {
  return (snapshot.run.team?.members ?? []).map(member => {
    const delegations = snapshot.delegations.filter(edge => edge.memberId === member.id);
    const counts: Partial<Record<DelegationStatus, number>> = {};
    for (const edge of delegations) counts[edge.status] = (counts[edge.status] ?? 0) + 1;
    return { member, counts, total: delegations.length };
  });
}
export function validateMembers(members: TeamMemberSpec[]): string[] {
  const errors: string[] = []; const roles = new Set<string>();
  members.forEach((member, index) => {
    const role = member.role.trim();
    if (!role) errors.push(`成员 ${index + 1}：请填写角色`);
    else if (roles.has(role)) errors.push(`角色重复：${role}`);
    roles.add(role);
    if (!member.agentId.trim()) errors.push(`成员 ${index + 1}：请选择 agent`);
  });
  return errors;
}
export function validatePreset(preset: TeamPresetInput): string[] {
  return [...(!preset.name.trim() ? ["请填写预设名称"] : []), ...(!preset.lead.agentId.trim() ? ["请选择 lead agent"] : []), ...validateMembers(preset.members)];
}
export function cleanMember(member: TeamMemberSpec): TeamMemberSpec {
  return { role: member.role.trim(), agentId: member.agentId.trim(), ...(member.model ? { model: member.model } : {}), ...(member.modeId ? { modeId: member.modeId } : {}), ...(member.thinking ? { thinking: member.thinking } : {}), ...(member.responsibilities?.trim() ? { responsibilities: member.responsibilities.trim() } : {}) };
}
export function defaultAgentSpec(agents: AgentEntry[], id?: string): TeamPresetInput["lead"] {
  const agent = agents.find(entry => entry.id === id) ?? agents.find(entry => entry.status === "ready" && entry.enabled);
  return { agentId: agent?.id ?? "", model: agent?.models.find(model => model.isDefault)?.id ?? agent?.models[0]?.id, modeId: agent?.defaultModeId ?? undefined };
}
