import type { DelegationRecord, ItemRecord, NodeRecord, RunSnapshot, ToolCallDetail } from "@baton/protocol";
import type { AssignmentMessage, BatonMessagePart, DeliveredResult } from "./baton-messages.js";
import { displayStatus } from "./derive.js";

export interface AgentCounterpart { nodeId?: string; role: string; agentId: string; model?: string; status: string; title?: string }
export interface AgentCardData {
  id: string; kind: "delegate" | "send" | "reassign" | "result" | "assignment" | "followup" | "report_result" | "notice";
  heading: string; title: string; ts: string; counterpart: AgentCounterpart; outcome?: "success" | "partial" | "failed";
  body: { type: "assignment"; assignment: AssignmentMessage } | { type: "result"; result: DeliveredResult } | { type: "text"; text: string; detail?: ToolCallDetail; error?: string };
  copyText: string;
}
export function firstLine(text: string, fallback = "消息"): string { return text.split(/\r?\n/).find(line => line.trim())?.trim() ?? fallback; }
function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return record(JSON.parse(value)); } catch { return {}; } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const fields = value as Record<string, unknown>;
  if (fields.structuredContent) { const parsed = record(fields.structuredContent); if (Object.keys(parsed).length) return parsed; }
  if (Array.isArray(fields.content)) {
    for (const entry of fields.content) { const text = entry && typeof entry === "object" && "text" in entry ? entry.text : undefined; if (typeof text === "string") { const parsed = record(text); if (Object.keys(parsed).length) return parsed; } }
  }
  return fields;
}
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
export function counterpart(node: NodeRecord | undefined, snapshot?: RunSnapshot, fallback?: Partial<AgentCounterpart>): AgentCounterpart {
  if (node) return { nodeId: node.id, role: node.role ?? (node.parentNodeId ? "Agent" : "Lead"), agentId: node.agentId, model: node.model, status: snapshot ? displayStatus(node, snapshot) : node.status, title: node.title };
  return { role: "Agent", agentId: "generic", status: "queued", ...fallback };
}
function child(edge: DelegationRecord | undefined, snapshot?: RunSnapshot, fallback?: Partial<AgentCounterpart>): AgentCounterpart {
  const member = edge ? snapshot?.run.team?.members.find(member => member.id === edge.memberId || !edge.memberId && member.role === edge.role) : undefined;
  return counterpart(snapshot?.nodes.find(node => node.id === edge?.toNodeId), snapshot, { role: edge?.role ?? member?.role ?? fallback?.role ?? "Agent", agentId: member?.agentId ?? fallback?.agentId ?? "generic", model: member?.model ?? fallback?.model, status: edge?.status ?? "queued", title: edge?.brief.title });
}
function parent(node: NodeRecord, snapshot?: RunSnapshot, edge?: DelegationRecord): AgentCounterpart {
  return counterpart(snapshot?.nodes.find(entry => entry.id === (edge?.fromNodeId ?? node.parentNodeId)), snapshot, { role: "Lead" });
}
export function partAgentCards(part: BatonMessagePart, row: ItemRecord, node: NodeRecord, snapshot?: RunSnapshot, partIndex = 0): AgentCardData[] {
  const id = `${row.nodeId}:${row.seq}:part:${partIndex}`; const base = { ts: row.ts };
  if (part.type === "text" || part.type === "answer") return [];
  if (part.type === "notice") return [{ ...base, id, kind: "notice", heading: part.kind === "correction" ? "系统纠正" : part.kind === "system" ? "系统通知" : "团队通知", title: firstLine(part.text), counterpart: { role: part.kind === "team" || !part.kind ? "团队" : "系统", agentId: "generic", status: "idle" }, body: { type: "text", text: part.text }, copyText: part.text }];
  if (part.type === "results") return part.results.map((result, index) => ({ ...base, id: `${id}:result:${index}:${result.delegationId}`, kind: "result", heading: "收到结果", title: firstLine(result.summary, result.title), outcome: result.outcome, counterpart: child(snapshot?.delegations.find(edge => edge.id === result.delegationId), snapshot), body: { type: "result", result }, copyText: [result.summary, result.resultText, result.artifactsText, result.note].filter(Boolean).join("\n\n") }));
  const edge = snapshot?.delegations.find(edge => edge.id === part.delegationId); const from = parent(node, snapshot, edge);
  if (part.type === "assignment") return [{ ...base, id, kind: "assignment", heading: `来自 ${from.role} 的任务`, title: part.title, counterpart: from, body: { type: "assignment", assignment: part }, copyText: [part.title, part.task, part.context, ...part.acceptance, part.outputSchema].filter(Boolean).join("\n\n") }];
  return [{ ...base, id, kind: "followup", heading: `${from.role} 追问`, title: firstLine(part.text), counterpart: from, body: { type: "text", text: part.text }, copyText: part.text }];
}
/** Providers may supply a normalized baton detail or a namespaced MCP call with unknown detail. */
export function toolAgentCard(row: ItemRecord, node: NodeRecord, snapshot?: RunSnapshot): AgentCardData | null {
  if (row.item.type !== "tool_call") return null;
  const item = row.item; const detail = item.detail;
  const tool = detail.type === "baton" ? detail.tool : /(?:^mcp__baton__|^baton(?:__|[._/]))/.test(item.name) ? item.name.replace(/^(?:mcp__baton__|baton(?:__|[._/]))/, "") : "";
  if (!["delegate", "send", "reassign", "report_result"].includes(tool)) return null;
  const input = record("input" in detail ? detail.input : undefined); const output = record("output" in detail ? detail.output : undefined);
  const outputEdge = record(output.delegation); const outputId = string(output.delegationId) ?? string(outputEdge.id) ?? (tool === "reassign" ? string(output.id) : undefined);
  const inputId = string(input.delegationId) ?? (detail.type === "baton" ? detail.delegationId : undefined);
  let edge = snapshot?.delegations.find(edge => edge.id === (tool === "send" ? inputId ?? outputId : outputId ?? inputId));
  if (tool === "reassign" && !outputId && edge?.replacedBy) edge = snapshot?.delegations.find(next => next.id === edge!.replacedBy) ?? edge;
  if (!edge && tool === "report_result") edge = snapshot?.delegations.find(edge => edge.id === node.delegationId);
  const to = tool === "report_result" ? parent(node, snapshot, edge) : child(edge, snapshot, { role: string(input.role), agentId: string(input.agent), model: string(input.model) });
  const text = tool === "send" ? string(input.message) ?? "追问" : tool === "report_result" ? string(input.summary) ?? edge?.result?.summary ?? "交付结果" : edge?.brief.title ?? string(input.title) ?? (tool === "delegate" ? "委派任务" : "改派任务");
  const bodyText = tool === "send" ? text : tool === "report_result" ? text : tool === "reassign" ? string(input.reason) ?? edge?.replaceReason ?? text : string(input.task) ?? edge?.brief.task ?? text;
  const outcome = input.status === "success" || input.status === "partial" || input.status === "failed" ? input.status : tool === "report_result" ? edge?.result?.status : undefined;
  let body: AgentCardData["body"] = { type: "text", text: bodyText, detail, error: item.error };
  if (tool === "delegate" && !item.error) body = { type: "assignment", assignment: { type: "assignment", delegationId: edge?.id ?? outputId ?? "", title: text, task: bodyText, context: string(input.context) ?? edge?.brief.context, acceptance: Array.isArray(input.acceptance) ? input.acceptance.filter((value): value is string => typeof value === "string") : edge?.brief.acceptance ?? [], readonly: typeof input.readonly === "boolean" ? input.readonly : Boolean(edge?.brief.readonly), outputSchema: input.outputSchema ? JSON.stringify(input.outputSchema, null, 2) : edge?.brief.outputSchema ? JSON.stringify(edge.brief.outputSchema, null, 2) : undefined } };
  if (tool === "report_result" && !item.error) body = { type: "result", result: { delegationId: edge?.id ?? "", title: edge?.brief.title ?? text, status: item.status, outcome: outcome ?? "success", summary: text, resultText: input.result !== undefined ? JSON.stringify(input.result, null, 2) : undefined, artifactsText: Array.isArray(input.artifacts) ? input.artifacts.map(artifact => { const value = record(artifact); return `- ${string(value.kind) ?? "note"}: ${string(value.value) ?? ""}${value.description ? ` — ${String(value.description)}` : ""}`; }).join("\n") : undefined } };
  return { id: `${row.nodeId}:${row.seq}:tool`, kind: tool as AgentCardData["kind"], heading: ({ delegate: "派活给", send: "追问", reassign: "改派给", report_result: "交付结果给" } as Record<string, string>)[tool]!, title: firstLine(text), counterpart: to, ts: row.ts, outcome, body, copyText: [bodyText, JSON.stringify(input, null, 2), JSON.stringify(output, null, 2), item.error].filter(Boolean).join("\n\n") };
}
export const outcomeIcons = { success: "✓", partial: "◐", failed: "✗" };
