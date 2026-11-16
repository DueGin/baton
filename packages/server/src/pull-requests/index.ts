import type { ListPullRequestsResponse, PullRequestFeedbackRequest, PullRequestRecord, RunEventEnvelope, SettingsResponse } from "@baton/protocol";
import type { Store } from "../store/index.js";
import type { Settings } from "../settings/index.js";
import type { Notifier } from "../notifications/index.js";
import { noticePrompt } from "../kernel/prompts.js";
import { commandEnv, CREATES_PR, executable, GITHUB_FIELDS, normalizeGithub, object, parsePullRequest, pullRequestUrls, runForge, type ForgeRunner, type ParsedPullRequest } from "./forge.js";

export interface PullRequestOptions {
  runner?: ForgeRunner;
  resolveExecutable?: (name: string, env: NodeJS.ProcessEnv, configured?: string) => Promise<string | undefined>;
  clock?: () => number;
  /** Disable timer/initial polling in deterministic tests. Explicit refresh still works. */
  autoPoll?: boolean;
}
interface PollState { nextAt: number; failures: number; terminalConfirmed?: boolean }
interface Hooks { queue(nodeId: string, text: string): Promise<void>; notify: Notifier }
const priority = { mentioned: 0, manual: 1, artifact: 2, created: 3 };
export class PullRequests {
  private readonly runner: ForgeRunner;
  private readonly resolveExecutable: NonNullable<PullRequestOptions["resolveExecutable"]>;
  private readonly clock: () => number;
  private readonly unsubscribe: () => void;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private controller = new AbortController();
  private discovery: Promise<void> = Promise.resolve();
  private flights = new Map<string, Promise<PullRequestRecord>>();
  private feedbackFlights = new Map<string, Promise<PullRequestRecord>>();
  private detection?: { key: string; until: number; result: Promise<NonNullable<SettingsResponse["github"]>> };
  constructor(readonly store: Store, readonly settings: Settings, readonly hooks: Hooks, readonly options: PullRequestOptions = {}) {
    this.runner = options.runner ?? runForge; this.resolveExecutable = options.resolveExecutable ?? executable; this.clock = options.clock ?? Date.now;
    store.db.exec("CREATE TABLE IF NOT EXISTS pr_poll (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.unsubscribe = store.subscribe((event) => {
      if (event.type === "item" || event.type === "delegation.created" || event.type === "delegation.updated") this.discovery = this.discovery.then(() => this.discover(event)).catch((error: unknown) => {
        if (!this.stopped) store.append(event.runId, { type: "log", level: "warn", message: `PR discovery: ${error instanceof Error ? error.message : String(error)}` });
      });
    });
    if (options.autoPoll !== false) { this.timer = setInterval(() => { void this.pollDue(); }, 1000); this.timer.unref(); void this.pollDue(); }
  }
  async settled(): Promise<void> { await this.discovery; }
  private async discover(event: RunEventEnvelope): Promise<void> {
    if (this.stopped) return;
    if (event.type === "item") {
      const item = event.item;
      let text: string | undefined, source: PullRequestRecord["source"] = "mentioned", toolSpanId: string | undefined;
      if (item.type === "assistant_message") {
        const row = this.store.items(event.nodeId).find((r) => r.seq === event.itemSeq); text = row?.item.type === "assistant_message" ? row.item.text : item.text;
      } else if (item.type === "tool_call") {
        const detail = item.detail;
        if (detail.type === "baton" && detail.tool === "report_result") {
          const artifacts = object(detail.input).artifacts;
          for (const value of Array.isArray(artifacts) ? artifacts : []) {
            const artifact = object(value), parsed = artifact.kind === "url" && typeof artifact.value === "string" ? parsePullRequest(artifact.value) : undefined;
            if (parsed) this.register(event.runId, parsed, "artifact", event.nodeId);
          }
        }
        text = detail.type === "shell" ? detail.output : detail.type === "unknown" ? JSON.stringify(detail.output) : detail.type === "fetch" ? detail.result : detail.type === "plain_text" ? detail.text : detail.type === "read" || detail.type === "search" ? detail.content : undefined;
        if (detail.type === "shell" && CREATES_PR.test(detail.command)) source = "created";
        if (source === "created") toolSpanId = `${event.nodeId}:${item.callId}`;
      }
      if (text && (source !== "mentioned" || (await this.settings.github()).trackMentioned !== false)) {
        for (const parsed of pullRequestUrls(text)) this.register(event.runId, parsed, source, source === "created" ? event.nodeId : undefined, toolSpanId);
      }
    } else if (event.type === "delegation.created" || event.type === "delegation.updated") {
      const d = event.type === "delegation.created" ? event.delegation : this.store.delegation(event.delegationId);
      for (const artifact of d.result?.artifacts ?? []) if (artifact.kind === "url") {
        const parsed = parsePullRequest(artifact.value); if (parsed) this.register(event.runId, parsed, "artifact", d.toNodeId);
      }
    }
  }
  link(runId: string, url: string, nodeId?: string): PullRequestRecord {
    if (typeof url !== "string") throw new Error("A PR URL is required");
    const parsed = parsePullRequest(url); if (!parsed) throw new Error("Invalid pull/merge request URL");
    if (nodeId !== undefined && (typeof nodeId !== "string" || this.store.node(nodeId).runId !== runId)) throw new Error("PR node must belong to this run");
    return this.register(runId, parsed, "manual", nodeId, undefined, true);
  }
  private register(runId: string, parsed: ParsedPullRequest, source: PullRequestRecord["source"], nodeId?: string, toolSpanId?: string, relink = false): PullRequestRecord {
    const run = this.store.snapshot(runId).run, id = `${runId}:${parsed.forge}:${parsed.repo}#${parsed.number}`;
    const previous = this.store.pullRequests().find((p) => p.id === id);
    if (previous?.unlinkedAt && !relink) return previous;
    let next: PullRequestRecord;
    if (previous) {
      if (priority[source] > priority[previous.source]) next = { ...previous, source, nodeId, toolSpanId };
      else next = { ...previous, ...(source === previous.source && !previous.nodeId && nodeId ? { nodeId, toolSpanId } : {}) };
      if (relink) next.unlinkedAt = undefined;
    } else next = { ...parsed, id, runId, projectId: run.projectId, nodeId, toolSpanId, source, state: "unknown", checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0, failedChecks: [] }, createdAt: new Date(this.clock()).toISOString() };
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.store.append(runId, { type: "pr", pr: next });
    if ((!previous || previous.unlinkedAt) && this.options.autoPoll !== false) void this.refresh(id);
    return this.store.pullRequest(id);
  }
  list(projectId?: string, state = "open"): ListPullRequestsResponse {
    if (!["open", "all"].includes(state)) throw new Error("state must be open or all");
    return this.store.pullRequests().filter((p) => !p.unlinkedAt && (!projectId || p.projectId === projectId) && (state === "all" || ["open", "draft"].includes(p.state))).map((p) => ({ ...p, runTitle: this.store.snapshot(p.runId).run.title }));
  }
  unlink(id: string): PullRequestRecord {
    const p = this.store.pullRequest(id); if (!p.unlinkedAt) this.store.append(p.runId, { type: "pr", pr: { ...p, unlinkedAt: new Date(this.clock()).toISOString() } });
    return this.store.pullRequest(id);
  }
  private state(id: string): PollState { const row = this.store.db.prepare("SELECT data FROM pr_poll WHERE id=?").get(id); return row ? JSON.parse(String(row.data)) as PollState : { nextAt: 0, failures: 0 }; }
  private schedule(id: string, state: PollState): void { this.store.db.prepare("INSERT INTO pr_poll VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(id, JSON.stringify(state)); }
  async pollDue(): Promise<void> {
    if (this.stopped) return;
    await Promise.all(this.store.pullRequests().filter((p) => !p.unlinkedAt && p.forge !== "other" && !this.state(p.id).terminalConfirmed && this.state(p.id).nextAt <= this.clock()).map((p) => this.refresh(p.id)));
  }
  refresh(id: string): Promise<PullRequestRecord> {
    const existing = this.flights.get(id); if (existing) return existing;
    const p = this.store.pullRequest(id); if (p.unlinkedAt) return Promise.reject(new Error("PR is unlinked"));
    const flight = this.fetch(p).finally(() => this.flights.delete(id)); this.flights.set(id, flight); return flight;
  }
  private async command(args: string[], name = "gh"): Promise<string> {
    const settings = await this.settings.github(), env = commandEnv(settings), file = await this.resolveExecutable(name, env, name === "gh" ? settings.ghPath : undefined);
    if (!file) throw new Error(`${name} not found; configure github.ghPath or install ${name}`);
    return this.runner({ file, args, env, timeout: 15000, signal: this.controller.signal });
  }
  private async fetch(pr: PullRequestRecord): Promise<PullRequestRecord> {
    if (pr.forge === "other") return pr;
    const previousPoll = this.state(pr.id);
    let fields: Partial<PullRequestRecord>, failed = false;
    try {
      if (pr.forge === "gitlab") throw new Error("GitLab status polling is unavailable; tracked as unknown");
      fields = normalizeGithub(JSON.parse(await this.command(["pr", "view", pr.url, "--json", GITHUB_FIELDS])) as unknown);
    } catch (error) { failed = true; fields = { error: error instanceof Error ? error.message : String(error) }; }
    if (this.stopped) return pr;
    const current = this.store.pullRequest(pr.id); if (current.unlinkedAt) return current;
    const next = { ...current, ...fields }, comparable = (p: PullRequestRecord): string => { const { lastCheckedAt: _checked, ...rest } = p; return JSON.stringify(rest); };
    const heartbeat = !failed && (!current.lastCheckedAt || this.clock() - Date.parse(current.lastCheckedAt) >= 300000);
    if (comparable(next) !== comparable(current) || heartbeat) this.store.append(pr.runId, { type: "pr", pr: { ...next, lastCheckedAt: new Date(this.clock()).toISOString() } });
    const updated = this.store.pullRequest(pr.id), terminal = ["merged", "closed"].includes(updated.state);
    const delay = failed ? Math.min(600000, 30000 * 2 ** Math.min(previousPoll.failures, 5)) : this.clock() - Date.parse(updated.createdAt) < 300000 ? 30000 : updated.state === "draft" ? 120000 : 60000;
    this.schedule(pr.id, { nextAt: this.clock() + delay, failures: failed ? previousPoll.failures + 1 : 0, terminalConfirmed: !failed && terminal && ["merged", "closed"].includes(current.state) });
    if (!failed) await this.transition(current, updated);
    return this.store.pullRequest(pr.id);
  }
  private async transition(previous: PullRequestRecord, next: PullRequestRecord): Promise<void> {
    const run = this.store.snapshot(next.runId).run, attention = previous.checks.state !== "failure" && next.checks.state === "failure" || previous.reviewDecision !== "changes_requested" && next.reviewDecision === "changes_requested";
    const terminal = previous.state !== next.state && ["merged", "closed"].includes(next.state);
    if (terminal || attention && run.policy.prFeedback !== "off") {
      await Promise.resolve(this.hooks.notify({ runId: run.id, title: `baton · ${run.title}`, body: `PR ${next.repo}#${next.number}: ${terminal ? next.state : next.checks.state === "failure" ? "CI checks failed" : "changes requested"}.` })).catch(() => {});
    }
    if (attention && run.policy.prFeedback === "auto" && (!next.lastFeedbackAt || this.clock() - Date.parse(next.lastFeedbackAt) >= 600000)) {
      try { await this.feedback(next.id, { include: ["checks", "reviews"] }); }
      catch (error) { if (!this.stopped) this.store.append(run.id, { type: "log", level: "warn", message: `PR feedback failed: ${error instanceof Error ? error.message : String(error)}` }); }
    }
  }
  feedback(id: string, input: PullRequestFeedbackRequest): Promise<PullRequestRecord> {
    const current = this.feedbackFlights.get(id); if (current) return current;
    const flight = this.sendFeedback(id, input).finally(() => this.feedbackFlights.delete(id)); this.feedbackFlights.set(id, flight); return flight;
  }
  private async sendFeedback(id: string, input: PullRequestFeedbackRequest): Promise<PullRequestRecord> {
    const pr = this.store.pullRequest(id); if (pr.unlinkedAt) throw new Error("PR is unlinked");
    if (!Array.isArray(input.include) || !input.include.length || !input.include.every((s) => s === "checks" || s === "reviews") || input.note !== undefined && typeof input.note !== "string") throw new Error("include must contain checks and/or reviews; note must be text");
    const run = this.store.snapshot(pr.runId).run, nodeId = input.nodeId ?? pr.nodeId ?? run.rootNodeId;
    if (this.store.node(nodeId).runId !== pr.runId) throw new Error("Feedback node must belong to the PR run");
    const lines = [`Pull request feedback: ${pr.repo}#${pr.number}${pr.title ? ` — ${pr.title}` : ""}`, pr.url];
    if (input.include.includes("checks")) {
      lines.push("", `Checks: ${pr.checks.state} (${pr.checks.passed} passed, ${pr.checks.failed} failed, ${pr.checks.pending} pending).`, ...pr.checks.failedChecks.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ""}`));
      const runIds = [...new Set(pr.checks.failedChecks.flatMap((c) => {
        try { const url = new URL(c.url ?? ""); const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/.exec(url.pathname); return url.hostname === "github.com" && match && match[1]?.toLowerCase() === pr.repo.toLowerCase() ? [match[2]!] : []; } catch { return []; }
      }))];
      for (const runId of runIds.slice(0, 10)) {
        try { const log = await this.command(["run", "view", runId, "--repo", pr.repo, "--log-failed"]); lines.push("", `Failed log (run ${runId}, last 80 lines):`, log.trimEnd().split(/\r?\n/).slice(-80).join("\n").slice(-24000)); }
        catch (error) { lines.push(`Failed log unavailable: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    if (input.include.includes("reviews") && pr.forge === "github") {
      try {
        const review = object(JSON.parse(await this.command(["pr", "view", pr.url, "--json", "reviews,comments"])) as unknown);
        lines.push("", `Review decision: ${pr.reviewDecision ?? "none"}`);
        for (const kind of ["reviews", "comments"] as const) for (const value of (Array.isArray(review[kind]) ? review[kind] : []).slice(-5)) {
          const entry = object(value); lines.push(`- ${kind}: ${String(object(entry.author).login ?? "reviewer")} ${String(entry.state ?? "")} ${String(entry.url ?? "")}\n${String(entry.body ?? "").slice(0, 4000)}`);
        }
      } catch (error) { lines.push(`Reviews unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (this.stopped) throw new Error("Daemon is shutting down");
    if (this.store.pullRequest(id).unlinkedAt) throw new Error("PR was unlinked while collecting feedback");
    if (input.note) lines.push("", `Human note: ${input.note}`);
    lines.push("", "Investigate these checks and review comments, make the necessary fixes, verify them, and report what remains.");
    await this.hooks.queue(nodeId, noticePrompt("system", lines.join("\n")));
    if (!this.stopped) this.store.append(pr.runId, { type: "pr", pr: { ...this.store.pullRequest(id), lastFeedbackAt: new Date(this.clock()).toISOString() } });
    return this.store.pullRequest(id);
  }
  async githubStatus(): Promise<NonNullable<SettingsResponse["github"]>> {
    const settings = await this.settings.github(), key = JSON.stringify(settings);
    if (this.detection?.key === key && this.detection.until > this.clock()) return this.detection.result;
    const result = (async () => {
      const env = commandEnv(settings), file = await this.resolveExecutable("gh", env, settings.ghPath);
      if (!file) return { ...settings, ghFound: false, authenticated: false };
      try { await this.runner({ file, args: ["auth", "status"], env, timeout: 15000, signal: this.controller.signal }); return { ...settings, ghFound: true, authenticated: true }; }
      catch { return { ...settings, ghFound: true, authenticated: false }; }
    })();
    this.detection = { key, until: this.clock() + 300000, result }; return result;
  }
  async close(): Promise<void> { this.stopped = true; this.controller.abort(); this.unsubscribe(); clearInterval(this.timer); await this.discovery; await Promise.allSettled([...this.flights.values(), ...this.feedbackFlights.values()]); }
}

export type { ForgeRunner } from "./forge.js";
