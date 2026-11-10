import { describe, expect, it } from "vitest";
import type { AgentEntry, RunPolicy } from "@baton/protocol";
import { systemPrompt } from "./prompts.js";

const policy: RunPolicy = { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, delegation: "lead" };
const agent = (id: string, model: string): AgentEntry => ({
  id, label: id, kind: "native", status: "ready", enabled: true, models: [{ id: model, label: model, isDefault: true }],
  modes: [], capabilities: { steer: true, resume: true, reasoning: true, mcp: true }, checkedAt: "2026-11-10T00:00:00.000Z",
});
const root = { id: "n1", depth: 0, parentNodeId: null, agentId: "claude" };
const child = { id: "n2", depth: 1, parentNodeId: "n1", agentId: "codex" };

describe("systemPrompt", () => {
  it("makes the root a lead by default and lists the agents it can delegate to", () => {
    const text = systemPrompt(root, { ...policy, delegation: undefined }, [agent("codex", "gpt-x"), agent("pi", "flash")]);
    expect(text).toContain("Delegation mode: LEAD");
    expect(text).toContain("- codex (codex) — default model gpt-x");
    expect(text).toContain("- pi (pi) — default model flash");
    expect(text).toContain("mcp__baton__delegate");
    expect(text).not.toContain("report_result exactly once");
  });
  it("lets agents decide in auto mode, and never puts delegates in lead mode", () => {
    expect(systemPrompt(root, { ...policy, delegation: "auto" })).not.toContain("LEAD");
    const delegate = systemPrompt(child, policy);
    expect(delegate).not.toContain("LEAD");
    expect(delegate).toContain("report_result exactly once");
  });
  it("tells agents at the depth limit to do the work themselves", () => {
    const text = systemPrompt({ ...child, depth: 3 }, policy);
    expect(text).toContain("maximum delegation depth (3)");
    expect(text).not.toContain("Delegate when part of your work");
  });
});
