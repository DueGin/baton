import type { DelegationRecord } from "@baton/protocol";
export const SYSTEM_PROMPT = `You are running in baton. Use the baton MCP tools list_agents, delegate, wait, get_result, send, cancel, status and report_result for native delegation. Delegate self-contained tasks, including context and acceptance criteria. Results arrive automatically in <baton-results> messages: do not poll. wait is bounded to 50 seconds; use it only when blocked. You may operate only your own direct child delegations. Child agents must call report_result once with their final result and then end their turn. Root agents must answer the human instead of calling report_result. Use get_result for full results omitted from notifications.`;
export function briefPrompt(d: DelegationRecord): string {
  return `<baton-assignment delegation="${d.id}">\nTitle: ${d.brief.title}\nTask: ${d.brief.task}${d.brief.context ? `\nContext: ${d.brief.context}` : ""}${d.brief.acceptance ? `\nAcceptance criteria:\n${d.brief.acceptance.map((a) => `- ${a}`).join("\n")}` : ""}${d.brief.readonly ? "\nREAD ONLY: Do not modify files. You may inspect and plan only." : ""}${d.brief.outputSchema ? `\nReport structured result matching this JSON Schema: ${JSON.stringify(d.brief.outputSchema)}` : ""}\nCall report_result, then end your turn.\n</baton-assignment>`;
}
export function resultsPrompt(delegations: DelegationRecord[]): string {
  return `<baton-results>\n${delegations.map((d) => {
    const text = JSON.stringify({ delegationId: d.id, title: d.brief.title, status: d.status, result: d.result });
    return text.length > 8000 ? `${text.slice(0, 7800)}\n[Result truncated; use get_result with delegationId ${d.id} for the full result.]` : text;
  }).join("\n\n")}\n</baton-results>`;
}
export function correctionPrompt(errors: string[]): string {
  return `Your structured result did not satisfy outputSchema: ${errors.join("; ")}. Correct it and call report_result again with a valid result, then end your turn.`;
}
