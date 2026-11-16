import { describe, expect, it } from "vitest";
import type { ItemRecord, ToolCallDetail } from "@baton/protocol";
import { agentMessageDemo } from "../demo/messages.js";
import { parseBatonMessage } from "./baton-messages.js";
import { partAgentCards, toolAgentCard } from "./agent-messages.js";
const base = Date.parse("2026-11-10T07:00:00Z"); const { snapshot, items } = agentMessageDemo(base);
const root = snapshot.nodes[0]!; const api = snapshot.delegations.find(edge => edge.role === "backend")!;
const child = snapshot.nodes.find(node => node.id === api.toNodeId)!;
function tool(name: string, detail: ToolCallDetail, node = root): ItemRecord { return { nodeId: node.id, seq: 80, ts: new Date(base).toISOString(), item: { type: "tool_call", callId: "test", name, status: "completed", detail } }; }
describe("agent-to-agent message mapping", () => {
  it("maps every required parent/child artifact with correct counterparts", () => {
    const cards = items.flatMap(row => {
      const node = snapshot.nodes.find(node => node.id === row.nodeId)!;
      if (row.item.type === "user_message") return (parseBatonMessage(row.item.text) ?? []).flatMap((part, index) => partAgentCards(part, row, node, snapshot, index));
      const card = toolAgentCard(row, node, snapshot); return card ? [card] : [];
    });
    expect(new Set(cards.map(card => card.kind))).toEqual(new Set(["delegate", "send", "reassign", "result", "notice", "assignment", "followup", "report_result"]));
    for (const kind of ["delegate", "send", "result"] as const) expect(cards.find(card => card.kind === kind)!.counterpart.nodeId).toBe(child.id);
    for (const kind of ["assignment", "followup", "report_result"] as const) expect(cards.find(card => card.kind === kind)!.counterpart.nodeId).toBe(root.id);
    expect(cards.find(card => card.kind === "assignment")?.heading).toBe("来自 Lead 的任务");
    expect(cards.find(card => card.kind === "followup")?.heading).toBe("Lead 追问");
    expect(cards.find(card => card.kind === "result")?.title).toBe(api.result!.summary.split("\n")[0]);
    expect(cards.filter(card => card.kind === "result").map(card => card.outcome)).toEqual(["success", "partial", "failed"]);
    expect(cards.find(card => card.kind === "report_result")).toMatchObject({ title: "搜索 API 与中文短词测试通过。", outcome: "success", body: { type: "result" } });
    expect(cards.find(card => card.kind === "delegate")!.body.type).toBe("assignment");
    expect(cards.filter(card => card.kind === "notice").map(card => card.heading)).toEqual(["团队通知", "系统通知", "系统纠正"]);
  });
  it("uses the original replaced child for historical messages and the successor for reassignment", () => {
    const old = snapshot.delegations.find(edge => edge.replacedBy)!;
    const reassign = toolAgentCard(tool("mcp__baton__reassign", { type: "baton", tool: "reassign", input: { delegationId: old.id, reason: "接手" } }), root, snapshot)!;
    expect(reassign.counterpart.nodeId).toBe(snapshot.delegations.find(edge => edge.id === old.replacedBy)!.toNodeId);
    const send = toolAgentCard(tool("mcp__baton__send", { type: "baton", tool: "send", input: { delegationId: old.id, message: "旧的追问" } }), root, snapshot)!;
    expect(send.counterpart).toMatchObject({ nodeId: old.toNodeId, status: "replaced" });
  });
  it("resolves a nested child's direct parent rather than the root and preserves its role/model", () => {
    const nestedEdge = snapshot.delegations.find(edge => edge.fromNodeId === child.id)!; const nested = snapshot.nodes.find(node => node.id === nestedEdge.toNodeId)!;
    const followup = { type: "followup" as const, delegationId: nestedEdge.id, text: "请验证 tokenizer" };
    const row: ItemRecord = { nodeId: nested.id, seq: 77, ts: nested.createdAt, item: { type: "user_message", text: "" } };
    expect(partAgentCards(followup, row, nested, snapshot)[0]).toMatchObject({ heading: `${child.role} 追问`, counterpart: { nodeId: child.id, role: child.role, agentId: child.agentId, model: child.model } });
    const report = tool("mcp__baton__report_result", { type: "baton", tool: "report_result", input: { status: "failed", summary: "tokenizer 不支持" } }, nested);
    expect(toolAgentCard(report, nested, snapshot)?.counterpart.nodeId).toBe(child.id);
  });
  it("resolves normalized, unknown namespaced and wrapped MCP outputs, tolerating reserved node IDs", () => {
    const detail: ToolCallDetail = { type: "unknown", input: { title: "实现", task: "检查", role: "backend" }, output: { structuredContent: { delegationId: api.id } } };
    expect(toolAgentCard(tool("mcp__baton__delegate", detail), root, snapshot)?.counterpart.nodeId).toBe(child.id);
    const mcp = { ...detail, output: { content: [{ type: "text", text: JSON.stringify({ delegationId: api.id }) }] } };
    expect(toolAgentCard(tool("baton__delegate", mcp), root, snapshot)?.counterpart.nodeId).toBe(child.id);
    const reserved = { ...snapshot, nodes: snapshot.nodes.filter(node => node.id !== child.id), delegations: snapshot.delegations.map(edge => edge.id === api.id ? { ...edge, status: "queued" as const, toNodeId: "not-created" } : edge) };
    expect(toolAgentCard(tool("mcp__baton__delegate", detail), root, reserved)?.counterpart).toMatchObject({ agentId: "codex", role: "backend", status: "queued" });
    expect(toolAgentCard(tool("mcp__baton__delegate", detail), root, reserved)?.counterpart.nodeId).toBeUndefined();
    const pending = tool("mcp__baton__delegate", { type: "baton", tool: "delegate", input: { title: "新任务", task: "实现", role: "new-role", agent: "kimi", model: "k2" }, output: { status: "pending_approval", proposalId: "p" } });
    expect(toolAgentCard(pending, root, snapshot)?.counterpart).toMatchObject({ role: "new-role", agentId: "kimi", model: "k2", status: "queued" });
  });
  it("does not turn human answers or ordinary tools into agent cards", () => {
    const human = items.find(row => row.item.type === "user_message" && row.item.text.includes("baton-answer"))!;
    expect(partAgentCards(parseBatonMessage(human.item.type === "user_message" ? human.item.text : "")![0]!, human, child, snapshot)).toEqual([]);
    expect(toolAgentCard(tool("ToolSearch", { type: "unknown", input: { query: "baton" }, output: null }), root, snapshot)).toBeNull();
    expect(toolAgentCard(tool("delegate", { type: "unknown", input: {}, output: null }), root, snapshot)).toBeNull();
  });
  it("keeps failed tool content as escaped detail rather than reporting a false successful result", () => {
    const row = tool("mcp__baton__report_result", { type: "baton", tool: "report_result", input: { summary: "失败后修正", status: "failed" } }, child);
    if (row.item.type === "tool_call") row.item.error = "Schema invalid";
    expect(toolAgentCard(row, child, snapshot)).toMatchObject({ outcome: "failed", body: { type: "text", error: "Schema invalid" } });
  });
});
