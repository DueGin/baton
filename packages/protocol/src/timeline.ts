/**
 * Timeline, usage and permission shapes shared by server and web.
 *
 * Portions adapted from Paseo (https://github.com/getpaseo/paseo),
 * packages/server/src/server/agent/agent-sdk-types.ts — Copyright (c) 2025-present Mohamed Boudra,
 * Apache License 2.0. Modified for baton: renamed, trimmed (no plugin/compaction/agentMessage rows).
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

/** Normalized tool call payload (same discriminants as Paseo's ToolCallDetail). */
export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      numFiles?: number;
      numMatches?: number;
    }
  | { type: "fetch"; url: string; prompt?: string; result?: string; code?: number }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      actions?: Array<{ index: number; toolName: string; summary?: string }>;
    }
  | { type: "plain_text"; label?: string; text?: string }
  | { type: "plan"; text: string }
  /** A call to one of baton's own MCP tools (delegate, wait, …). Set by the server, not providers. */
  | { type: "baton"; tool: string; delegationId?: string; input?: JsonValue; output?: JsonValue }
  | { type: "unknown"; input: unknown; output: unknown };

export type ToolCallKind = ToolCallDetail["type"];

export type ToolCallStatus = "running" | "completed" | "failed" | "canceled";

export interface ToolCallItem {
  type: "tool_call";
  callId: string;
  name: string;
  status: ToolCallStatus;
  detail: ToolCallDetail;
  /** Error text when status is "failed". */
  error?: string;
}

export interface TodoEntry {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * One transcript row. `assistant_message` and `reasoning` arrive from drivers as chunks; the
 * server merges consecutive chunks of the same turn into one stored item (see DESIGN §6).
 */
export type TimelineItem =
  | {
      type: "user_message";
      text: string;
      messageId?: string;
      /**
       * How the message reached the agent (human messages): "turn" started a new turn, "steered"
       * was injected into the running turn, "queued" waits for the running turn to end (the same
       * itemSeq is replaced with "turn" when it is delivered). Absent for kernel prompts.
       */
      delivery?: "turn" | "steered" | "queued" | "retracted";
      /** True when this message interrupted the node's running turn ("立即发送"). */
      interrupted?: boolean;
      /** True when a queued message was later steered into the running turn ("引导发送"). */
      escalated?: boolean;
      /** Set when the human edited the text while it was queued. */
      editedAt?: string;
      /** Position in the node's queue while delivery is "queued" (ascending = delivered first). */
      queuePosition?: number;
      /**
       * Order (1..k) among the human messages delivered together into the same turn (drain); lets
       * consumers restore the reordered sequence after a reload. Absent when delivered alone.
       */
      deliveryOrder?: number;
      /** Echo of SendMessageRequest.clientId, so the console can reconcile its optimistic row. */
      clientId?: string;
    }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCallItem
  | { type: "todo"; items: TodoEntry[] }
  | { type: "error"; message: string }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string };

export type PermissionKind = "tool" | "plan" | "question" | "mode" | "other";

export interface PermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
}

export interface PermissionRequest {
  /** Provider request id; unique within the node. */
  id: string;
  name: string;
  kind: PermissionKind;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: ToolCallDetail;
  actions?: PermissionAction[];
}

export type PermissionResponse =
  | { behavior: "allow"; selectedActionId?: string; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean };
