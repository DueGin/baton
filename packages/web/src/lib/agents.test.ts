import { describe, expect, it } from "vitest";
import { agentGroup, agentHomepage, agentMatches, agentReady, groupAgents, pickerAgents, sortAgents, unavailableMembers } from "./agents.js";
import { demoAgents } from "../demo/agents.js";
import { DemoClient } from "../demo/client.js";
describe("expanded agent catalog", () => {
  it("groups disabled entries before availability and sorts ready agents first without mutating input", () => {
    const before = demoAgents.map(agent => agent.id); const groups = groupAgents(demoAgents);
    for (const key of ["ready", "error", "unavailable", "disabled"] as const) expect(groups.find(group => group.key === key)!.agents.length).toBeGreaterThan(0);
    expect(groups.reduce((sum, group) => sum + group.agents.length, 0)).toBe(30);
    expect(agentGroup({ ...demoAgents[0]!, enabled: false, status: "ready" })).toBe("disabled");
    const sorted = sortAgents([...demoAgents].reverse()); const firstNotReady = sorted.findIndex(agent => !agentReady(agent));
    expect(sorted.slice(firstNotReady).every(agent => !agentReady(agent))).toBe(true); expect(demoAgents.map(agent => agent.id)).toEqual(before);
  });
  it("searches label, id, kind, models, modes, diagnostic and custom source with multiple terms", () => {
    expect(groupAgents(demoAgents, "GPT-5.3").flatMap(group => group.agents).map(agent => agent.id)).toEqual(["codex"]);
    expect(agentMatches(demoAgents[0]!, "claude plan")).toBe(true); expect(agentMatches(demoAgents[0]!, "claude missing")).toBe(false);
    expect(groupAgents(demoAgents, "低于要求").flatMap(group => group.agents).map(agent => agent.id)).toEqual(["kimi"]);
    expect(groupAgents(demoAgents, "自定义").flatMap(group => group.agents).map(agent => agent.id)).toEqual(["custom-linter"]);
    expect(groupAgents(demoAgents, "no-such-agent").every(group => !group.agents.length)).toBe(true);
  });
  it("keeps selected options visible while filtering and rejects unavailable team members", () => {
    const entries = pickerAgents(demoAgents, "claude", "codex"); expect(entries.map(agent => agent.id)).toEqual(["claude", "codex"]);
    expect(agentReady(demoAgents.find(agent => agent.id === "gemini"))).toBe(false); expect(agentReady(undefined)).toBe(false);
    expect(unavailableMembers(demoAgents, [{ role: "review", agentId: "gemini" }, { role: "build", agentId: "codex" }])).toEqual(["review：gemini 当前不可用"]);
  });
  it("has 30 mixed demo entries with unique ids and metadata and uses safe homepages", async () => {
    const entries = await new DemoClient(() => Date.parse("2026-11-16T00:00:00Z")).agents();
    expect(entries).toHaveLength(30); expect(new Set(entries.map(agent => agent.id)).size).toBe(30); expect(entries.every(agent => agent.source && agent.homepage)).toBe(true);
    expect(agentHomepage("https://example.com/a")).toBe("https://example.com/a");
    for (const url of ["javascript:alert(1)", "file:///tmp/a", "bad url"]) expect(agentHomepage(url)).toBeUndefined();
  });
});
