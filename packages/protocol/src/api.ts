/** REST request/response bodies (DESIGN §7). */
import type { PermissionResponse } from "./timeline.js";
import type { AgentEntry, BackgroundProcess, DelegationRecord, InboxItem, ItemRecord, PermissionRule, RunPolicy, RunSnapshot, RunSummary, TeamMemberSpec, TeamPreset } from "./records.js";

export interface CreateRunRequest {
  /** Root agent. Optional when `teamPresetId` is given (the preset's lead is used). */
  agent?: string;
  model?: string;
  modeId?: string;
  thinking?: string;
  /** Absolute path of the working directory. */
  cwd: string;
  prompt: string;
  title?: string;
  policy?: Partial<RunPolicy>;
  /** Use a saved team (sets policy.mode = "preset"). */
  teamPresetId?: string;
  /** Dynamic mode only: members the human wants on the team from the start (the lead may add more). */
  team?: TeamMemberSpec[];
}

export interface PatchRunRequest {
  title?: string;
  policy?: Partial<Pick<RunPolicy, "autoApprove" | "maxDepth" | "maxActiveChildren" | "budget" | "teamApproval" | "maxTeamSize" | "stallMinutes" | "maxRoundsPerDelegation">>;
}

export interface SendMessageRequest {
  text: string;
  /** Client-generated id echoed on the stored user_message item (optimistic UI reconciliation). */
  clientId?: string;
}

/** 202 response of POST /api/nodes/:nodeId/messages. */
export interface SendMessageResponse {
  accepted: true;
  delivery: "turn" | "steered" | "queued";
  /** Node-local seq of the user_message item that represents this message. */
  itemSeq: number;
}

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
  answer: string;
}

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
