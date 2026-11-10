import type { NodeRecord, NodeStatus, RunSnapshot, RunStatus, RunSummary } from "@baton/protocol";

export const agentColors: Record<string, string> = { claude: "#cc795a", codex: "#22a584", pi: "#8c7ce9", gemini: "#5989dc" };
export const statusLabels: Record<string, string> = {
  member_active: "在队",
  starting: "启动中", running: "运行中", idle: "空闲", waiting_permission: "等待授权", waiting_children: "等待子节点", completed: "已完成", failed: "失败", canceled: "已取消", replaced: "已替换", removed: "已移除", interrupted: "已中断", active: "进行中", queued: "排队中", ready: "可用", unavailable: "不可用", error: "异常", loading: "检测中",
};
export const terminal = (status: string): boolean => ["completed", "failed", "canceled", "replaced"].includes(status);
export function displayStatus(node: NodeRecord, snapshot: RunSnapshot): NodeStatus | "waiting_children" {
  if (["running", "idle"].includes(node.status) && snapshot.delegations.some(edge => edge.fromNodeId === node.id && !terminal(edge.status))) return "waiting_children";
  return node.status;
}
export function displayRunStatus(snapshot: Pick<RunSnapshot, "run" | "nodes">): RunStatus {
  if (snapshot.run.status === "idle" && snapshot.nodes.some(node => ["starting", "running", "waiting_permission"].includes(node.status))) return "active";
  return snapshot.run.status;
}
export function treeOrder(nodes: NodeRecord[]): NodeRecord[] {
  const children = new Map<string | null, NodeRecord[]>();
  for (const node of nodes) children.set(node.parentNodeId, [...(children.get(node.parentNodeId) ?? []), node]);
  children.forEach(list => list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
  const visited = new Set<string>();
  const result: NodeRecord[] = [];
  function walk(node: NodeRecord): void {
    if (visited.has(node.id)) return;
    visited.add(node.id); result.push(node);
    children.get(node.id)?.forEach(walk);
  }
  children.get(null)?.forEach(walk);
  nodes.forEach(walk); // Keep disconnected/interrupted records visible, guard cycles.
  return result;
}
export function summarize(snapshot: RunSnapshot): RunSummary {
  const { run, nodes } = snapshot;
  return { ...run, status: displayRunStatus(snapshot), rootAgentId: nodes.find(node => node.id === run.rootNodeId)?.agentId ?? "unknown", agents: [...new Set(nodes.map(node => node.agentId))], nodeCount: nodes.length, activeNodeCount: nodes.filter(node => !terminal(node.status) && node.status !== "idle").length, pendingPermissions: snapshot.permissions.filter(permission => permission.status === "pending").length + (snapshot.run.team?.proposals?.filter(proposal => proposal.status === "pending").length ?? 0) };
}
export const tokens = (value: number): string => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}k` : String(Math.round(value));
export const cost = (value: number): string => `$${value.toFixed(value < 1 ? 3 : 2)}`;
export function duration(start: string | number, end: string | number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((Number(new Date(end)) - Number(new Date(start))) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
export const clock = (time: string): string => new Date(time).toLocaleTimeString("zh-CN", { hour12: false });
