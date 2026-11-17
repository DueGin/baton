import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentCatalogRow, AgentsPage } from "./Agents.js";
import { AgentOptions, AgentPicker } from "./AgentPicker.js";
import { AgentFields, MembersEditor } from "./TeamForms.js";
import { AgentIcon, ModelIcon, agentVendor, agentVendors, modelVendor } from "./AgentIcon.js";
import { demoAgents } from "../demo/agents.js";
describe("expanded Agents UI", () => {
  it("renders four groups, search, install commands, capabilities, sources and version requirements", () => {
    const html = renderToStaticMarkup(<AgentsPage agents={demoAgents} refresh={() => undefined} refreshing={false} />);
    for (const text of ["已就绪", "版本过低或出错", "未安装", "已禁用", 'aria-label="搜索 Agents"', "30 个 agent", "重新检测", "Native", "ACP", "要求 ≥1.0.0", "models", "modes", "steer", "resume", "mcp", "reasoning", "自定义", "复制 Claude Code 安装命令", "npm i -g @anthropic-ai/claude-code", 'target="_blank" rel="noopener noreferrer"']) expect(html).toContain(text);
    expect(html.match(/data-agent-id=/g)).toHaveLength(30);
    const refreshing = renderToStaticMarkup(<AgentsPage agents={[]} refresh={() => undefined} refreshing />); expect(refreshing).toContain("检测中…"); expect(refreshing).toContain('disabled=""'); expect(refreshing).toContain('aria-busy="true"');
  });
  it("renders agent content as safe text and discards unsafe homepage URLs", () => {
    const html = renderToStaticMarkup(<AgentCatalogRow agent={{ ...demoAgents[0]!, label: "<script>bad()</script>", diagnostic: "<img src=x>", installHint: "echo '<svg onload=bad()>'", homepage: "javascript:bad()" }} />);
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<img"); expect(html).not.toContain("javascript:"); expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&lt;svg");
  });
  it("filters searchable options, keeps ready entries first and disables every unavailable entry", () => {
    const html = renderToStaticMarkup(<AgentOptions agents={[...demoAgents].reverse()} value="codex" choose={() => undefined} />);
    expect(html.indexOf("Claude Code")).toBeLessThan(html.indexOf("Gemini CLI"));
    const options = html.match(/<button[^>]*>[\s\S]*?<\/button>/g)!;
    for (const option of options) { if (["Gemini CLI", "Kimi CLI", "Cursor Agent"].some(label => option.includes(label))) expect(option).toContain('disabled=""'); }
    expect(renderToStaticMarkup(<AgentOptions agents={demoAgents} value="" query="GPT-5.3" choose={() => undefined} />)).toContain("Codex");
    expect(renderToStaticMarkup(<AgentOptions agents={demoAgents} value="" query="GPT-5.3" choose={() => undefined} />)).not.toContain("Claude Code");
  });
  it("uses shared searchable pickers in agent and member fields without an extra catalog link", () => {
    const picker = renderToStaticMarkup(<AgentPicker agents={demoAgents} value="codex" change={() => undefined} />);
    expect(picker).toContain('aria-haspopup="listbox"'); expect(picker).toContain('aria-expanded="false"'); expect(picker).not.toContain("更多 agent"); expect(picker).not.toContain('disabled=""');
    const fields = renderToStaticMarkup(<AgentFields agents={demoAgents} value={{ agentId: "codex" }} onChange={() => undefined} />); expect(fields).toContain("searchable-agent-picker"); expect(fields).toContain('aria-label="Model"'); expect(fields).toContain('aria-label="Mode"'); expect(fields).toContain('aria-label="Thinking"');
    const members = renderToStaticMarkup(<MembersEditor agents={demoAgents} members={[{ role: "review", agentId: "pi" }]} onChange={() => undefined} />); expect(members).toContain("searchable-agent-picker"); expect(members).not.toContain("更多 agent");
  });
  it("renders each vendor's own logo for built-in agents and an initial for the rest", () => {
    const expected: Record<string, string> = { claude: "claude", codex: "codex", pi: "pi", omp: "pi", gemini: "gemini", qwen: "qwen", kimi: "kimi", opencode: "opencode", copilot: "copilot", cursor: "cursor", goose: "goose", droid: "droid", hermes: "hermes", openclaw: "openclaw", kiro: "kiro", grok: "grok", traecli: "trae", devin: "devin", qoder: "qoder", amp: "amp", cline: "cline", kilo: "kilo", auggie: "augment", junie: "junie", codebuddy: "codebuddy", cortex: "snowflake", deepagents: "langchain", glm: "zhipu", mcode: "minimax", vibe: "mistral", "deepseek-harness": "deepseek", iflow: "iflow", mux: "coder", pool: "poolside" };
    for (const [id, vendor] of Object.entries(expected)) { expect(agentVendor(id)).toBe(vendor); const html = renderToStaticMarkup(<AgentIcon agent={id} />); expect(html).toContain(`data-agent-vendor="${vendor}"`); expect(html).toContain("<svg"); }
    expect(agentVendor("unknown-acp")).toBe("generic"); const monogram = renderToStaticMarkup(<AgentIcon agent="zeroclaw" />); expect(monogram).toContain("agent-monogram"); expect(monogram).toContain(">Z<");
  });
  it("ships sanitised vendor SVGs and maps model ids to their vendor", () => {
    for (const vendor of agentVendors.filter(vendor => vendor !== "generic")) { const html = renderToStaticMarkup(<AgentIcon agent={vendor} />); expect(html).not.toMatch(/<style|<script|href="http/); }
    expect(modelVendor("claude-sonnet-4-6")).toBe("anthropic"); expect(modelVendor("gpt-5.3-codex")).toBe("openai"); expect(modelVendor("gemini-2.5-pro")).toBe("google"); expect(modelVendor("openrouter/qwen/qwen3-coder")).toBe("qwen"); expect(modelVendor("deepseek-v4")).toBe("deepseek"); expect(modelVendor("some-local-model")).toBeUndefined();
    expect(renderToStaticMarkup(<ModelIcon model="claude-opus-4-6" />)).toContain('data-agent-vendor="anthropic"'); expect(renderToStaticMarkup(<ModelIcon model="mystery" />)).toBe("");
  });
});
