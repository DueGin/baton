import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageCard, AgentMessagePreference } from "./AgentMessageCard.js";
import { AgentIcon, agentVendor, agentVendors } from "./AgentIcon.js";
import { agentCardPreferences } from "../lib/agent-card-preferences.js";
import { partAgentCards } from "../lib/agent-messages.js";
import { parseBatonMessage } from "../lib/baton-messages.js";
import { agentMessageDemo } from "../demo/messages.js";
const { snapshot, items } = agentMessageDemo(Date.parse("2026-11-10T07:00:00Z"));
const assignment = items.find(row => row.nodeId === snapshot.delegations[0]!.toNodeId && row.item.type === "user_message" && row.item.text.includes("baton-assignment"))!;
const part = parseBatonMessage(assignment.item.type === "user_message" ? assignment.item.text : "")![0]!;
const card = partAgentCards(part, assignment, snapshot.nodes.find(node => node.id === assignment.nodeId)!, snapshot)[0]!;
afterEach(() => { agentCardPreferences.setDefault(false); if (agentCardPreferences.getSnapshot().overrides.has(card.id) && agentCardPreferences.isOpen(card.id)) agentCardPreferences.toggle(card.id); });
describe("compact agent message card", () => {
  it("defaults to a collapsed one-row card with accessible controls and parent chips", () => {
    const html = renderToStaticMarkup(<AgentMessageCard card={{ ...card, id: "fresh-closed" }} inspect={() => undefined} />);
    for (const text of ['aria-expanded="false"', 'hidden=""', "来自 Lead 的任务", 'aria-label="查看 Lead 节点"', 'data-agent-vendor="claude"', 'aria-label="复制消息"', "agent-card-time"]) expect(html).toContain(text);
    expect(html).not.toContain("Context</h4>"); expect(html).not.toContain("baton-assignment");
  });
  it("renders Markdown and schema only when expanded and remembers manual choices on remount", () => {
    const value = { ...card, id: "toggle-test" }; agentCardPreferences.toggle(value.id);
    let html = renderToStaticMarkup(<AgentMessageCard card={value} />); expect(html).toContain('aria-expanded="true"'); expect(html).toContain("Context</h4>"); expect(html).toContain("Output schema");
    expect(renderToStaticMarkup(<AgentMessageCard card={value} />)).toContain('aria-expanded="true"');
    agentCardPreferences.toggle(value.id); agentCardPreferences.setDefault(true);
    html = renderToStaticMarkup(<AgentMessageCard card={value} />); expect(html).toContain('aria-expanded="false"');
    expect(renderToStaticMarkup(<AgentMessageCard card={{ ...card, id: "settings-default" }} />)).toContain('aria-expanded="true"');
    expect(renderToStaticMarkup(<AgentMessagePreference />)).toContain("agent 消息卡片默认展开");
  });
  it("shows all outcome icons, disables missing counterparts and escapes agent content", () => {
    for (const [outcome, icon] of [["success", "✓"], ["partial", "◐"], ["failed", "✗"]] as const) {
      const html = renderToStaticMarkup(<AgentMessageCard card={{ ...card, outcome, counterpart: { agentId: "unknown", role: "系统", status: "replaced" } }} />);
      expect(html).toContain(`aria-label="结果：${outcome}"`); expect(html).toContain(icon); expect(html).toContain("state-replaced"); expect(html).toContain('disabled=""');
    }
    agentCardPreferences.setDefault(true);
    const unsafe = renderToStaticMarkup(<AgentMessageCard card={{ ...card, id: "unsafe", title: '<img src=x onerror="bad()">', body: { type: "text", text: '<script>bad()</script>\n\n[bad](javascript:alert(1))' } }} />);
    expect(unsafe).not.toContain("<script>"); expect(unsafe).not.toContain("<img"); expect(unsafe).not.toContain('href="javascript:');
  });
});
describe("local vendor icon set", () => {
  it("has a mark for every vendor and a safe generic fallback", () => {
    for (const agent of agentVendors.filter(vendor => vendor !== "generic")) expect(renderToStaticMarkup(<AgentIcon agent={agent} />)).toContain(`data-agent-vendor="${agent}"`);
    expect(renderToStaticMarkup(<AgentIcon agent="generic" />)).toContain('data-agent-vendor="baton"');
    expect(agentVendor("fake-claude")).toBe("claude"); expect(agentVendor("openai/gpt-6")).toBe("codex"); expect(agentVendor("moonshot/k2")).toBe("kimi");
    expect(agentVendor("unrecognized-provider")).toBe("generic"); expect(renderToStaticMarkup(<AgentIcon agent='<img src=x>' />)).not.toContain("<img");
  });
});
