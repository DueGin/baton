import { execFile } from "node:child_process";
import type { RunEventEnvelope } from "@baton/protocol";
import type { Store } from "../store/index.js";
export interface DesktopNotification { runId: string; title: string; body: string }
export type Notifier = (notification: DesktopNotification) => void | Promise<void>;
function appleString(value: string): string { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", " ").replaceAll("\n", " ")}"`; }
export const desktopNotifier: Notifier = (notification) => new Promise<void>((resolve) => {
  execFile("osascript", ["-e", `display notification ${appleString(notification.body)} with title ${appleString(notification.title)}`], { timeout: 5000 }, () => resolve());
});
/** Debounce one notification per run for a 30-second window; the final message contains all
 * attention/completion events observed in that window. No shell or agent data executes. */
export class Notifications {
  private pending = new Map<string, { timer: NodeJS.Timeout; attention: Set<string>; completed: boolean }>();
  private unsubscribe: () => void;
  private seen = new Set<string>();
  private completed = new Set<string>();
  constructor(readonly store: Store, readonly notify: Notifier, readonly windowMs = 30000) {
    this.unsubscribe = store.subscribe((event) => this.event(event));
  }
  private event(e: RunEventEnvelope): void {
    let key: string | undefined;
    if (e.type === "permission" && e.permission.status === "pending") key = e.permission.id;
    if (e.type === "question" && e.question.status === "pending" && e.question.blocking) key = e.question.id;
    if (e.type === "escalation" && e.escalation.status === "pending") key = e.escalation.id;
    if (e.type === "team.updated" && e.change.kind === "proposed") key = e.change.proposalId;
    let complete = false;
    if (e.type === "run.updated" && e.patch.status === "idle") {
      const s = this.store.snapshot(e.runId);
      complete = s.nodes.find((n) => n.id === s.run.rootNodeId)?.status === "idle" && !s.nodes.some((n) => ["running", "starting", "waiting_permission"].includes(n.status)) && !s.delegations.some((d) => ["queued", "running"].includes(d.status)) && !s.questions.some((q) => q.blocking && q.status === "pending") && !s.run.team?.proposals.some((p) => p.status === "pending");
    }
    if (e.type === "run.updated" && e.patch.status === "active") this.completed.delete(e.runId);
    if (key && this.seen.has(key)) key = undefined;
    if (complete && this.completed.has(e.runId)) complete = false;
    if (key) this.seen.add(key);
    if (complete) this.completed.add(e.runId);
    if (!key && !complete) return;
    let p = this.pending.get(e.runId);
    if (!p) {
      const timer = setTimeout(() => this.flush(e.runId), this.windowMs); timer.unref();
      p = { timer, attention: new Set(), completed: false }; this.pending.set(e.runId, p);
    }
    if (key) p.attention.add(key); p.completed ||= complete;
  }
  private flush(runId: string): void {
    const p = this.pending.get(runId); if (!p) return; this.pending.delete(runId);
    const run = this.store.snapshot(runId).run;
    const pending = new Set(this.store.inbox().filter((i) => i.runId === runId).map((i) => i.kind === "permission" ? i.permission.id : i.kind === "proposal" ? i.proposal.id : i.kind === "question" ? i.question.id : i.escalation.id));
    const count = [...p.attention].filter((id) => pending.has(id)).length;
    if (!count && !p.completed) return;
    const body = [count ? `${count} item(s) need your attention.` : "", p.completed ? "Run completed its work." : ""].filter(Boolean).join(" ");
    void Promise.resolve().then(() => this.notify({ runId, title: `baton · ${run.title}`, body })).catch(() => {});
  }
  close(): void { this.unsubscribe(); for (const p of this.pending.values()) clearTimeout(p.timer); this.pending.clear(); }
}
