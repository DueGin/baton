import type { ItemRecord, PullRequestRecord, RunSnapshot } from "@baton/protocol";

export type PrTone = "red" | "amber" | "blue" | "green" | "purple" | "neutral";
export const prStateLabels: Record<PullRequestRecord["state"], string> = { open: "Open", draft: "Draft", merged: "已合并", closed: "已关闭", unknown: "状态未知" };
export const prReviewLabels = { approved: "已批准", changes_requested: "请求修改", review_required: "等待评审" };
export const prMergeLabels = { mergeable: "可以合并", conflicting: "有冲突", unknown: "合并状态未知" };
export const prFeedbackLabels = { off: "仅跟踪状态", notify: "提醒我处理", auto: "自动反馈给 agent" };
export const linkedPullRequests = (snapshot: Pick<RunSnapshot, "pullRequests">, nodeId?: string): PullRequestRecord[] => (snapshot.pullRequests ?? []).filter(pr => !pr.unlinkedAt && (!nodeId || pr.nodeId === nodeId));
export const isOpenPr = (pr: PullRequestRecord): boolean => !pr.unlinkedAt && (pr.state === "open" || pr.state === "draft");
export function prTone(prs: PullRequestRecord[]): PrTone {
  const linked = prs.filter(pr => !pr.unlinkedAt);
  if (linked.some(pr => pr.checks.state === "failure" || pr.checks.failed > 0 || pr.mergeable === "conflicting")) return "red";
  if (linked.some(pr => pr.reviewDecision === "changes_requested")) return "amber";
  if (linked.some(pr => pr.checks.state === "pending" || pr.checks.pending > 0)) return "blue";
  if (linked.length && linked.every(pr => pr.checks.state === "success") && !linked.some(pr => pr.state === "merged")) return "green";
  if (linked.some(pr => pr.state === "merged")) return "purple";
  return "neutral";
}
export function prSummary(snapshot: Pick<RunSnapshot, "pullRequests">, nodeId?: string) {
  const entries = linkedPullRequests(snapshot, nodeId);
  return { entries, count: entries.filter(isOpenPr).length, tone: prTone(entries) };
}
export function safePrUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export interface PrChangeNotice { runId: string; prId: string; title: string; body: string; terminal: boolean }
/** Compare snapshots quietly on first load; repeated polling cannot duplicate a transition. */
export class PrChangeTracker {
  private previous: Map<string, PullRequestRecord> | null = null;
  observe(prs: PullRequestRecord[]): PrChangeNotice[] {
    const notices: PrChangeNotice[] = [];
    for (const pr of prs) {
      const old = this.previous?.get(pr.id); if (!old || pr.unlinkedAt) continue;
      const terminal = ["merged", "closed"].includes(pr.state) && pr.state !== old.state;
      const failed = pr.checks.state === "failure" && old.checks.state !== "failure";
      const review = pr.reviewDecision === "changes_requested" && old.reviewDecision !== "changes_requested";
      if (terminal || failed || review) notices.push({ runId: pr.runId, prId: pr.id, title: `PR #${pr.number} · ${terminal ? prStateLabels[pr.state] : failed ? "CI 失败" : "评审要求修改"}`, body: `${pr.repo} · ${pr.title ?? ""}`, terminal });
    }
    this.previous = new Map(prs.map(pr => [pr.id, pr])); return notices;
  }
}
/** Use span identity, not the row position: item replacements and queue delivery can move rows. */
export function pullRequestsAtRow(snapshot: RunSnapshot, row: ItemRecord): PullRequestRecord[] {
  if (row.item.type !== "tool_call") return [];
  const callId = row.item.callId;
  const ids = new Set(snapshot.toolSpans.filter(span => span.nodeId === row.nodeId && span.callId === callId).map(span => span.id));
  return linkedPullRequests(snapshot).filter(pr => pr.source === "created" && pr.nodeId === row.nodeId && pr.toolSpanId && ids.has(pr.toolSpanId));
}
