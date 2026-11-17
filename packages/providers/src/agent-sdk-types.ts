// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/agent-sdk-types.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
export interface AgentUsage {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalCostUsd?: number;
    contextWindowMaxTokens?: number;
    contextWindowUsedTokens?: number;
}
export const TOOL_CALL_ICON_NAMES = [
    "wrench",
    "square_terminal",
    "eye",
    "pencil",
    "search",
    "bot",
    "sparkles",
    "brain",
    "mic_vocal",
] as const;
export type ToolCallIconName = (typeof TOOL_CALL_ICON_NAMES)[number];
export type ToolCallDetail = {
    type: "shell";
    command: string;
    cwd?: string;
    output?: string;
    exitCode?: number | null;
} | {
    type: "read";
    filePath: string;
    content?: string;
    offset?: number;
    limit?: number;
} | {
    type: "edit";
    filePath: string;
    oldString?: string;
    newString?: string;
    unifiedDiff?: string;
} | {
    type: "write";
    filePath: string;
    content?: string;
} | {
    type: "search";
    query: string;
    toolName?: "search" | "grep" | "glob" | "web_search";
    content?: string;
    filePaths?: string[];
    webResults?: Array<{
        title: string;
        url: string;
    }>;
    annotations?: string[];
    numFiles?: number;
    numMatches?: number;
    durationMs?: number;
    durationSeconds?: number;
    truncated?: boolean;
    mode?: "content" | "files_with_matches" | "count";
} | {
    type: "fetch";
    url: string;
    prompt?: string;
    result?: string;
    code?: number;
    codeText?: string;
    bytes?: number;
    durationMs?: number;
} | {
    type: "worktree_setup";
    worktreePath: string;
    branchName: string;
    log: string;
    commands: Array<{
        index: number;
        command: string;
        cwd: string;
        log: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        durationMs?: number;
    }>;
    truncated?: boolean;
} | {
    type: "sub_agent";
    subAgentType?: string;
    description?: string;
    childSessionId?: string;
    // COMPAT(subagent-log): added in v0.14.1, remove after 2027-04-30. Apps before v0.14.1
    // require `log`; every producer sends it empty and carries the same tag. Optional here because
    // protocol timeline items, where `log` is optional, flow into this type.
    log?: string;
    actions?: Array<{
        index: number;
        toolName: string;
        summary?: string;
    }>;
} | {
    type: "plain_text";
    label?: string;
    text?: string;
    icon?: ToolCallIconName;
} | {
    type: "plan";
    text: string;
} | {
    type: "unknown";
    input: unknown;
    output: unknown;
};
interface ToolCallBase {
    [key: string]: unknown;
    type: "tool_call";
    callId: string;
    name: string;
    detail: ToolCallDetail;
    metadata?: Record<string, unknown>;
    /** Images the tool returned, stored through ClientOptions.saveImage (baton). */
    images?: AgentImageRef[];
}
type ToolCallRunningTimelineItem = ToolCallBase & {
    status: "running";
    error: null;
};
type ToolCallCompletedTimelineItem = ToolCallBase & {
    status: "completed";
    error: null;
};
type ToolCallFailedTimelineItem = ToolCallBase & {
    status: "failed";
    error: unknown;
};
type ToolCallCanceledTimelineItem = ToolCallBase & {
    status: "canceled";
    error: null;
};
export type ToolCallTimelineItem = ToolCallRunningTimelineItem | ToolCallCompletedTimelineItem | ToolCallFailedTimelineItem | ToolCallCanceledTimelineItem;
export type AgentProvider = "claude" | "codex" | "pi" | "acp";
export type McpServerConfig = {
    type: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
} | {
    type: "http" | "sse";
    url: string;
    headers?: Record<string, string>;
};
export interface AgentMode {
    id: string;
    label: string;
    description?: string;
    isUnattended?: boolean;
    isReadOnly?: boolean;
}
export interface AgentModelDefinition {
    id: string;
    label: string;
    description?: string;
    isDefault?: boolean;
    thinkingOptions?: Array<{
        id: string;
        label: string;
        isDefault?: boolean;
    }>;
}
export interface ProviderCatalog {
    models: AgentModelDefinition[];
    modes: AgentMode[];
    defaultModeId?: string | null;
}
export interface AgentCapabilities {
    steer: boolean;
    resume: boolean;
    reasoning: boolean;
    mcp: boolean;
    /** Accepts image parts in a prompt (baton). Sessions still fall back to a text note per model/agent. */
    images?: boolean;
}
/** baton: a prompt is plain text or ordered text/image parts (images at their position in the text). */
export type AgentPromptPart = {
    type: "text";
    text: string;
} | {
    type: "image";
    /** Absolute path of a stored image file. */
    path: string;
    mimeType: string;
    name?: string;
};
export type AgentPromptInput = string | AgentPromptPart[];
/** baton: an image stored by the host (same shape as @baton/protocol AttachmentRef). */
export interface AgentImageRef {
    id: string;
    mimeType: string;
    name?: string;
    width?: number;
    height?: number;
}
/** baton: host service that stores an image an agent produced. `data` is raw bytes or base64 (a data: URI is accepted). */
export type SaveImage = (data: Uint8Array | string, mimeType: string, name?: string) => Promise<AgentImageRef>;
export interface AgentSessionConfig {
    cwd: string;
    model?: string;
    modeId?: string;
    thinking?: string;
    systemPrompt?: string;
    mcpServers?: Record<string, McpServerConfig>;
    env?: Record<string, string>;
    title?: string;
}
export interface AgentPersistenceHandle {
    provider: AgentProvider;
    sessionId: string;
    sessionFile?: string;
}
export interface AgentPermissionRequest {
    id: string;
    name: string;
    kind: "tool" | "plan" | "question" | "mode" | "other";
    title?: string;
    description?: string;
    input?: Record<string, unknown>;
    detail?: ToolCallDetail;
    actions?: Array<{
        id: string;
        label: string;
        behavior: "allow" | "deny";
        variant?: "primary" | "secondary" | "danger";
    }>;
}
export type AgentPermissionResponse = {
    behavior: "allow";
    selectedActionId?: string;
    updatedInput?: Record<string, unknown>;
} | {
    behavior: "deny";
    selectedActionId?: string;
    message?: string;
    interrupt?: boolean;
};
export type AgentTimelineItem = {
    type: "user_message" | "assistant_message";
    text: string;
    messageId?: string;
} | {
    type: "reasoning";
    text: string;
} | ToolCallTimelineItem | {
    type: "todo";
    items: Array<{
        text: string;
        status: "pending" | "in_progress" | "completed";
    }>;
} | {
    type: "error";
    message: string;
} | {
    type: "notification";
    level: "info" | "warning" | "error";
    message: string;
};
export type AgentStreamEvent = {
    type: "thread_started";
    sessionId: string;
} | {
    type: "turn_started";
    turnId: string;
} | {
    type: "turn_completed";
    turnId: string;
    usage?: AgentUsage;
} | {
    type: "turn_failed";
    turnId: string;
    error: string;
    diagnostic?: string;
} | {
    type: "turn_canceled";
    turnId: string;
    reason: string;
} | {
    type: "timeline";
    turnId?: string;
    item: AgentTimelineItem;
    timestamp: string;
} | {
    type: "usage_updated";
    turnId?: string;
    usage: AgentUsage;
} | {
    type: "permission_requested";
    turnId?: string;
    request: AgentPermissionRequest;
} | {
    type: "permission_resolved";
    turnId?: string;
    requestId: string;
    resolution: AgentPermissionResponse;
} | {
    type: "mode_changed";
    currentModeId: string | null;
} | {
    type: "model_changed";
    model: string | null;
} | {
    type: "closed";
    error?: string;
};
export interface AgentSession {
    /** Whether this session applied a long MCP tool timeout for inline human questions. */
    supportsLongToolCalls?(): boolean;
    /** Agent runtime processes, for baton background-process attribution. */
    processIds?(): number[];
    readonly sessionId: string | null;
    getPersistence(): AgentPersistenceHandle | null;
    startTurn(prompt: AgentPromptInput): Promise<{
        turnId: string;
    }>;
    steerActiveTurn?(prompt: AgentPromptInput): Promise<boolean>;
    interrupt(): Promise<void>;
    respondToPermission(id: string, response: AgentPermissionResponse): Promise<void>;
    pendingPermissions(): AgentPermissionRequest[];
    subscribe(listener: (event: AgentStreamEvent) => void): () => void;
    runtimeInfo(): Promise<{
        model?: string | null;
        modeId?: string | null;
    }>;
    close(): Promise<void>;
}
export interface AgentClient {
    readonly provider: AgentProvider;
    readonly capabilities: AgentCapabilities;
    fetchCatalog(): Promise<ProviderCatalog>;
    createSession(config: AgentSessionConfig): Promise<AgentSession>;
    resumeSession(handle: AgentPersistenceHandle, config: AgentSessionConfig): Promise<AgentSession>;
}
export interface ClientOptions {
    command: string[];
    home: string;
    env?: Record<string, string>;
    logger?: import("pino").Logger;
    timeoutMs?: number;
    /** Stores images agents return (tool output, generated images). Without it they are dropped. */
    saveImage?: SaveImage;
}
