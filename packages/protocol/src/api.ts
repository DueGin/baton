/** REST request/response bodies (DESIGN §7). */
import type { PermissionResponse } from "./timeline.js";
import type { AgentEntry, ItemRecord, RunPolicy, RunSnapshot, RunSummary, DelegationRecord } from "./records.js";

export interface CreateRunRequest {
  agent: string;
  model?: string;
  modeId?: string;
  thinking?: string;
  /** Absolute path of the working directory. */
  cwd: string;
  prompt: string;
  title?: string;
  policy?: Partial<RunPolicy>;
}

export interface PatchRunRequest {
  title?: string;
  policy?: Partial<Pick<RunPolicy, "autoApprove" | "maxDepth" | "maxActiveChildren" | "budget" | "delegation">>;
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
