import { describe, expect, it } from "vitest";
import type { AgentEntry, RunPolicy, TeamRecord } from "@baton/protocol";
import { systemPrompt } from "./prompts.js";

const policy: RunPolicy = { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, mode: "dynamic" };
const agent = (id: string, model: string): AgentEntry => ({
  id, label: id, kind: "native", status: "ready", enabled: true, models: [{ id: model, label: model, isDefault: true }],
  modes: [], capabilities: { steer: true, resume: true, reasoning: true, mcp: true }, checkedAt: "2026-11-10T00:00:00.000Z",
});
const root = { id: "n1", depth: 0, parentNodeId: null, agentId: "claude" };
const child = { id: "n2", depth: 1, parentNodeId: "n1", agentId: "codex" };

describe("systemPrompt", () => {
  it("makes the root a lead by default and lists the agents it can delegate to", () => {
    const text = systemPrompt(root, { ...policy, mode: undefined }, [agent("codex", "gpt-x"), agent("pi", "flash")]);
    expect(text).toContain("Collaboration mode: DYNAMIC");
    expect(text).toContain("- codex (codex) — default model gpt-x");
    expect(text).toContain("- pi (pi) — default model flash");
    expect(text).toContain("mcp__baton__delegate");
    expect(text).not.toContain("report_result exactly once");
  });
  it("tells the lead that multi-file work requires a team", () => {
    const text = systemPrompt(root, policy, []);
    expect(text).toContain("two or more files");
    expect(text).toContain("is NOT trivial: you must build a team");
  });
  it("supports solo and never gives members lead instructions", () => {
    expect(systemPrompt(root, { ...policy, mode: "solo" })).toContain("Work alone");
    const delegate = systemPrompt(child, policy);
    expect(delegate).not.toContain("You are the lead");
    expect(delegate).toContain("report_result exactly once");
  });
  it("explains approval, preset roles and member file ownership", () => {
    const team: TeamRecord = { source: "preset", members: [{ id: "member", status: "active", addedBy: "preset", addedAt: "2026-11-10T00:00:00.000Z", role: "builder", agentId: "codex", responsibilities: "Own src/builder.ts" }, { id: "reviewer", status: "active", addedBy: "preset", addedAt: "2026-11-10T00:00:00.000Z", role: "reviewer", agentId: "claude", responsibilities: "Own tests" }], changes: [], proposals: [], updatedAt: "2026-11-10T00:00:00.000Z" };
    const lead = systemPrompt(root, { ...policy, mode: "preset" }, [], team);
    expect(lead).toContain("Delegate only by role"); expect(lead).toContain("After proposing, end your turn");
    const delegate = systemPrompt({ ...child, role: "builder", memberId: "member" }, policy, [], team);
    expect(delegate).toContain("Your team role: builder"); expect(delegate).toContain("Own src/builder.ts"); expect(delegate).toContain("reviewer: claude");
    expect(systemPrompt(root, { ...policy, teamApproval: false })).not.toContain("Roster approval is required");
  });
  it("tells agents at the depth limit to do the work themselves", () => {
    const text = systemPrompt({ ...child, depth: 3 }, policy);
    expect(text).toContain("maximum delegation depth (3)");
    expect(text).not.toContain("Delegate when part of your work");
  });
});
