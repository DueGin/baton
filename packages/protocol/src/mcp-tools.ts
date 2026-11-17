/**
 * Input/output schemas of the MCP tools baton injects into every node (DESIGN §4.2).
 * Tool descriptions here are what the agents see — keep them precise.
 */
import { z } from "zod";

const jsonSchemaObject = z.record(z.string(), z.unknown());

export const BATON_MCP_SERVER_NAME = "baton";

export const listAgentsInput = z.object({});

export const delegateInput = z.object({
  candidate: z
    .string()
    .optional()
    .describe("Preset candidate id from get_team (preset runs): hires that candidate into the team under `role` (name a new role) and delegates to it. No roster approval is needed."),
  role: z
    .string()
    .optional()
    .describe("Team role to delegate to (see get_team). Required in preset runs; preferred in dynamic runs."),
  agent: z
    .string()
    .optional()
    .describe('Agent id from list_agents, e.g. "codex". Use when not delegating by role; in dynamic runs this adds an ad-hoc member to the team.'),
  model: z.string().optional().describe("Override the member's / agent's model."),
  mode: z.string().optional().describe("Override the member's / agent's mode."),
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
  /** Absent while the delegation waits for a team proposal (no node exists yet). */
  nodeId: z.string().optional(),
  status: z.enum(["queued", "running", "pending_approval"]),
  /** Set when the delegation waits for this team proposal to be approved. */
  proposalId: z.string().optional(),
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


const memberSpec = z.object({
  role: z.string().min(1).max(40).describe('Short unique role name, e.g. "frontend", "assets", "tester".'),
  agent: z.string().describe("Agent id from list_agents."),
  model: z.string().optional(),
  mode: z.string().optional(),
  thinking: z.string().optional(),
  responsibilities: z.string().min(1).describe("What this role owns: scope, files, deliverables."),
  reason: z.string().optional().describe("Why this agent/model fits the role."),
});

export const formTeamInput = z.object({
  rationale: z.string().min(1).describe("How you split the request and why this team."),
  members: z.array(memberSpec).min(1).max(12),
});

export const getTeamInput = z.object({});

export const replaceMemberInput = z.object({
  role: z.string().describe("Role whose member is replaced."),
  agent: z.string().describe("New agent id."),
  model: z.string().optional(),
  mode: z.string().optional(),
  thinking: z.string().optional(),
  responsibilities: z.string().optional().describe("Omit to keep the role's responsibilities."),
  reason: z.string().min(1),
  reassignActive: z
    .boolean()
    .default(true)
    .describe("Also hand the old member's unfinished delegations to the new member."),
});

export const reassignInput = z.object({
  delegationId: z.string().describe("One of your delegations."),
  role: z.string().optional().describe("Give it to this team role…"),
  agent: z.string().optional().describe("…or to this agent (ad-hoc)."),
  model: z.string().optional(),
  mode: z.string().optional(),
  reason: z.string().min(1),
});

export const askHumanInput = z.object({
  question: z.string().min(1).describe("One clear question with the context the human needs to answer it."),
  options: z.array(z.string().min(1)).max(8).optional().describe("Suggested answers shown as choices (the human may still type their own)."),
  multiSelect: z.boolean().default(false).describe("Allow choosing several options."),
  blocking: z
    .boolean()
    .default(true)
    .describe("True (default): this call waits until the human answers and returns the answer — then continue your work in the same turn. False: returns immediately; the answer arrives later as a <baton-answer> message."),
});

export const BATON_TOOLS = {
  list_agents: {
    input: listAgentsInput,
    description:
      "List the agents you can delegate to on this machine, with models, modes, notes and current load.",
  },
  form_team: {
    input: formTeamInput,
    description:
      "Lead only (dynamic runs): form the team for this request — roles, the agent/model that fills each role, and their responsibilities. Call before delegating; call again to add roles. Keep the team as small as the work allows.",
  },
  get_team: {
    input: getTeamInput,
    description: "The run's team: roles, who fills them, their responsibilities and their current delegations.",
  },
  replace_member: {
    input: replaceMemberInput,
    description:
      "Lead only: replace the agent filling a role (e.g. it failed, is too slow, or another agent fits better). By default its unfinished delegations move to the new member with a summary of the work done so far.",
  },
  reassign: {
    input: reassignInput,
    description:
      "Move one of your delegations to another role or agent. The current delegate is stopped; the new one gets the same brief plus a summary of the work done so far. The result then comes from the new delegation id returned here.",
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
  ask_human: {
    input: askHumanInput,
    description:
      "Ask the human a judgment question (a decision, missing information, a risky trade-off). Do not use it for things you can find out yourself. By default the call waits for the answer and returns it, so you can continue right away. If it returns \"no answer yet\", continue with other work or end your turn; the answer will arrive as a <baton-answer> message. If it returns \"declined\" (or a <baton-answer declined=\"true\"> arrives), the human chose not to answer: do not ask again, decide yourself and say which assumption you made.",
  },
  report_result: {
    input: reportResultInput,
    description:
      "Delegates only: report your final result to the agent that delegated to you, then end your turn. Call exactly once per assignment.",
  },
} as const;

export type BatonToolName = keyof typeof BATON_TOOLS;
/** Tools only the root (lead) may call. */
export const LEAD_ONLY_TOOLS: readonly BatonToolName[] = ["form_team", "replace_member"];
export type FormTeamInput = z.infer<typeof formTeamInput>;
export type AskHumanInput = z.infer<typeof askHumanInput>;
export type ReplaceMemberInput = z.infer<typeof replaceMemberInput>;
export type ReassignInput = z.infer<typeof reassignInput>;
export type DelegateInput = z.infer<typeof delegateInput>;
export type DelegateOutput = z.infer<typeof delegateOutput>;
export type WaitInput = z.infer<typeof waitInput>;
export type SendInput = z.infer<typeof sendInput>;
export type CancelInput = z.infer<typeof cancelInput>;
export type StatusInput = z.infer<typeof statusInput>;
export type GetResultInput = z.infer<typeof getResultInput>;
export type ReportResultInput = z.infer<typeof reportResultInput>;
