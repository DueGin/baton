import type {
  AgentEntry, CreateRunRequest, DelegationRecord, GetItemsResponse, PatchRunRequest,
  PermissionDecision, RunEventEnvelope, RunSnapshot, RunSummary, AddMemberRequest, ReplaceMemberRequest,
  ReassignRequest, TeamPreset, TeamPresetInput, SaveTeamPresetRequest, ApproveTeamProposalRequest, RejectTeamProposalRequest,
  SettingsResponse, UpdateSettingsRequest, TestTitleModelRequest, TestTitleModelResponse,
  ListBackgroundResponse, StopBackgroundRequest, DismissBackgroundRequest, CancelRunRequest,
  ProjectRecord, ProjectSummary, CreateProjectRequest, PatchProjectRequest, ListDirsResponse,
  SendMessageResponse, SendMode, DeliverMessageRequest, EditMessageRequest, ReorderQueueRequest, ReorderQueueResponse, InboxItem, AnswerQuestionRequest, ResolveEscalationRequest, PermissionRule, CreatePermissionRuleRequest,
} from "@baton/protocol";

/** The server may attach availability warnings to successful preset mutations. */
export type TeamPresetResult = TeamPreset & { warnings?: string[] };

export interface BatonClient {
  readonly demo: boolean;
  agents(refresh?: boolean): Promise<AgentEntry[]>;
  runs(projectId?: string): Promise<RunSummary[]>;
  projects(includeArchived?: boolean): Promise<ProjectSummary[]>;
  project(id: string): Promise<ProjectSummary>;
  createProject(request: CreateProjectRequest): Promise<ProjectRecord>;
  patchProject(id: string, request: PatchProjectRequest): Promise<ProjectSummary>;
  dirs(path?: string): Promise<ListDirsResponse>;
  run(id: string): Promise<RunSnapshot>;
  createRun(request: CreateRunRequest): Promise<RunSnapshot>;
  patchRun(id: string, request: PatchRunRequest): Promise<void>;
  regenerateTitle(id: string): Promise<void>;
  settings(): Promise<SettingsResponse>;
  updateSettings(request: UpdateSettingsRequest): Promise<SettingsResponse>;
  testTitleModel(request: TestTitleModelRequest): Promise<TestTitleModelResponse>;
  cancelRun(id: string, request?: CancelRunRequest): Promise<void>;
  background(status?: "running" | "all"): Promise<ListBackgroundResponse>;
  stopBackground(id: string, request?: StopBackgroundRequest): Promise<void>;
  dismissBackground(id: string, request: DismissBackgroundRequest): Promise<void>;
  items(nodeId: string, after?: number): Promise<GetItemsResponse>;
  send(nodeId: string, text: string, clientId?: string, mode?: SendMode): Promise<SendMessageResponse>;
  deliver(nodeId: string, itemSeq: number, request: DeliverMessageRequest): Promise<SendMessageResponse>;
  retract(nodeId: string, itemSeq: number): Promise<void>;
  edit(nodeId: string, itemSeq: number, request: EditMessageRequest): Promise<void>;
  reorderQueue(nodeId: string, request: ReorderQueueRequest): Promise<ReorderQueueResponse>;
  cancelNode(nodeId: string): Promise<void>;
  decide(requestId: string, decision: PermissionDecision): Promise<void>;
  delegation(id: string): Promise<DelegationRecord>;
  teams(): Promise<TeamPreset[]>;
  createTeam(request: TeamPresetInput): Promise<TeamPresetResult>;
  updateTeam(id: string, request: TeamPresetInput): Promise<TeamPresetResult>;
  deleteTeam(id: string): Promise<void>;
  addMember(runId: string, request: AddMemberRequest): Promise<void>;
  replaceMember(runId: string, memberId: string, request: ReplaceMemberRequest): Promise<void>;
  removeMember(runId: string, memberId: string): Promise<void>;
  saveTeam(runId: string, request: SaveTeamPresetRequest): Promise<TeamPresetResult>;
  reassign(id: string, request: ReassignRequest): Promise<void>;
  approveTeam(runId: string, proposalId: string, request: ApproveTeamProposalRequest): Promise<void>;
  rejectTeam(runId: string, proposalId: string, request: RejectTeamProposalRequest): Promise<void>;
  inbox(): Promise<InboxItem[]>;
  inboxEvents(changed: () => void, signal: AbortSignal): Promise<void>;
  answer(id: string, request: AnswerQuestionRequest): Promise<void>;
  resolveEscalation(id: string, request: ResolveEscalationRequest): Promise<void>;
  permissionRules(): Promise<PermissionRule[]>;
  createPermissionRule(request: CreatePermissionRuleRequest): Promise<void>;
  deletePermissionRule(id: string): Promise<void>;
  /** A connection lasts until aborted or disconnected. The store owns reconnects. */
  events(runId: string, after: number, onEvent: (event: RunEventEnvelope) => void, signal: AbortSignal): Promise<void>;
}

export function readToken(location: Pick<Location, "hash" | "pathname" | "search">, storage: Storage, history?: Pick<History, "replaceState">): string | null {
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get("token");
  if (token) {
    storage.setItem("baton.token", token);
    hash.delete("token");
    history?.replaceState(null, "", `${location.pathname}${location.search}${hash.size ? `#${hash}` : ""}`);
  }
  return token || storage.getItem("baton.token");
}

export class ApiClient implements BatonClient {
  readonly demo = false;
  constructor(private readonly token: string) {}

  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const message = await response.text();
      let detail = message;
      try { const parsed: unknown = JSON.parse(message); if (typeof parsed === "object" && parsed && "error" in parsed) detail = JSON.stringify(parsed.error); } catch { /* plain-text server error */ }
      throw new HttpError(response.status, detail || response.statusText);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  agents = (refresh = false) => this.request<AgentEntry[]>(`/agents${refresh ? "/refresh" : ""}`, refresh ? "POST" : "GET");
  runs = (projectId?: string) => this.request<RunSummary[]>(`/runs${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
  projects = (includeArchived = false) => this.request<ProjectSummary[]>(`/projects${includeArchived ? "?archived=1" : ""}`);
  project = (id: string) => this.request<ProjectSummary>(`/projects/${encodeURIComponent(id)}`);
  createProject = (body: CreateProjectRequest) => this.request<ProjectRecord>("/projects", "POST", body);
  patchProject = (id: string, body: PatchProjectRequest) => this.request<ProjectSummary>(`/projects/${encodeURIComponent(id)}`, "PATCH", body);
  dirs = (path = "~") => this.request<ListDirsResponse>(`/fs/dirs?path=${encodeURIComponent(path)}`);
  run = (id: string) => this.request<RunSnapshot>(`/runs/${encodeURIComponent(id)}`);
  createRun = (body: CreateRunRequest) => this.request<RunSnapshot>("/runs", "POST", body);
  patchRun = (id: string, body: PatchRunRequest) => this.request<void>(`/runs/${encodeURIComponent(id)}`, "PATCH", body);
  regenerateTitle = (id: string) => this.request<void>(`/runs/${encodeURIComponent(id)}/title/regenerate`, "POST", {});
  settings = () => this.request<SettingsResponse>("/settings");
  updateSettings = (body: UpdateSettingsRequest) => this.request<SettingsResponse>("/settings", "PUT", body);
  testTitleModel = (body: TestTitleModelRequest) => this.request<TestTitleModelResponse>("/settings/title-model/test", "POST", body);
  cancelRun = (id: string, body: CancelRunRequest = {}) => this.request<void>(`/runs/${encodeURIComponent(id)}/cancel`, "POST", body);
  background = (status: "running" | "all" = "running") => this.request<ListBackgroundResponse>(`/background?status=${status}`);
  stopBackground = (id: string, body: StopBackgroundRequest = {}) => this.request<void>(`/background/${encodeURIComponent(id)}/stop`, "POST", body);
  dismissBackground = (id: string, body: DismissBackgroundRequest) => this.request<void>(`/background/${encodeURIComponent(id)}/dismiss`, "POST", body);
  items = (nodeId: string, after = 0) => this.request<GetItemsResponse>(`/nodes/${encodeURIComponent(nodeId)}/items?after=${after}`);
  send = (nodeId: string, text: string, clientId?: string, mode: SendMode = "queue") => this.request<SendMessageResponse>(`/nodes/${encodeURIComponent(nodeId)}/messages`, "POST", { text, ...(clientId ? { clientId } : {}), mode });
  deliver = (nodeId: string, itemSeq: number, body: DeliverMessageRequest) => this.request<SendMessageResponse>(`/nodes/${encodeURIComponent(nodeId)}/messages/${itemSeq}/deliver`, "POST", body);
  retract = (nodeId: string, itemSeq: number) => this.request<void>(`/nodes/${encodeURIComponent(nodeId)}/messages/${itemSeq}`, "DELETE");
  edit = (nodeId: string, itemSeq: number, body: EditMessageRequest) => this.request<void>(`/nodes/${encodeURIComponent(nodeId)}/messages/${itemSeq}`, "PATCH", body);
  reorderQueue = (nodeId: string, body: ReorderQueueRequest) => this.request<ReorderQueueResponse>(`/nodes/${encodeURIComponent(nodeId)}/queue`, "PUT", body);
  cancelNode = (id: string) => this.request<void>(`/nodes/${encodeURIComponent(id)}/cancel`, "POST", {});
  decide = (id: string, body: PermissionDecision) => this.request<void>(`/permissions/${encodeURIComponent(id)}`, "POST", body);
  delegation = (id: string) => this.request<DelegationRecord>(`/delegations/${encodeURIComponent(id)}`);
  teams = () => this.request<TeamPreset[]>("/teams");
  createTeam = (body: TeamPresetInput) => this.request<TeamPresetResult>("/teams", "POST", body);
  updateTeam = (id: string, body: TeamPresetInput) => this.request<TeamPresetResult>(`/teams/${encodeURIComponent(id)}`, "PUT", body);
  deleteTeam = (id: string) => this.request<void>(`/teams/${encodeURIComponent(id)}`, "DELETE");
  addMember = (id: string, body: AddMemberRequest) => this.request<void>(`/runs/${encodeURIComponent(id)}/team/members`, "POST", body);
  replaceMember = (id: string, memberId: string, body: ReplaceMemberRequest) => this.request<void>(`/runs/${encodeURIComponent(id)}/team/members/${encodeURIComponent(memberId)}/replace`, "POST", body);
  removeMember = (id: string, memberId: string) => this.request<void>(`/runs/${encodeURIComponent(id)}/team/members/${encodeURIComponent(memberId)}`, "DELETE");
  saveTeam = (id: string, body: SaveTeamPresetRequest) => this.request<TeamPresetResult>(`/runs/${encodeURIComponent(id)}/team/save-preset`, "POST", body);
  reassign = (id: string, body: ReassignRequest) => this.request<void>(`/delegations/${encodeURIComponent(id)}/reassign`, "POST", body);
  approveTeam = (id: string, proposalId: string, body: ApproveTeamProposalRequest) => this.request<void>(`/runs/${encodeURIComponent(id)}/team/proposals/${encodeURIComponent(proposalId)}/approve`, "POST", body);
  rejectTeam = (id: string, proposalId: string, body: RejectTeamProposalRequest) => this.request<void>(`/runs/${encodeURIComponent(id)}/team/proposals/${encodeURIComponent(proposalId)}/reject`, "POST", body);
  inbox = () => this.request<InboxItem[]>("/inbox");
  answer = (id: string, body: AnswerQuestionRequest) => this.request<void>(`/questions/${encodeURIComponent(id)}/answer`, "POST", body);
  resolveEscalation = (id: string, body: ResolveEscalationRequest) => this.request<void>(`/escalations/${encodeURIComponent(id)}/resolve`, "POST", body);
  permissionRules = () => this.request<PermissionRule[]>("/permission-rules");
  createPermissionRule = (body: CreatePermissionRuleRequest) => this.request<void>("/permission-rules", "POST", body);
  deletePermissionRule = (id: string) => this.request<void>(`/permission-rules/${encodeURIComponent(id)}`, "DELETE");
  inboxEvents = (changed: () => void, signal: AbortSignal) => this.stream("/inbox/events", new SseFrames(frame => { if (frame.event === "changed" || frame.data === "changed") changed(); }), signal, changed);

  events(id: string, after: number, onEvent: (event: RunEventEnvelope) => void, signal: AbortSignal): Promise<void> {
    return this.stream(`/runs/${encodeURIComponent(id)}/events?after=${after}`, new SseParser(onEvent), signal);
  }
  private async stream(path: string, parser: { push: (chunk: string) => void }, signal: AbortSignal, connected?: () => void): Promise<void> {
    const response = await fetch(`/api${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" }, signal,
    });
    if (!response.ok || !response.body) throw new Error(`事件连接失败 (${response.status})`);
    connected?.(); // Reconcile after the server has subscribed, closing the initial snapshot gap.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, detail: string) { super(`${status} · ${detail}`); this.name = "HttpError"; }
}

/** SSE frames may span UTF-8 chunks and contain multiple data lines. */
export class SseFrames {
  private buffer = "";
  constructor(private readonly emit: (frame: { event: string; data: string }) => void) {}
  push(chunk: string): void {
    this.buffer += chunk;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      const event = frame.split(/\r?\n/).find(line => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      if (data || event !== "message") this.emit({ event, data });
    }
  }
}
export class SseParser extends SseFrames {
  constructor(emit: (event: RunEventEnvelope) => void) { super(frame => { if (frame.data) emit(JSON.parse(frame.data) as RunEventEnvelope); }); }
}
