import type { AgentEntry } from "@baton/protocol";
import { agentGroup, agentGroupLabels, agentReady, agentSearchText, sortAgents } from "../lib/agents.js";
import type { SelectOption } from "../lib/listbox.js";
import { AgentMark } from "./common.js";
import { Select } from "./Select.js";

/** Agents as dropdown rows: ready first, unavailable ones listed but disabled; the current agent stays listed while searching. */
export function agentOptions(agents: AgentEntry[], value: string): SelectOption[] {
  return sortAgents(agents).map(agent => {
    const ready = agentReady(agent); const group = agentGroupLabels[agentGroup(agent)];
    return { value: agent.id, label: agent.label, description: `${agent.kind === "acp" ? "ACP" : "Native"} · ${agent.version ?? group}`, icon: <AgentMark agent={agent.id} small />, keywords: agentSearchText(agent), ...(ready ? {} : { disabled: true, hint: group, warning: "不可用" }), ...(agent.id === value ? { pinned: true } : {}) };
  });
}
export function AgentPicker({ agents, value, change, label = "Agent" }: { agents: AgentEntry[]; value: string; change: (id: string) => void; label?: string }) {
  const known = agents.some(agent => agent.id === value);
  return <div className="searchable-agent-picker">
    <span className="agent-picker-label">{label}</span>
    <Select label={label} value={value} options={agentOptions(agents, value)} onChange={change} placeholder="选择 agent" searchable searchPlaceholder="搜索 agent 或模型…" emptyText="没有匹配的 agent" popoverMinWidth={290} />
    {value && !known && <span className="error-text">未检测到 {value}</span>}
  </div>;
}
