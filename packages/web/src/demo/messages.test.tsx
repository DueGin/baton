import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoClient } from "./client.js";
import { TranscriptRow } from "../components/Transcript.js";
import { agentCardPreferences } from "../lib/agent-card-preferences.js";
const now = Date.parse("2026-11-10T07:00:00Z");
afterEach(() => agentCardPreferences.setDefault(false));
describe("agent message demo transcript", () => {
  it("has every artifact as a compact card with raw rows hidden and human answers left in bubbles", async () => {
    const client = new DemoClient(() => now); const snapshot = await client.run("run-agent-messages");
    let all = "";
    for (const node of snapshot.nodes) {
      const { items } = await client.items(node.id);
      all += items.map(row => renderToStaticMarkup(<TranscriptRow row={row} node={node} snapshot={snapshot} inspect={() => undefined} />)).join("");
    }
    for (const kind of ["delegate", "send", "send_message", "reassign", "result", "notice", "assignment", "followup", "message", "report_result"]) expect(all).toContain(`data-agent-card="${kind}"`);
    expect(all.match(/data-agent-card="result"/g)).toHaveLength(3);
    for (const raw of ["baton-followup", "baton-results", "baton-assignment", "mcp__baton__send", "mcp__baton__delegate", "baton-notice"]) expect(all).not.toContain(raw);
    // The <baton-message> wrapper only survives inside the collapsed raw call detail / copy text, never as visible text.
    const visible = all.replace(/<pre>[\s\S]*?<\/pre>/g, "").replace(/<[^>]+>/g, " ");
    expect(visible).not.toContain("baton-message"); expect(visible).not.toContain("from=");
    // A session message keeps its origin visible and jumps to that session's run.
    expect(all).toContain("收到会话消息"); expect(all).toContain("发送消息给"); expect(all).toContain("Atlas · Agent 消息 · 派活、追问与结果");
    expect(all).toContain("系统纠正"); expect(all).toContain("human-answer"); expect(all).toContain("优先验证跨项目访问权限");
    expect(all).toContain('aria-expanded="false"'); expect(all).not.toContain('aria-expanded="true"');
    expect(all).toContain("ToolSearch ·"); expect(all).not.toContain("unknown unknown");
    agentCardPreferences.setDefault(true);
    const root = snapshot.nodes[0]!; const rootRows = (await client.items(root.id)).items;
    const expanded = rootRows.map(row => renderToStaticMarkup(<TranscriptRow row={row} node={root} snapshot={snapshot} />)).join("");
    expect(expanded).toContain("Result JSON"); expect(expanded).toContain("Artifacts"); expect(expanded).toContain("Output schema");
  });
});
