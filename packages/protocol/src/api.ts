/** REST request/response bodies (DESIGN §7). */
import type { PermissionResponse } from "./timeline.js";
import type { AgentEntry, DelegationRecord, ItemRecord, RunPolicy, RunSnapshot, RunSummary, TeamMemberSpec, TeamPreset } from "./records.js";

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
  policy?: Partial<Pick<RunPolicy, "autoApprove" | "maxDepth" | "maxActiveChildren" | "budget">>;
}

export interface SendMessageRequest {
  text: string;
}

export interface PermissionDecision {
  response: PermissionResponse;
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
