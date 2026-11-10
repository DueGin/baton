import type {
  AgentEntry, CreateRunRequest, DelegationRecord, GetItemsResponse, PatchRunRequest,
  PermissionDecision, RunEventEnvelope, RunSnapshot, RunSummary,
} from "@baton/protocol";

export interface BatonClient {
  readonly demo: boolean;
  agents(refresh?: boolean): Promise<AgentEntry[]>;
  runs(): Promise<RunSummary[]>;
  run(id: string): Promise<RunSnapshot>;
  createRun(request: CreateRunRequest): Promise<RunSnapshot>;
  patchRun(id: string, request: PatchRunRequest): Promise<void>;
  cancelRun(id: string): Promise<void>;
  items(nodeId: string, after?: number): Promise<GetItemsResponse>;
  send(nodeId: string, text: string): Promise<void>;
  cancelNode(nodeId: string): Promise<void>;
  decide(requestId: string, decision: PermissionDecision): Promise<void>;
  delegation(id: string): Promise<DelegationRecord>;
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
      throw new Error(`${response.status} · ${detail || response.statusText}`);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  agents = (refresh = false) => this.request<AgentEntry[]>(`/agents${refresh ? "/refresh" : ""}`, refresh ? "POST" : "GET");
  runs = () => this.request<RunSummary[]>("/runs");
  run = (id: string) => this.request<RunSnapshot>(`/runs/${encodeURIComponent(id)}`);
  createRun = (body: CreateRunRequest) => this.request<RunSnapshot>("/runs", "POST", body);
  patchRun = (id: string, body: PatchRunRequest) => this.request<void>(`/runs/${encodeURIComponent(id)}`, "PATCH", body);
  cancelRun = (id: string) => this.request<void>(`/runs/${encodeURIComponent(id)}/cancel`, "POST", {});
  items = (nodeId: string, after = 0) => this.request<GetItemsResponse>(`/nodes/${encodeURIComponent(nodeId)}/items?after=${after}`);
  send = (nodeId: string, text: string) => this.request<void>(`/nodes/${encodeURIComponent(nodeId)}/messages`, "POST", { text });
  cancelNode = (id: string) => this.request<void>(`/nodes/${encodeURIComponent(id)}/cancel`, "POST", {});
  decide = (id: string, body: PermissionDecision) => this.request<void>(`/permissions/${encodeURIComponent(id)}`, "POST", body);
  delegation = (id: string) => this.request<DelegationRecord>(`/delegations/${encodeURIComponent(id)}`);

  async events(id: string, after: number, onEvent: (event: RunEventEnvelope) => void, signal: AbortSignal): Promise<void> {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}/events?after=${after}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" }, signal,
    });
    if (!response.ok || !response.body) throw new Error(`事件连接失败 (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser(onEvent);
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

/** SSE frames may span UTF-8 chunks and contain multiple data lines. */
export class SseParser {
  private buffer = "";
  constructor(private readonly emit: (event: RunEventEnvelope) => void) {}
  push(chunk: string): void {
    this.buffer += chunk;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data) this.emit(JSON.parse(data) as RunEventEnvelope);
    }
  }
}
