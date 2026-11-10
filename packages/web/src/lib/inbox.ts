import type { InboxItem, PermissionRecord, RunSnapshot } from "@baton/protocol";

export const inboxLabels = { permission: "权限请求", proposal: "名单确认", question: "Agent 提问", escalation: "需要介入" };
export const resolutionLabels = { human: "人工", policy: "自动策略", parent: "父节点", rule: "审批规则" };
export const escalationLabels = { stall: "停滞", round_limit: "轮次上限" };
export function inboxId(item: InboxItem): string {
  return `${item.kind}:${item.kind === "permission" ? item.permission.id : item.kind === "proposal" ? item.proposal.id : item.kind === "question" ? item.question.id : item.escalation.id}`;
}
export function inboxTime(item: InboxItem): string {
  return item.kind === "permission" ? item.permission.requestedAt : item.kind === "proposal" ? item.proposal.proposedAt : item.kind === "question" ? item.question.askedAt : item.escalation.createdAt;
}
export const inboxNode = (item: InboxItem): string => item.kind === "permission" ? item.permission.nodeId : item.kind === "proposal" ? item.proposal.nodeId : item.kind === "question" ? item.question.nodeId : item.escalation.nodeId;
export function sortInbox(items: InboxItem[]): InboxItem[] { return [...items].sort((a, b) => inboxTime(a).localeCompare(inboxTime(b)) || inboxId(a).localeCompare(inboxId(b))); }
export function groupInbox(items: InboxItem[]): Array<{ runId: string; title: string; items: InboxItem[] }> {
  const groups = new Map<string, { runId: string; title: string; items: InboxItem[] }>();
  for (const item of sortInbox(items)) {
    let group = groups.get(item.runId);
    if (!group) { group = { runId: item.runId, title: item.runTitle, items: [] }; groups.set(item.runId, group); }
    group.items.push(item);
  }
  return [...groups.values()];
}
export function snapshotInbox(snapshot: RunSnapshot): InboxItem[] {
  const { id: runId, title: runTitle } = snapshot.run;
  return sortInbox([
    ...snapshot.permissions.filter(row => row.status === "pending").map(permission => ({ kind: "permission" as const, runId, runTitle, permission })),
    ...(snapshot.run.team?.proposals ?? []).filter(row => row.status === "pending").map(proposal => ({ kind: "proposal" as const, runId, runTitle, proposal })),
    ...(snapshot.questions ?? []).filter(row => row.status === "pending").map(question => ({ kind: "question" as const, runId, runTitle, question })),
    ...(snapshot.escalations ?? []).filter(row => row.status === "pending").map(escalation => ({ kind: "escalation" as const, runId, runTitle, escalation })),
  ]);
}
function normalizePath(path: string): string[] {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts;
}
/** Start with the exact command or relative file path; users can deliberately broaden it. */
export function permissionPattern(permission: PermissionRecord, cwd?: string): string {
  const detail = permission.request.detail;
  const command = detail?.type === "shell" ? detail.command : permission.request.input?.command;
  if (typeof command === "string") return command.trim().replace(/\s+/g, " ");
  if (detail && "filePath" in detail) {
    if (!cwd) return detail.filePath.replace(/^\.\//, "");
    const prefix = normalizePath(cwd); const path = normalizePath(detail.filePath.startsWith("/") ? detail.filePath : `${cwd}/${detail.filePath}`);
    let common = 0; while (common < prefix.length && prefix[common] === path[common]) common++;
    return [...prefix.slice(common).map(() => ".."), ...path.slice(common)].join("/");
  }
  return "";
}
