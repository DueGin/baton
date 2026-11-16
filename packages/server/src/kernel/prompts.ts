import type { AgentEntry, DelegationRecord, NodeRecord, RunPolicy, TeamRecord } from "@baton/protocol";

/** Machine-readable tags the console parses (see packages/web transcript rendering). */
export const ASSIGNMENT_TAG = "baton-assignment";
export const RESULTS_TAG = "baton-results";

const BATON_TOOL_NAMES = [
  "ask_human", "list_agents", "form_team", "get_team", "replace_member", "reassign", "delegate", "wait", "get_result", "send", "cancel", "status", "report_result",
] as const;
const BACKGROUND_GUIDANCE = "When you start a long-running process (dev server, watcher or background service), tell the human in your reply what it is, its port(s), and how to stop it.";

function describeAgent(agent: AgentEntry): string {
  const model = agent.models.find((m) => m.isDefault)?.id ?? agent.models[0]?.id;
  const parts = [`- ${agent.id} (${agent.label}${agent.kind === "acp" ? ", ACP" : ""})`];
  if (model) parts.push(`default model ${model}`);
  if (agent.models.length > 1) parts.push(`${agent.models.length} models`);
  if (agent.notes) parts.push(agent.notes);
  return parts.join(" — ");
}

export function systemPrompt(
  node: Pick<NodeRecord, "id" | "depth" | "parentNodeId" | "agentId" | "role" | "memberId">,
  policy: RunPolicy,
  agents: AgentEntry[] = [],
  team?: TeamRecord,
): string {
  const isRoot = node.parentNodeId === null;
  const canDelegate = node.depth < policy.maxDepth;
  const mode = policy.mode ?? "dynamic";
  if (mode === "solo") return "You are running inside baton in SOLO mode. Work alone: inspect, implement, verify and answer the human yourself. Only the baton ask_human tool is available: investigate first, then ask for human judgment calls or missing decisions. A blocking ask_human waits in the tool call; use its answer and continue in the same turn. If it returns no_answer_yet, work on something else or end your turn; the answer will arrive later. Load mcp__baton__ask_human with tool search if needed. Do not delegate or form a team. " + BACKGROUND_GUIDANCE;
  const roster = (team?.members ?? []).filter((m) => m.status === "active").map((m) => `- ${m.role}: ${m.agentId}${m.model ? ` / ${m.model}` : ""}. Responsibilities and file ownership: ${m.responsibilities ?? "See assignment"}`).join("\n");
  const lines = [
    "You are running inside baton, a local multi-agent workspace. Other coding agents on this machine — including agents from other vendors — can take work from you through the `baton` MCP tools.",
    BACKGROUND_GUIDANCE,
    "",
    "baton tools:",
    "- ask_human: ask only for judgment calls, decisions or missing information you could not investigate yourself. Provide a clear question and useful options; a blocking call waits for the answer and then you continue in the same turn. If it returns no_answer_yet, continue elsewhere or end your turn; the answer arrives later as a <baton-answer>. Do not use the human as a search tool.",
    "- If send returns status escalated, end your turn and wait for the human's round-limit decision.",
    "- list_agents: who you can delegate to (all models, modes, notes, current load).",
    "- form_team: lead only, dynamic runs; define the smallest useful team with roles, responsibilities and file ownership. get_team: current roster and assignments.",
    "- replace_member: lead only; swap a failing, stalled or poorly matched member and reassign its unfinished work. reassign: move one of your own assignments to another role or agent.",
    "- delegate: hand a self-contained task to another agent. Returns immediately. The delegate cannot see your conversation, so give it the goal, the relevant context and file paths, the files it owns, the interfaces it must respect, and acceptance criteria.",
    "- Results arrive automatically in a <baton-results> message when a delegate finishes. Do not poll. If you have nothing else to do, end your turn; you will be woken up with the results.",
    "- wait: block up to 50 s for results, only when you cannot continue without them.",
    "- get_result: full result of one delegation (notifications may be truncated).",
    "- send: follow-up instruction or answer to one of your delegates. cancel: stop a delegate and everything below it. status: overview of your delegations.",
    `If these tools are not directly visible to you (deferred tools), load them first, for example with a tool search for: ${BATON_TOOL_NAMES.map((t) => `mcp__baton__${t}`).join(",")}.`,
  ];
  if (agents.length > 0) {
    lines.push("", "Agents available on this machine right now:", ...agents.map(describeAgent));
  }
  lines.push(
    "",
    canDelegate
      ? `Your delegation depth is ${node.depth}; delegation is allowed down to depth ${policy.maxDepth}, with at most ${policy.maxActiveChildren} active delegates per agent.`
      : `You are at the maximum delegation depth (${policy.maxDepth}): do the work yourself.`,
    "You may only operate on delegations you created. Never give two delegates the same files, and never delegate the same task twice (check status first).",
  );
  if (isRoot && canDelegate) {
    lines.push(
      "",
      `Collaboration mode: ${mode.toUpperCase()}. You are the lead of this run.`,
      "Only a question, or a change confined to one small existing file, may be done by you alone.",
      "Anything that creates or changes two or more files, or has two or more deliverables (e.g. code + tests + docs), is NOT trivial: you must build a team and delegate the implementation, even if you could do it faster yourself. The human chose this collaboration mode because they want the work split across agents; had they wanted you to work alone they would have chosen solo mode. Doing the implementation yourself in this mode is a failure of the mode.",
      "For such work:",
      "1. Inspect enough to plan the architecture and shared interfaces. Define contracts yourself when parallel parts depend on them.",
      mode === "dynamic"
        ? "2. Call form_team first: choose the smallest team that parallelizes the work, pick agents and models by their strengths from list_agents, and give every role responsibilities, deliverables and exclusive file ownership. Then delegate by role in parallel."
        : "2. Use the preset roster below. Delegate only by role, at every depth; direct agent delegation is not allowed.",
      `Team size limit: ${policy.maxTeamSize ?? 5}. Reuse existing members first before adding another role. Write responsibilities as routing contracts: "Send me: …; don't send me: …".`,
      "3. Coordinate while members work. Never assign overlapping files. End your turn when waiting; results arrive automatically.",
      "4. If a member fails, stalls, or is a poor fit, use replace_member or reassign proactively. Integrate the returned work, verify the whole, and use send for fixes. Answer the human with what was done by whom.",
    );
  } else if (canDelegate) {
    lines.push(
      "",
      "Delegate when part of your work is separable and benefits from parallel work, a second opinion, or a different agent's strengths. Do it yourself when it is small or tightly coupled to what you are doing.",
    );
  }
  if (policy.teamApproval !== false) lines.push("", "Roster approval is required: agent-proposed formation, additions and replacements return pending_approval plus proposalId. After proposing, end your turn and wait for the human's decision in a <baton-notice>; do not submit a second proposal. Any tasks assigned to pending roles remain queued until approval. The human can edit or reject your roster; use the approved specs and feedback.");
  if (roster) lines.push("", "Current team roster (respect file ownership):", roster);
  if (mode === "preset") lines.push("Preset rule: all delegation at every depth requires a team role. Use get_team for the current roster.");
  if (!isRoot && node.role) lines.push("", `Your team role: ${node.role}.`, `Your responsibilities: ${team?.members.find((m) => m.id === node.memberId)?.responsibilities ?? "Follow your assignment."}`, "Other roles own the files and responsibilities in the roster above; avoid file clashes.");
  if (isRoot) {
    lines.push("", "You are the root agent: answer the human directly. Do not call report_result.");
  } else {
    lines.push(
      "",
      "You are a delegate. Your assignment arrives in a <baton-assignment> message. Stay within its scope and the files it gives you.",
      "When done, call report_result exactly once (status success / partial / failed, a plain-text summary of what you did, what you found and what is left, plus `result` and `artifacts` when useful), then end your turn.",
      "If the assignment is read-only, do not modify files.",
      "Modify only the files assigned to you. Do not run git commit, push, merge, rebase, checkout, reset or stash; the lead handles integration.",
      "Investigate missing information in the workspace and available tools before using ask_human; ask only when a human judgment is needed.",
    );
  }
  return lines.join("\n");
}

export function briefPrompt(d: DelegationRecord): string {
  const parts = [`<${ASSIGNMENT_TAG} delegation="${d.id}">`, `Title: ${d.brief.title}`, ...(d.role ? [`Role: ${d.role}`] : []), "", "Task:", d.brief.task];
  if (d.brief.context) parts.push("", "Context:", d.brief.context);
  if (d.brief.acceptance?.length) {
    parts.push("", "Acceptance criteria:", ...d.brief.acceptance.map((a) => `- ${a}`));
  }
  if (d.brief.readonly) parts.push("", "READ ONLY: do not modify any files. Inspect, analyse and report only.");
  if (d.brief.outputSchema) {
    parts.push("", "Your report_result `result` must match this JSON Schema:", JSON.stringify(d.brief.outputSchema));
  }
  parts.push("", "When finished, call report_result once, then end your turn.", `</${ASSIGNMENT_TAG}>`);
  return parts.join("\n");
}

const INLINE_LIMIT = 8000;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** One <result> block per delegation; the console keys its cards on the `delegation` attribute. */
export function resultsPrompt(delegations: DelegationRecord[]): string {
  const blocks = delegations.map((d) => {
    const r = d.result;
    const outcome = r?.status ?? (d.status === "completed" ? "success" : "failed");
    const head = `<result delegation="${d.id}" status="${d.status}" outcome="${outcome}" title="${escapeAttr(d.brief.title)}">`;
    const body: string[] = [];
    if (r) {
      body.push(r.summary.trim() || "(no summary)");
      if (r.error) body.push("", `Error: ${r.error}`);
      if (r.result !== undefined) body.push("", "Result:", JSON.stringify(r.result, null, 2));
      if (r.artifacts?.length) {
        body.push("", "Artifacts:", ...r.artifacts.map((a) => `- ${a.kind}: ${a.value}${a.description ? ` — ${a.description}` : ""}`));
      }
      if (!r.reported) body.push("", "(The delegate did not call report_result; the summary is its final message.)");
    } else {
      body.push(`The delegation ended with status ${d.status} and no result.`);
    }
    let text = body.join("\n");
    if (text.length > INLINE_LIMIT) {
      text = `${text.slice(0, INLINE_LIMIT)}\n[Truncated. Call get_result with delegationId "${d.id}" for the full result.]`;
    }
    return `${head}\n${text}\n</result>`;
  });
  return `<${RESULTS_TAG}>\n${blocks.join("\n\n")}\n</${RESULTS_TAG}>`;
}

export function correctionPrompt(errors: string[]): string {
  return [
    "Your report_result `result` does not match the required JSON Schema:",
    ...errors.map((e) => `- ${e}`),
    "Fix it and call report_result again with a valid result, then end your turn.",
  ].join("\n");
}
