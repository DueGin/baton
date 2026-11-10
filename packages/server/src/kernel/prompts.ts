import type { DelegationRecord, NodeRecord, RunPolicy } from "@baton/protocol";

/** Machine-readable tags the console parses (see packages/web transcript rendering). */
export const ASSIGNMENT_TAG = "baton-assignment";
export const RESULTS_TAG = "baton-results";

export function systemPrompt(node: Pick<NodeRecord, "id" | "depth" | "parentNodeId">, policy: RunPolicy): string {
  const isRoot = node.parentNodeId === null;
  const canDelegate = node.depth < policy.maxDepth;
  const lines = [
    "You are running inside baton, a local multi-agent workspace. Other coding agents on this machine (possibly from other vendors) can take work from you.",
    "",
    "Delegation tools (MCP server `baton`):",
    "- list_agents: who you can delegate to (models, modes, notes, load).",
    "- delegate: hand a self-contained task to another agent. Returns immediately. The delegate cannot see your conversation, so include the goal, relevant context, file paths and acceptance criteria.",
    "- Results arrive automatically in a <baton-results> message when a delegate finishes. Do not poll. End your turn if you have nothing else to do; you will be woken up with the results.",
    "- wait: block up to 50 s for results, only when you cannot continue without them.",
    "- get_result: full result of one delegation (notifications may be truncated).",
    "- send: follow-up instruction or answer to one of your delegates. cancel: stop a delegate and everything below it. status: overview of your delegations.",
    "",
    "Delegate when a task is separable and benefits from parallel work, a second opinion, or a different agent's strengths. Do the work yourself when it is small or tightly coupled to what you are doing. Never delegate the same task twice; check status first.",
    "You may only operate on delegations you created.",
  ];
  lines.push(
    canDelegate
      ? `Your delegation depth is ${node.depth}; you may delegate down to depth ${policy.maxDepth}.`
      : `You are at the maximum delegation depth (${policy.maxDepth}); do the work yourself.`,
  );
  if (isRoot) {
    lines.push("", "You are the root agent: answer the human directly. Do not call report_result.");
  } else {
    lines.push(
      "",
      "You are a delegate. Your assignment arrives in a <baton-assignment> message.",
      "When done, call report_result exactly once (status success / partial / failed, a plain-text summary of what you did, what you found and what is left, plus `result` and `artifacts` when useful), then end your turn.",
      "If the assignment is read-only, do not modify files.",
    );
  }
  return lines.join("\n");
}

export function briefPrompt(d: DelegationRecord): string {
  const parts = [`<${ASSIGNMENT_TAG} delegation="${d.id}">`, `Title: ${d.brief.title}`, "", "Task:", d.brief.task];
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
