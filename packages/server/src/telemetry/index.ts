import { createHash } from "node:crypto";
import type { RunSnapshot, UsageTotals } from "@baton/protocol";
import type { Store } from "../store/index.js";
export type ExportFormat = "json" | "md" | "otlp";
export function exportRun(store: Store, id: string, format: ExportFormat): string {
  const s = store.snapshot(id);
  if (format === "json") return JSON.stringify({ version: 1, snapshot: s, events: store.events(id), items: s.nodes.flatMap((n) => store.items(n.id)) }, null, 2);
  if (format === "otlp") return JSON.stringify(otlp(s), null, 2);
  if (format !== "md") throw new Error("Unknown export format");
  const lines = [`# ${s.run.title}`, "", `Run: ${id} · ${s.run.status}`, `Working directory: ${s.run.cwd}`, "", "## Delegation tree", ""];
  const walk = (parent: string | null, depth: number): void => {
    for (const n of s.nodes.filter((n) => n.parentNodeId === parent)) { lines.push(`${"  ".repeat(depth)}- **${n.title}** (${n.agentId}) — ${n.status}`); walk(n.id, depth + 1); }
  }; walk(null, 0);
  for (const d of s.delegations) {
    lines.push("", `## ${d.brief.title}`, "", d.brief.task);
    if (d.brief.context) lines.push("", `Context: ${d.brief.context}`);
    if (d.brief.acceptance) lines.push("", ...d.brief.acceptance.map((a) => `- ${a}`));
    if (d.result) { lines.push("", `Result (${d.result.status}, ${d.result.reported ? "reported" : "final-message fallback"}):`, "", d.result.summary); if (d.result.result !== undefined) lines.push("", "```json", JSON.stringify(d.result.result, null, 2), "```"); for (const artifact of d.result.artifacts ?? []) lines.push(`- ${artifact.kind}: ${artifact.value}${artifact.description ? ` — ${artifact.description}` : ""}`); }
  }
  lines.push("", "## Usage", "", "| Node | Agent | Input tokens | Cached | Output tokens | Cost USD |", "| --- | --- | ---: | ---: | ---: | ---: |");
  for (const n of s.nodes) lines.push(`| ${n.title.replaceAll("|", "\\|")} | ${n.agentId} | ${n.usage.inputTokens} | ${n.usage.cachedInputTokens} | ${n.usage.outputTokens} | ${n.usage.costUsd.toFixed(6)} |`);
  lines.push(`| **Total** | | ${s.run.usage.inputTokens} | ${s.run.usage.cachedInputTokens} | ${s.run.usage.outputTokens} | ${s.run.usage.costUsd.toFixed(6)} |`, "");
  return lines.join("\n");
}
function hash(value: string, length: number): string { return createHash("sha256").update(value).digest("hex").slice(0, length); }
function otlp(s: RunSnapshot): unknown {
  const traceId = hash(s.run.id, 32), timestamp = new Date().toISOString();
  const nano = (date: string): string => (BigInt(Date.parse(date)) * 1000000n).toString();
  const attributes = (input: Record<string, string | number | boolean | undefined>): unknown[] => Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => ({ key, value: typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : { doubleValue: value } }));
  const usage = (u: UsageTotals): Record<string, number> => ({ "gen_ai.usage.input_tokens": u.inputTokens, "gen_ai.usage.output_tokens": u.outputTokens, "gen_ai.usage.cached_input_tokens": u.cachedInputTokens, "baton.cost_usd": u.costUsd });
  const span = (id: string, parent: string | undefined, name: string, start: string, end: string | undefined, attrs: Record<string, string | number | boolean | undefined>, failed = false): unknown => ({ traceId, spanId: hash(id, 16), ...(parent ? { parentSpanId: hash(parent, 16) } : {}), name, kind: 1, startTimeUnixNano: nano(start), endTimeUnixNano: nano(end ?? timestamp), attributes: attributes(attrs), status: { code: failed ? 2 : end ? 1 : 0 } });
  const spans = [
    ...s.nodes.map((n) => span(n.id, n.parentNodeId ?? undefined, `invoke_agent ${n.agentId}`, n.createdAt, n.endedAt, { "gen_ai.operation.name": "invoke_agent", "gen_ai.system": n.agentId, "gen_ai.request.model": n.model, "baton.node.id": n.id, "baton.status": n.status, ...usage(n.usage) }, n.status === "failed")),
    ...s.turns.map((t) => span(t.id, t.nodeId, `turn ${t.trigger}`, t.startedAt, t.endedAt, { "baton.turn.trigger": t.trigger, "gen_ai.usage.input_tokens": t.usage?.inputTokens, "gen_ai.usage.output_tokens": t.usage?.outputTokens, "baton.status": t.status }, t.status === "failed")),
    ...s.toolSpans.map((t) => span(t.id, t.turnId ?? t.nodeId, `execute_tool ${t.name}`, t.startedAt, t.endedAt, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": t.name, "gen_ai.tool.call.id": t.callId, "baton.status": t.status }, t.status === "failed")),
  ];
  return { resourceSpans: [{ resource: { attributes: attributes({ "service.name": "baton", "service.version": "0.1.0" }) }, scopeSpans: [{ scope: { name: "baton", version: "0.1.0" }, spans }] }] };
}
