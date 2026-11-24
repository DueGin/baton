/** REST request/response bodies (DESIGN §7). */
import type { AttachmentRef, PermissionResponse } from "./timeline.js";
import type { AgentEntry, BackgroundProcess, PullRequestRecord, ProjectRecord, ProjectSummary, DelegationRecord, InboxItem, ItemRecord, NodeRecord, PermissionRule, RunPolicy, RunSnapshot, RunSummary, TeamCandidateSpec, TeamMemberSpec, TeamPreset } from "./records.js";

export interface CreateRunRequest {
  /** Root agent. Optional when `teamPresetId` is given (the preset's lead is used). */
  agent?: string;
  model?: string;
  modeId?: string;
  thinking?: string;
  /** Project the run belongs to (required). */
  projectId: string;
  /**
   * Working directory: defaults to the project path; when given it must be the project path or a
   * directory inside it (absolute path).
   */
  cwd?: string;
  prompt: string;
  title?: string;
  policy?: Partial<RunPolicy>;
  /** Use a saved team (sets policy.mode = "preset"). */
  teamPresetId?: string;
  /** Dynamic mode only: members the human wants on the team from the start (the lead may add more). */
  team?: TeamMemberSpec[];
  /**
   * Candidates the lead may hire for this run (dynamic or preset mode; added after the preset's own).
   * No role: the lead names one when it hires (delegate with `candidate` + `role`), without roster approval.
   */
  candidates?: TeamCandidateSpec[];
}

export interface PatchRunRequest {
  title?: string;
  /** true = archive, false = unarchive (DESIGN §4.9). Archiving a run whose status is "active" returns 409. */
  archived?: boolean;
  policy?: Partial<Pick<RunPolicy, "autoApprove" | "maxDepth" | "maxActiveChildren" | "budget" | "teamApproval" | "maxTeamSize" | "stallMinutes" | "maxRoundsPerDelegation" | "leadReview">>;
}

/**
 * PATCH /api/nodes/:nodeId — switch one session's model, mode (permission mode) or thinking level
 * (DESIGN §8.3 "会话配置"). Omitted fields stay as they are; `null` resets the field to the agent's
 * default. Values are validated against the node agent's catalog (unknown model / mode / thinking
 * level → 400). Rejected (409) for terminal nodes (completed is allowed: a follow-up reopens it).
 *
 * The kernel stores the new values on the node right away (`node.updated`; when a field is cleared
 * it re-emits the whole record as `node.created`, see DESIGN §6 "清空字段"). An idle node's provider
 * session is closed and is resumed from its persistence handle with the new spec on the next turn;
 * a running node keeps its current turn and switches when that turn ends.
 */
export interface UpdateNodeConfigRequest {
  model?: string | null;
  modeId?: string | null;
  thinking?: string | null;
}

export interface UpdateNodeConfigResponse {
  node: NodeRecord;
  /** "next_turn": the node was busy; the change applies when its current turn ends. */
  applied: "now" | "next_turn";
}

/**
 * How a human message reaches a node that is busy (DESIGN §8.3 "发送模式"). An idle node always
 * starts a new turn, whatever the mode.
 * - "queue" (default): wait until the running turn ends.
 * - "steer": inject into the running turn (falls back to "queue" and reports `steerUnsupported`
 *   when the provider cannot steer).
 * - "interrupt": interrupt the running turn, then start a new turn with this message.
 */
export type SendMode = "queue" | "steer" | "interrupt";

export interface SendMessageRequest {
  text: string;
  /** Client-generated id echoed on the stored user_message item (optimistic UI reconciliation). */
  clientId?: string;
  /** Default "queue". */
  mode?: SendMode;
}

/** POST /api/nodes/:nodeId/messages/:itemSeq/deliver — escalate a queued (or steered) human message. */
export interface DeliverMessageRequest {
  /** "steer": only for a queued message. "interrupt": for a queued or steered message. */
  mode: "steer" | "interrupt";
}

/** 202 response of POST /api/nodes/:nodeId/messages and …/deliver. */
export interface SendMessageResponse {
  accepted: true;
  delivery: "turn" | "steered" | "queued";
  /** Set when mode "steer" was asked for but the provider cannot steer (the message stays queued). */
  steerUnsupported?: boolean;
  /** Node-local seq of the user_message item that represents this message. */
  itemSeq: number;
}

/**
 * PUT /api/nodes/:nodeId/queue — reorder the node's queued human messages. `order` must be a
 * permutation of the itemSeqs currently queued (409 when the queue changed meanwhile).
 */
export interface ReorderQueueRequest {
  order: number[];
}
export interface ReorderQueueResponse {
  order: number[];
}

/** PATCH /api/nodes/:nodeId/messages/:itemSeq — edit the text of a still-queued human message (409 otherwise). */
export interface EditMessageRequest {
  text: string;
}

/** DELETE /api/nodes/:nodeId/messages/:itemSeq — retract a still-queued human message (delivery → "retracted"). */

export interface PermissionDecision {
  response: PermissionResponse;
  /** "Always": also save a rule with the same decision. */
  remember?: { scope: "global" | "run"; pattern?: string; agentOnly?: boolean };
}

export interface ApiError {
  error: { code: string; message: string };
}

export type GetAgentsResponse = AgentEntry[];
export type ListRunsResponse = RunSummary[];
export type GetRunResponse = RunSnapshot;
export type GetDelegationResponse = DelegationRecord;
export interface GetItemsResponse {
  items: ItemRecord[];
  /** Highest item seq returned (or the `after` value when none). */
  lastSeq: number;
}

/** Server info returned by GET /api/info (no auth needed beyond the token). */
export interface ServerInfo {
  name: "baton";
  version: string;
  home: string;
  port: number;
  defaults: RunPolicy;
  /** Server platform ("darwin" | "win32" | "linux"). */
  platform?: string;
  /** Capability flags; absent = unknown. */
  features?: {
    /** Background process registry is supported on this platform (false on win32). */
    backgroundProcesses?: boolean;
    /** GET /api/notifications/events exists. */
    notificationStream?: boolean;
  };
}

// ───────────────────────────── team ─────────────────────────────

/** POST /api/runs/:runId/team/members — the human adds a member. */
export interface AddMemberRequest extends TeamMemberSpec {
  reason?: string;
}

/** POST /api/runs/:runId/team/members/:memberId/replace — the human swaps who fills a role. */
export interface ReplaceMemberRequest {
  agentId: string;
  model?: string;
  modeId?: string;
  thinking?: string;
  responsibilities?: string;
  reason?: string;
  /** Also reassign the old member's unfinished delegations to the new member (default true). */
  reassignActive?: boolean;
}

/** POST /api/delegations/:id/reassign — give one task to another member or agent. */
export interface ReassignRequest {
  /** Target member (by id). Either memberId or agentId is required. */
  memberId?: string;
  agentId?: string;
  model?: string;
  modeId?: string;
  thinking?: string;
  reason?: string;
}

export type TeamPresetInput = Omit<TeamPreset, "id" | "createdAt" | "updatedAt">;
export type ListTeamPresetsResponse = TeamPreset[];

/** POST /api/runs/:runId/team/save-preset — save the run's active roster (and root as lead). */
export interface SaveTeamPresetRequest {
  name: string;
  description?: string;
}

/** POST /api/runs/:runId/team/proposals/:proposalId/approve — optionally with the human's edits. */
export interface ApproveTeamProposalRequest {
  /** formation / addition: the roster to apply instead of the proposed one (roles may be added, dropped or changed). */
  members?: TeamMemberSpec[];
  /** replacement: the member spec to apply instead of the proposed one. */
  replacement?: TeamMemberSpec;
  note?: string;
}

/** POST /api/runs/:runId/team/proposals/:proposalId/reject */
export interface RejectTeamProposalRequest {
  feedback: string;
}

// ───────────────────────────── inbox ─────────────────────────────

/** GET /api/inbox — every pending item across runs, oldest first. */
export type GetInboxResponse = InboxItem[];

/** POST /api/questions/:id/answer */
export interface AnswerQuestionRequest {
  /** Free-text answer (single-prompt cards); also used as a summary for structured answers. */
  answer?: string;
  /** Structured answers for multi-prompt / option cards: prompt id → labels and/or free text. */
  answers?: Record<string, string[]>;
}

/**
 * POST /api/questions/:id/decline — no body. The human closes the card without answering: the
 * question becomes "canceled" with `declinedAt`, and the asking agent is told so (a native question
 * is denied with that message, a blocking ask_human returns status "declined", an async one gets a
 * notice) so it can continue on its own judgment. Returns the QuestionRecord.
 */

/** POST /api/runs/:runId/pause and /resume take no body; both return the RunRecord. */

/** POST /api/escalations/:id/resolve */
export interface ResolveEscalationRequest {
  resolution: "extend" | "cancel" | "dismiss";
  /** extend (round_limit): how many more rounds to allow (default 2). */
  extraRounds?: number;
  note?: string;
}

export type ListPermissionRulesResponse = PermissionRule[];
export type CreatePermissionRuleRequest = Omit<PermissionRule, "id" | "createdAt" | "hits" | "lastHitAt" | "createdFrom">;

// ───────────────────────────── settings ─────────────────────────────

/** Model used to name runs (any OpenAI-compatible chat-completions endpoint). */
export interface TitleModelSettings {
  enabled: boolean;
  /** e.g. "http://127.0.0.1:3425/v1" — `/chat/completions` is appended. */
  baseUrl: string;
  model: string;
  /** True when an API key is stored (the key itself is never returned). */
  hasApiKey: boolean;
  /** Read the key from this environment variable instead of the stored key. */
  apiKeyEnv?: string;
}

/** GET /api/settings */
export interface SettingsResponse {
  /** Absent until configured. */
  titleModel?: TitleModelSettings;
  github?: GithubSettings & { ghFound: boolean; authenticated?: boolean };
}

/** PUT /api/settings — partial update; persisted to $BATON_HOME/config.json (0600). */
export interface UpdateSettingsRequest {
  titleModel?: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    /** Write-only. Empty string clears the stored key. */
    apiKey?: string;
    apiKeyEnv?: string | null;
  } | null;
  github?: GithubSettings | null;
}

/** POST /api/settings/title-model/test — try the (saved or given) settings on a sample prompt. */
export interface TestTitleModelRequest {
  sample?: string;
  titleModel?: UpdateSettingsRequest["titleModel"];
}
export interface TestTitleModelResponse {
  ok: boolean;
  title?: string;
  error?: string;
  latencyMs: number;
}

// ───────────────────────────── background processes ─────────────────────────────

/** GET /api/background?status=running|all — across runs (default: running, not dismissed). */
export type ListBackgroundResponse = Array<BackgroundProcess & { runTitle: string }>;

/** POST /api/background/:id/stop — SIGTERM the process family, SIGKILL after `graceMs`. */
export interface StopBackgroundRequest {
  /** Default 5000. 0 = SIGKILL immediately. */
  graceMs?: number;
}

/** POST /api/background/:id/dismiss — hide it (not attributable to this run, or the human knows). */
export interface DismissBackgroundRequest {
  dismissed: boolean;
}

/** POST /api/runs/:runId/cancel — optional body. */
export interface CancelRunRequest {
  /** Also stop the run's running background processes. Default false. */
  stopBackground?: boolean;
}

// ───────────────────────────── projects ─────────────────────────────

/** GET /api/projects?archived=1 — summaries (default excludes archived). */
export type ListProjectsResponse = ProjectSummary[];

/** POST /api/projects — register a directory. Returns the existing project when the path is already registered. */
export interface CreateProjectRequest {
  /** Absolute path; `~` is expanded. Must be an existing directory. */
  path: string;
  name?: string;
}

/** PATCH /api/projects/:id */
export interface PatchProjectRequest {
  name?: string;
  archived?: boolean;
}

export type GetProjectResponse = ProjectSummary;
export type CreateProjectResponse = ProjectRecord;

/** GET /api/fs/dirs?path=<abs or ~> — directory browser for adding projects (directories only). */
export interface ListDirsResponse {
  /** "" on win32 means "the list of drives" (dirs are the drive roots); its entries have no parent. */
  path: string;
  parent?: string;
  home: string;
  dirs: Array<{ name: string; path: string; isGitRepo: boolean; isProject: boolean }>;
}

// ───────────────────────────── composer: "/" commands and "@" files ─────────────────────────────

/**
 * A slash command / skill / prompt the agent accepts (DESIGN §8.3 "输入框补全"). The composer inserts
 * `/${name} ` and sends it as plain text; the provider (or its baton adapter) turns it into the
 * agent's native invocation.
 */
export interface AgentCommand {
  /** Without the leading "/", exactly as the user types it (e.g. "review", "skill:pdf", "prompts:fix"). */
  name: string;
  description?: string;
  /** e.g. "<file> [focus]". */
  argumentHint?: string;
  /** Display grouping only. */
  kind?: "command" | "skill" | "prompt" | "builtin";
}

/**
 * GET /api/commands?nodeId=<id>            — a session's commands (live session when open)
 * GET /api/commands?agentId=<id>&cwd=<abs> — before a node exists (new run form)
 * Never fails for an agent that lists nothing: `commands: []`, `source: "none"`.
 */
export interface ListCommandsResponse {
  commands: AgentCommand[];
  /** "session": from the live provider session; "scan": discovered without a session (files on disk). */
  source: "session" | "scan" | "none";
}

/**
 * GET /api/files/search?cwd=<abs>&q=<text>&limit=<n> — "@" file completion. `cwd` must be an
 * existing directory. Paths are relative to cwd with "/" separators; directories end in "/".
 * Respects .gitignore inside git repos; skips .git and node_modules otherwise. Default limit 50, max 200.
 */
export interface SearchFilesResponse {
  cwd: string;
  files: Array<{ path: string; kind: "file" | "dir" }>;
  /** More matches exist than were returned. */
  truncated: boolean;
}

// ───────────────────────────── pull requests ─────────────────────────────

/** GET /api/prs?projectId=&state=open|all — across runs (default: open + draft). */
export type ListPullRequestsResponse = Array<PullRequestRecord & { runTitle: string }>;

/** POST /api/runs/:runId/prs — the human links a PR URL to the run. */
export interface LinkPullRequestRequest {
  url: string;
  /** Optional node to attribute it to. */
  nodeId?: string;
}

/** POST /api/prs/:id/feedback — send CI failures and/or review comments to an agent as a queued message. */
export interface PullRequestFeedbackRequest {
  include: Array<"checks" | "reviews">;
  /** Default: the node that created the PR, else the run root. */
  nodeId?: string;
  /** Extra instruction appended to the message. */
  note?: string;
}

/** Config `github` section (PUT /api/settings): gh binary and env for status polling. */
export interface GithubSettings {
  /** Path to gh (default: resolved from PATH, then ~/.local/bin/gh). */
  ghPath?: string;
  /** Extra env for gh, e.g. { "HTTPS_PROXY": "http://127.0.0.1:7890" }. */
  env?: Record<string, string>;
  /** Track PR URLs that agents merely mention (source "mentioned"). Default true. */
  trackMentioned?: boolean;
}

// ───────────────────────────── desktop / notifications ─────────────────────────────

/**
 * GET /api/notifications/events — SSE stream of the notifications the daemon would show
 * (event name "notification"). The desktop app subscribes and shows native notifications; when the
 * daemon runs with `--notifications client` (or config notifications.mode = "client") it does not
 * show OS notifications itself.
 */
export interface NotificationEvent {
  id: string;
  kind: "pending" | "run_completed" | "pr" | "other";
  title: string;
  body: string;
  runId?: string;
  /** Console route to open on click, e.g. "/runs/<id>" or "/inbox". */
  route?: string;
  ts: string;
}

// ───────────────────────────── rollback (DESIGN §4.13) ─────────────────────────────

/** GET /api/nodes/:nodeId/checkpoints → { checkpoints: CheckpointRecord[] }, newest first. */
export interface ListCheckpointsResponse {
  checkpoints: import("./records.js").CheckpointRecord[];
}
/** GET /api/checkpoints/:id/changes — what a file rollback to this checkpoint would undo. */
export interface CheckpointChangesResponse {
  files: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
}
/**
 * POST /api/nodes/:nodeId/rollback — rewind to just before the checkpoint's human message.
 * Running turns in the run are interrupted first (the run is not paused). "conversation": items from
 * the checkpoint's message on get `rolledBack: true`, the provider session is rewound (native or
 * replay), and delegations the node started after the checkpoint are canceled with their subtrees.
 * "files": the node's cwd is restored to the snapshot (files added since are deleted). "both": both.
 * 409 when the mode is not available for this checkpoint.
 */
export interface RollbackRequest {
  checkpointId: string;
  mode: import("./records.js").RollbackMode;
}
export interface RollbackResponse {
  mode: import("./records.js").RollbackMode;
  /** conversation/both: the rolled-back human message text, for the console to put back in the composer. */
  draft?: string;
  /** files/both: restored paths (relative to the cwd). */
  files?: string[];
  /** conversation/both: delegations started after the checkpoint that were canceled. */
  canceledDelegations?: string[];
  conversation?: "native" | "replay";
}

// ───────────────────────────── images / attachments ─────────────────────────────

/** Image types accepted for attachments (upload and tool output). */
export const ATTACHMENT_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Largest attachment the daemon stores, in bytes. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * POST /api/attachments — body is the raw image bytes with Content-Type one of
 * ATTACHMENT_MIME_TYPES; optional `X-Attachment-Name` header (URI-encoded file name).
 * 201 → AttachmentRecord. Files live in BATON_HOME/attachments/<id>.<ext>.
 *
 * GET /api/attachments/:id — the bytes with their content type (Bearer auth like every API call).
 */
export interface AttachmentRecord extends AttachmentRef {
  size: number;
  createdAt: string;
}

/**
 * Images inside a human message: the composer writes each image as a Markdown image whose URL is
 * `attachment:<id>` at the cursor position, e.g. `看这里 ![截图](attachment:att_123) 哪里不对`.
 * The kernel turns the text into ordered text/image parts for agents with capabilities.images and
 * into text plus "[图片: /abs/path]" notes for the rest. Transcripts render the marker as a thumbnail.
 *
 * Agents pass images to each other the same way: a delegate brief, a send() follow-up or a
 * report_result summary may contain `![name](attachment:<id>)` or `![name](/absolute/path.png)`; the
 * kernel stores local image paths as attachments and delivers them to the recipient like a human's.
 */
export const ATTACHMENT_URL_PREFIX = "attachment:";

/**
 * GET /api/files/image?path=<absolute path> — serves a local image an agent referred to by path in
 * its Markdown (e.g. `![](/Users/me/proj/shot.png)` or a path relative to the node's cwd, resolved
 * by the client against NodeRecord.cwd). Only ATTACHMENT_MIME_TYPES extensions, regular files, at
 * most ATTACHMENT_MAX_BYTES; 404 otherwise. Bearer auth.
 */
