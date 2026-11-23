import type { DelegationRecord, RunRecord } from "@baton/protocol";
import type { NoticeKind } from "../lib/baton-messages.js";

/** Browser-only mirrors of server/kernel/prompts.ts; parity is verified in web tests. */
export function demoBriefPrompt(d: DelegationRecord): string {
  const parts = [`<baton-assignment delegation="${d.id}">`, `Title: ${d.brief.title}`, ...(d.role ? [`Role: ${d.role}`] : []), "", "Task:", d.brief.task];
  if (d.brief.context) parts.push("", "Context:", d.brief.context);
  if (d.brief.acceptance?.length) parts.push("", "Acceptance criteria:", ...d.brief.acceptance.map(value => `- ${value}`));
  if (d.brief.readonly) parts.push("", "READ ONLY: do not modify any files. Inspect, analyse and report only.");
  if (d.brief.outputSchema) parts.push("", "Your report_result `result` must match this JSON Schema:", JSON.stringify(d.brief.outputSchema));
  parts.push("", "When finished, call report_result once, then end your turn.", "</baton-assignment>");
  return parts.join("\n");
}
const escapeAttr = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
export function demoFollowupPrompt(delegationId: string, message: string): string {
  return `<baton-followup delegation="${escapeAttr(delegationId)}">\n${message}\n</baton-followup>`;
}
export function demoNoticePrompt(kind: NoticeKind, message: string): string {
  return `<baton-notice kind="${kind}">\n${message}\n</baton-notice>`;
}
export const demoReviewReminder = "主导者请亲自验收：查看 diff，运行相关构建和测试，验证实际效果；不合格请打回。";
export function demoResultDelivery(results: string, run: RunRecord, recipient: string): string {
  return run.policy.mode !== "solo" && run.policy.leadReview && recipient === run.rootNodeId ? `${results}\n\n${demoNoticePrompt("policy", demoReviewReminder)}` : results;
}
export function demoResultsPrompt(delegations: DelegationRecord[]): string {
  const blocks = delegations.map(d => {
    const result = d.result;
    const outcome = result?.status ?? (d.status === "completed" ? "success" : "failed");
    const body: string[] = [];
    if (result) {
      body.push(result.summary.trim() || "(no summary)");
      if (result.error) body.push("", `Error: ${result.error}`);
      if (result.result !== undefined) body.push("", "Result:", JSON.stringify(result.result, null, 2));
      if (result.artifacts?.length) body.push("", "Artifacts:", ...result.artifacts.map(artifact => `- ${artifact.kind}: ${artifact.value}${artifact.description ? ` — ${artifact.description}` : ""}`));
      if (!result.reported) body.push("", "(The delegate did not call report_result; the summary is its final message.)");
    } else body.push(`The delegation ended with status ${d.status} and no result.`);
    let text = body.join("\n");
    if (text.length > 8000) text = `${text.slice(0, 8000)}\n[Truncated. Call get_result with delegationId "${d.id}" for the full result.]`;
    return `<result delegation="${d.id}" status="${d.status}" outcome="${outcome}" title="${escapeAttr(d.brief.title)}">\n${text}\n</result>`;
  });
  return `<baton-results>\n${blocks.join("\n\n")}\n</baton-results>`;
}
