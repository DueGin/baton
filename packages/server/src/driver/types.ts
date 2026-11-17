/**
 * Driver contract — the only surface the kernel uses to run agents (DESIGN §5).
 *
 * Implementations:
 *   driver/paseo-adapter.ts  PaseoProviderDriver — wraps @baton/providers (ported Paseo adapters)
 *   driver/fake.ts           FakeDriver — scripted, can call baton MCP tools over real HTTP (tests)
 *
 * Contract changes are lead-only. Drivers must never throw from subscribe listeners and must
 * deliver events for one session in order.
 */
import type {
  AgentEntry,
  JsonValue,
  PermissionRequest,
  PermissionResponse,
  TimelineItem,
  Usage,
} from "@baton/protocol";

export type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> };

export interface OpenSessionSpec {
  cwd: string;
  model?: string;
  modeId?: string;
  thinking?: string;
  /** Appended to the agent's own system/developer instructions where supported, else prepended
   * to the first prompt by the driver. */
  systemPrompt?: string;
  /** Always contains the baton server for this node. */
  mcpServers: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  title?: string;
}

/**
 * A prompt is plain text, or ordered text/image parts with each image at its position in the
 * text. Image parts point at a stored attachment file; drivers whose agent cannot take an image
 * send the path as a text note instead. Only sent to drivers whose capabilities.images is true.
 */
export type PromptPart =
  | { type: "text"; text: string }
  | { type: "image"; /** Absolute path of the stored attachment. */ path: string; mimeType: string; name?: string };
export type PromptInput = string | PromptPart[];

export type DriverEvent =
  | { type: "session"; sessionId: string }
  | { type: "turn_started"; turnId: string }
  | { type: "turn_completed"; turnId: string; usage?: Usage }
  | { type: "turn_failed"; turnId: string; error: string; diagnostic?: string }
  | { type: "turn_canceled"; turnId: string; reason: string }
  /** Text items may be chunks; the kernel merges consecutive text of the same type and turn. */
  | { type: "item"; turnId?: string; item: TimelineItem; timestamp: string }
  | { type: "usage"; turnId?: string; usage: Usage }
  | { type: "permission_requested"; turnId?: string; request: PermissionRequest }
  | { type: "permission_resolved"; turnId?: string; requestId: string; response: PermissionResponse }
  | { type: "mode_changed"; modeId: string | null }
  | { type: "model_changed"; model: string | null }
  /** The session process died or became unusable outside of a turn. */
  | { type: "closed"; error?: string };

export type SteerOutcome = "steered" | "unsupported" | "no_active_turn";

export interface DriverSession {
  /** Provider session id once known (also announced with a `session` event). */
  readonly sessionId: string | null;
  /** Opaque JSON for resume after a daemon restart; null if the provider cannot resume. */
  persistence(): JsonValue | null;
  /** Starts a turn; events follow via subscribe. Rejects if a turn is already running. */
  startTurn(prompt: PromptInput): Promise<{ turnId: string }>;
  /** Inject into the active turn. Must not start a new turn. */
  steer(prompt: PromptInput): Promise<SteerOutcome>;
  /** Resolves once the active turn (if any) can no longer run. No-op when idle. */
  interrupt(): Promise<void>;
  respondToPermission(requestId: string, response: PermissionResponse): Promise<void>;
  pendingPermissions(): PermissionRequest[];
  subscribe(listener: (event: DriverEvent) => void): () => void;
  /** Effective model / mode after open (providers may substitute defaults). */
  runtimeInfo(): Promise<{ model?: string | null; modeId?: string | null }>;
  /** Release processes; idempotent. */
  close(): Promise<void>;
  /**
   * PIDs of the agent process(es) backing this session (e.g. the claude CLI, codex app-server,
   * pi rpc). Used to attribute background processes the agent starts (DESIGN §4.8). Optional:
   * drivers that cannot tell return [] or omit it.
   */
  processIds?(): number[];
  /**
   * True when this session's MCP tool calls may stay open for a long time (≥ the ask timeout),
   * e.g. because the driver raised the agent's MCP tool timeout. When false or omitted, blocking
   * ask_human falls back to async delivery (DESIGN §4.6).
   */
  supportsLongToolCalls?(): boolean;
  /**
   * Native conversation rewind (DESIGN §4.13), optional; drivers without it get a replayed transcript
   * in a fresh session instead. `rewindPoint()` is read right after startTurn resolves: an opaque
   * marker for "just before this turn's prompt", or null when the provider cannot tell.
   * `rewindConversation(point)` rewinds the provider conversation to such a marker (fork, thread
   * rollback…). Afterwards the kernel closes the session and resumes from persistence() (null: a
   * fresh session). Rejects when the point cannot be reached; the kernel then replays.
   */
  rewindPoint?(): JsonValue | null;
  rewindConversation?(point: JsonValue): Promise<void>;
}

export interface AgentDriver {
  readonly agentId: string;
  readonly capabilities: AgentEntry["capabilities"];
  open(spec: OpenSessionSpec): Promise<DriverSession>;
  resume(persistence: JsonValue, spec: OpenSessionSpec): Promise<DriverSession>;
}

export interface DriverRegistry {
  /** Detect installed agents. Cached; `force` re-probes. Never rejects (errors become entries). */
  detect(options?: { force?: boolean }): Promise<AgentEntry[]>;
  /** Driver for a ready agent id, or undefined if unknown/unavailable. */
  get(agentId: string): AgentDriver | undefined;
  shutdown(): Promise<void>;
}
