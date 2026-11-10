/**
 * Input/output schemas of the MCP tools baton injects into every node (DESIGN §4.2).
 * Tool descriptions here are what the agents see — keep them precise.
 */
import { z } from "zod";

const jsonSchemaObject = z.record(z.string(), z.unknown());

export const BATON_MCP_SERVER_NAME = "baton";

export const listAgentsInput = z.object({});

export const delegateInput = z.object({
  agent: z.string().describe('Agent id from list_agents, e.g. "codex", "claude", "pi".'),
  model: z.string().optional().describe("Model id from list_agents; omit for the agent default."),
  mode: z.string().optional().describe("Mode id from list_agents; omit for the run default."),
  title: z.string().min(1).max(120).describe("Short title shown in the topology graph."),
  task: z.string().min(1).describe("What the delegate must do. Self-contained: it cannot see your conversation."),
  context: z.string().optional().describe("Relevant facts, file paths, decisions, what was already tried."),
  acceptance: z.array(z.string()).optional().describe("Acceptance criteria the result must meet."),
  readonly: z.boolean().optional().describe("True when the delegate must not modify files."),
  outputSchema: jsonSchemaObject
    .optional()
    .describe("JSON Schema for the structured `result` the delegate must report."),
});

export const delegateOutput = z.object({
  delegationId: z.string(),
  nodeId: z.string(),
  status: z.enum(["queued", "running"]),
  note: z.string(),
});

export const waitInput = z.object({
  delegationIds: z
    .array(z.string())
    .optional()
    .describe("Delegations to wait for; omit for all of your unfinished delegations."),
  mode: z.enum(["any", "all"]).default("any"),
  timeoutSec: z.number().int().min(1).max(50).default(45),
});

export const getResultInput = z.object({ delegationId: z.string() });

export const sendInput = z.object({
  delegationId: z.string(),
  message: z.string().min(1).describe("Follow-up instruction or answer for the delegate."),
});

export const cancelInput = z.object({
  delegationId: z.string(),
  reason: z.string().optional(),
});

export const statusInput = z.object({
  delegationId: z.string().optional().describe("Omit for all of your delegations."),
});

export const reportResultInput = z.object({
  status: z.enum(["success", "partial", "failed"]),
  summary: z.string().min(1).describe("What you did, what you found, what is left. Plain text."),
  result: z.unknown().optional().describe("Structured result; must match the brief's outputSchema if one was given."),
  artifacts: z
    .array(
      z.object({
        kind: z.enum(["file", "url", "note"]),
        value: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

export const BATON_TOOLS = {
  list_agents: {
    input: listAgentsInput,
    description:
      "List the agents you can delegate to on this machine, with models, modes, notes and current load.",
  },
  delegate: {
    input: delegateInput,
    description:
      "Delegate a self-contained task to another agent (any vendor). Returns immediately. The result is delivered to you automatically as a <baton-results> message when the delegate finishes; you may end your turn or keep working meanwhile. Do not poll.",
  },
  wait: {
    input: waitInput,
    description:
      "Block up to timeoutSec (≤50) for delegations to finish and return their results. Use only when you cannot proceed without them; otherwise end your turn and results arrive automatically.",
  },
  get_result: {
    input: getResultInput,
    description: "Get the full result, final message and artifacts of one of your delegations.",
  },
  send: {
    input: sendInput,
    description: "Send a follow-up instruction or answer to one of your delegates (reopens it if finished).",
  },
  cancel: {
    input: cancelInput,
    description: "Cancel one of your delegations and everything it delegated further.",
  },
  status: {
    input: statusInput,
    description: "Status of your delegations and their subtrees (state, elapsed time, usage).",
  },
  report_result: {
    input: reportResultInput,
    description:
      "Delegates only: report your final result to the agent that delegated to you, then end your turn. Call exactly once per assignment.",
  },
} as const;

export type BatonToolName = keyof typeof BATON_TOOLS;
export type DelegateInput = z.infer<typeof delegateInput>;
export type DelegateOutput = z.infer<typeof delegateOutput>;
export type WaitInput = z.infer<typeof waitInput>;
export type SendInput = z.infer<typeof sendInput>;
export type CancelInput = z.infer<typeof cancelInput>;
export type StatusInput = z.infer<typeof statusInput>;
export type GetResultInput = z.infer<typeof getResultInput>;
export type ReportResultInput = z.infer<typeof reportResultInput>;
