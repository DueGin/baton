import type { InboxItem, RunSummary } from "@baton/protocol";
import { inboxId, inboxLabels } from "./inbox.js";

export interface BrowserNotice { runId: string; title: string; body: string }
export class NotificationTracker {
  private inbox: Set<string> | null = null;
  private runs = new Map<string, boolean>();
  private blockers = new Set<string>();
  private last = new Map<string, number>();
  private pending = new Map<string, BrowserNotice & { completion?: boolean }>();
  private queue(notice: BrowserNotice & { completion?: boolean }): void { this.pending.set(notice.runId, notice); }
  observeInbox(items: InboxItem[], hidden: boolean): void {
    const next = new Set(items.map(inboxId));
    if (this.inbox && hidden) for (const item of items) if (!this.inbox.has(inboxId(item)) && (item.kind !== "question" || item.question.blocking)) this.queue({ runId: item.runId, title: `${item.runTitle} · 有新的待处理事项`, body: inboxLabels[item.kind] });
    this.inbox = next;
    this.blockers = new Set(items.filter(item => item.kind === "proposal" || item.kind === "question" && item.question.blocking).map(item => item.runId));
    const attention = new Set(items.filter(item => item.kind !== "question" || item.question.blocking).map(item => item.runId));
    for (const [id, notice] of this.pending) if (!notice.completion && !attention.has(id)) this.pending.delete(id);
  }
  observeRuns(runs: RunSummary[], hidden: boolean): void {
    for (const run of runs) {
      const done = (run.status === "idle" || run.status === "completed") && run.activeNodeCount === 0 && !this.blockers.has(run.id);
      if (hidden && this.runs.get(run.id) === false && done) this.queue({ runId: run.id, title: `${run.title} · Run 完成`, body: "根节点已空闲，所有节点已结束当前工作。", completion: true });
      this.runs.set(run.id, done);
    }
  }
  drain(now: number, hidden: boolean): BrowserNotice[] {
    if (!hidden) { this.pending.clear(); return []; }
    const notices: BrowserNotice[] = [];
    for (const [id, notice] of this.pending) if (now - (this.last.get(id) ?? -Infinity) >= 30000) { notices.push(notice); this.last.set(id, now); this.pending.delete(id); }
    return notices;
  }
}
