import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { NotificationEvent, RunEventEnvelope } from "@baton/protocol";
import type { Store } from "../store/index.js";
import { backgroundCount } from "../store/index.js";
export interface DesktopNotification { runId: string; title: string; body: string; kind?: NotificationEvent["kind"]; route?: string }
export type Notifier = (notification: DesktopNotification) => void | Promise<void>;
export type NotificationMode = "client" | "os" | "off";
export function notificationMode(config: Record<string, unknown>, override?: NotificationMode, platform: NodeJS.Platform = process.platform): NotificationMode {
  if (override) return override;
  const settings = config.notifications;
  if (settings && typeof settings === "object") {
    if ("mode" in settings && ["client", "os", "off"].includes(String(settings.mode))) return settings.mode as NotificationMode;
    if ("desktop" in settings && settings.desktop === false) return "off";
  }
  return platform === "darwin" ? "os" : "client";
}
/** Single fan-out shared by pending/completion notifications and PR transitions. */
export class NotificationHub {
  private listeners = new Set<(event: NotificationEvent) => void>();
  constructor(readonly mode: NotificationMode, readonly os: Notifier, readonly platform: NodeJS.Platform = process.platform) {}
  readonly notify: Notifier = async (notification) => {
    const event: NotificationEvent = { ...notification, id: randomUUID(), kind: notification.kind ?? "other", ts: new Date().toISOString(), route: notification.route ?? `/runs/${notification.runId}` };
    for (const listener of this.listeners) { try { listener(event); } catch { /* a disconnected client cannot block notification delivery */ } }
    if (this.mode === "os" && this.platform === "darwin") await this.os(notification);
  };
  subscribe(listener: (event: NotificationEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void { this.listeners.clear(); }
}
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
    const background = backgroundCount(this.store.snapshot(runId).backgroundProcesses);
    const body = [count ? `${count} item(s) need your attention.` : "", p.completed ? "Run completed its work." : "", p.completed && background ? `仍有 ${background} 个后台进程在运行` : ""].filter(Boolean).join(" ");
    void Promise.resolve().then(() => this.notify({ runId, title: `baton · ${run.title}`, body, kind: count ? "pending" : "run_completed", route: count ? "/inbox" : `/runs/${runId}` })).catch(() => {});
  }
  close(): void { this.unsubscribe(); for (const p of this.pending.values()) clearTimeout(p.timer); this.pending.clear(); }
}
