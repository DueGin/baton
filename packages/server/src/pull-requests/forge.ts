import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { GithubSettings, PullRequestRecord } from "@baton/protocol";

export interface ForgeCommand { file: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal }
export type ForgeRunner = (command: ForgeCommand) => Promise<string>;
export const runForge: ForgeRunner = ({ file, args, env, timeout, signal }) => new Promise((resolve, reject) => {
  execFile(file, args, { env, timeout, signal, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr.trim() || error.message).slice(0, 2000))); else resolve(stdout);
  });
});
export async function executable(name: string, env: NodeJS.ProcessEnv, configured?: string): Promise<string | undefined> {
  const candidates = configured ? [configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured] : [...(env.PATH ?? "").split(":").filter(Boolean).map((p) => join(p, name)), join(homedir(), ".local", "bin", name)];
  for (const file of candidates) {
    if (!isAbsolute(file)) continue;
    try { await access(file, constants.X_OK); return file; } catch { /* try next candidate */ }
  }
  return undefined;
}
export interface ParsedPullRequest { url: string; forge: PullRequestRecord["forge"]; repo: string; number: number }
export function parsePullRequest(value: string): ParsedPullRequest | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  let forge: ParsedPullRequest["forge"] = "other", repo: string, number: number, canonical: string;
  const github = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(path);
  const gitlab = /^\/(.+)\/-\/merge_requests\/(\d+)(?:\/.*)?$/.exec(path);
  const other = /^\/(.+)\/(?:pulls?|pull-requests|merge_requests|merge-requests)\/(\d+)(?:\/.*)?$/.exec(path);
  if (url.hostname.toLowerCase() === "github.com" && github) {
    forge = "github"; repo = `${github[1]}/${github[2]}`.toLowerCase(); number = Number(github[3]); canonical = `https://github.com/${repo}/pull/${number}`;
  } else if (gitlab) {
    forge = "gitlab"; repo = `${url.host}/${gitlab[1]}`; number = Number(gitlab[2]); canonical = `${url.origin}/${gitlab[1]}/-/merge_requests/${number}`;
  } else if (other) {
    repo = `${url.host}/${other[1]}`; number = Number(other[2]); canonical = `${url.origin}${path.replace(/\/(\d+)\/.*$/, "/$1")}`;
  } else return undefined;
  return Number.isSafeInteger(number) && number > 0 ? { forge, repo, number, url: canonical } : undefined;
}
export function pullRequestUrls(text: string): ParsedPullRequest[] {
  const found = new Map<string, ParsedPullRequest>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\])}]+/g)) {
    const parsed = parsePullRequest(match[0].replace(/[.,;:!?]+$/, ""));
    if (parsed) found.set(parsed.url, parsed);
  }
  return [...found.values()];
}
export const CREATES_PR = /(?:^|[\s/;&|])(?:gh\s+pr\s+(?:create|new)|glab\s+mr\s+create|hub\s+pull-request)(?=\s|$)/;
export const GITHUB_FIELDS = "number,title,state,isDraft,url,headRefName,baseRefName,author,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,comments,updatedAt,mergedAt,closedAt";
export function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function count(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
export function normalizeGithub(value: unknown): Partial<PullRequestRecord> {
  const p = object(value);
  if (!["OPEN", "MERGED", "CLOSED"].includes(String(p.state).toUpperCase())) throw new Error("Invalid gh response: missing PR state");
  const checks: PullRequestRecord["checks"] = { state: "none", total: 0, passed: 0, failed: 0, pending: 0, failedChecks: [] };
  for (const raw of Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : []) {
    const c = object(raw), status = String(c.conclusion ?? (c.context !== undefined ? c.state : "") ?? "").toUpperCase(); checks.total++;
    if (["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(status)) {
      checks.failed++;
      if (checks.failedChecks.length < 10) checks.failedChecks.push({ name: string(c.name) ?? string(c.context) ?? "Unnamed check", ...(string(c.detailsUrl ?? c.targetUrl) ? { url: string(c.detailsUrl ?? c.targetUrl) } : {}) });
    } else if (["SUCCESS", "PASSED"].includes(status)) checks.passed++;
    else if (!["NEUTRAL", "SKIPPED"].includes(status)) checks.pending++;
  }
  checks.state = checks.failed ? "failure" : checks.pending ? "pending" : checks.passed ? "success" : checks.total ? "neutral" : "none";
  const state: PullRequestRecord["state"] = String(p.state).toUpperCase() === "OPEN" ? p.isDraft ? "draft" : "open" : String(p.state).toLowerCase() as "merged" | "closed";
  const review = typeof p.reviewDecision === "string" ? p.reviewDecision.toLowerCase() : null, mergeable = String(p.mergeable ?? "unknown").toLowerCase();
  return { state, title: string(p.title), headRef: string(p.headRefName), baseRef: string(p.baseRefName), author: string(object(p.author).login), checks,
    reviewDecision: ["approved", "changes_requested", "review_required"].includes(review ?? "") ? review as PullRequestRecord["reviewDecision"] : null,
    mergeable: ["mergeable", "conflicting"].includes(mergeable) ? mergeable as PullRequestRecord["mergeable"] : "unknown",
    additions: count(p.additions), deletions: count(p.deletions), changedFiles: count(p.changedFiles), commentCount: Array.isArray(p.comments) ? p.comments.length : undefined,
    remoteUpdatedAt: string(p.updatedAt), mergedAt: string(p.mergedAt), closedAt: string(p.closedAt), error: undefined };
}
export function commandEnv(settings: GithubSettings): NodeJS.ProcessEnv { return { ...process.env, ...settings.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" }; }
