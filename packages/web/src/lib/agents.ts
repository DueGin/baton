import type { AgentEntry, TeamMemberSpec } from "@baton/protocol";

export const agentGroupLabels = { ready: "已就绪", error: "版本过低或出错", unavailable: "未安装", disabled: "已禁用", loading: "检测中" };
export type AgentGroup = keyof typeof agentGroupLabels;
export function agentGroup(agent: AgentEntry): AgentGroup { return !agent.enabled ? "disabled" : agent.status; }
export const agentReady = (agent?: AgentEntry): boolean => agent?.enabled === true && agent.status === "ready";
export function agentMatches(agent: AgentEntry, query: string): boolean {
  const haystack = [agent.id, agent.label, agent.kind, agent.version, agent.notes, agent.diagnostic, agent.source === "config" ? "自定义 config" : "builtin", ...agent.models.flatMap(model => [model.id, model.label]), ...agent.modes.flatMap(mode => [mode.id, mode.label])].join(" ").toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(word => haystack.includes(word));
}
export function sortAgents(agents: AgentEntry[]): AgentEntry[] {
  const rank: Record<AgentGroup, number> = { ready: 0, error: 1, unavailable: 2, disabled: 3, loading: 4 };
  return [...agents].sort((a, b) => rank[agentGroup(a)] - rank[agentGroup(b)] || a.label.localeCompare(b.label, "zh-CN") || a.id.localeCompare(b.id));
}
export function groupAgents(agents: AgentEntry[], query = ""): Array<{ key: AgentGroup; label: string; agents: AgentEntry[] }> {
  const filtered = sortAgents(agents).filter(agent => agentMatches(agent, query));
  return (Object.keys(agentGroupLabels) as AgentGroup[]).map(key => ({ key, label: agentGroupLabels[key], agents: filtered.filter(agent => agentGroup(agent) === key) }));
}
export function pickerAgents(agents: AgentEntry[], query = "", selected?: string): AgentEntry[] {
  return sortAgents(agents).filter(agent => agentMatches(agent, query) || agent.id === selected);
}
export function unavailableMembers(agents: AgentEntry[], members: Pick<TeamMemberSpec, "agentId" | "role">[]): string[] {
  return members.filter(member => !agentReady(agents.find(agent => agent.id === member.agentId))).map(member => `${member.role || "成员"}：${member.agentId || "未选择 agent"} 当前不可用`);
}
export function agentHomepage(url?: string): string | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; }
}
