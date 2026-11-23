import { describe, expect, it } from "vitest";
import type { AgentEntry, RunPolicy, TeamRecord } from "@baton/protocol";
import { correctionPrompt, followupPrompt, leadReviewNotice, noticePrompt, systemPrompt } from "./prompts.js";

const policy: RunPolicy = { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, mode: "dynamic" };
const agent = (id: string, model: string): AgentEntry => ({
  id, label: id, kind: "native", status: "ready", enabled: true, models: [{ id: model, label: model, isDefault: true }],
  modes: [], capabilities: { steer: true, resume: true, reasoning: true, mcp: true }, checkedAt: "2026-11-10T00:00:00.000Z",
});
const root = { id: "n1", depth: 0, parentNodeId: null, agentId: "claude" };
const child = { id: "n2", depth: 1, parentNodeId: "n1", agentId: "codex" };
const reviewRequirements = [
  "inspect the diff", "builds, type checks, and tests", "Real run", "the user's current environment",
  "an unused port", "temporary data directory", "stop only the processes you started", "mock data or simulated agents",
  "screenshot for each UI acceptance point", "read the image files yourself", "layout, text, and state",
  "errors or raw markup", "screenshot paths", "what you actually saw", "List unverified points separately",
  "do not mark an unseen screenshot as passed", "use send to request fixes", "verify it again",
];

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
  it("requires personal review of each result only for a non-solo lead when enabled", () => {
    for (const mode of ["dynamic", "preset"] as const) {
      const enabled = systemPrompt(root, { ...policy, mode, leadReview: true });
      const disabled = systemPrompt(root, { ...policy, mode, leadReview: false });
      expect(enabled).toContain("Lead review is enabled");
      expect(disabled).not.toContain("Lead review is enabled");
      for (const requirement of reviewRequirements) {
        expect(enabled).toContain(requirement);
        expect(disabled).not.toContain(requirement);
      }
    }
    expect(systemPrompt(child, { ...policy, leadReview: true })).toBe(systemPrompt(child, policy));
    expect(systemPrompt(root, { ...policy, mode: "solo", leadReview: true })).toBe(systemPrompt(root, { ...policy, mode: "solo" }));
  });
  it("delivers the full acceptance procedure only in the enabled policy notice", () => {
    const enabled = leadReviewNotice(true), disabled = leadReviewNotice(false);
    expect(enabled).toContain('<baton-notice kind="policy">\nThe human changed the run policy. Lead review is enabled.');
    expect(disabled).toContain('<baton-notice kind="policy">\nThe human changed the run policy. Lead review is disabled');
    for (const requirement of reviewRequirements) {
      expect(enabled).toContain(requirement);
      expect(disabled).not.toContain(requirement);
    }
  });
  it("discourages waiting in a loop and teaches delegates to yield without reporting", () => {
    expect(systemPrompt(root, policy)).toContain("Do not call wait in a loop");
    const guidance = "end your turn without calling report_result";
    expect(systemPrompt(child, policy)).toContain(guidance);
    expect(systemPrompt(root, policy)).not.toContain(guidance);
    expect(systemPrompt({ ...child, depth: 3 }, policy)).not.toContain(guidance);
  });
  it("supports solo and never gives members lead instructions", () => {
    expect(systemPrompt(root, { ...policy, mode: "solo" })).toContain("Work alone");
    const delegate = systemPrompt(child, policy);
    expect(delegate).not.toContain("You are the lead");
    expect(delegate).toContain("report_result exactly once");
    expect(delegate).toContain("A <baton-followup> message comes from the agent that delegated to you");
  });
  it("explains approval, preset roles and member file ownership", () => {
    const team: TeamRecord = { source: "preset", members: [{ id: "member", status: "active", addedBy: "preset", addedAt: "2026-11-10T00:00:00.000Z", role: "builder", agentId: "codex", responsibilities: "Own src/builder.ts" }, { id: "reviewer", status: "active", addedBy: "preset", addedAt: "2026-11-10T00:00:00.000Z", role: "reviewer", agentId: "claude", responsibilities: "Own tests" }], changes: [], proposals: [], updatedAt: "2026-11-10T00:00:00.000Z" };
    const lead = systemPrompt(root, { ...policy, mode: "preset" }, [], team);
    expect(lead).toContain("Delegate only by role"); expect(lead).toContain("After proposing, end your turn");
    expect(lead).toContain('<baton-notice kind="team">');
    const delegate = systemPrompt({ ...child, role: "builder", memberId: "member" }, policy, [], team);
    expect(delegate).toContain("Your team role: builder"); expect(delegate).toContain("Own src/builder.ts"); expect(delegate).toContain("reviewer: claude");
    expect(systemPrompt(root, { ...policy, teamApproval: false })).not.toContain("Roster approval is required");
  });
  it("offers preset candidates to the lead only, and only when the preset has some", () => {
    const ts = "2026-11-10T00:00:00.000Z";
    const team: TeamRecord = { source: "preset", members: [], changes: [], proposals: [], updatedAt: ts, candidates: [{ id: "c1", agentId: "codex", model: "gpt-x", thinking: "high", description: "前端、CSS 动画" }, { id: "c2", agentId: "pi" }] };
    const preset = { ...policy, mode: "preset" as const };
    const lead = systemPrompt(root, preset, [agent("codex", "gpt-x")], team);
    expect(lead).toContain("hire preset candidates into roles you name");
    expect(lead).toContain("- c1: codex / gpt-x, thinking high — 前端、CSS 动画");
    expect(lead).toContain("- c2: pi / default model (currently unavailable) — no description");
    expect(lead).toContain("matching the task to its model and description");
    expect(lead).toContain('call delegate with candidate: "<id>" and role: "<a new role name>"');
    expect(lead).toContain("hiring needs no roster approval");
    const without = systemPrompt(root, preset, [], { ...team, candidates: undefined });
    expect(without).not.toContain("candidate"); expect(without).toContain("2. Use the preset roster below. Delegate only by role");
    expect(systemPrompt({ ...child, role: "builder" }, preset, [], team)).not.toContain("candidate");
    const dynamic = systemPrompt(root, policy, [], { ...team, source: "dynamic" });
    expect(dynamic).not.toContain("Preset candidates"); expect(dynamic).toContain("Candidates the human picked for this run"); expect(dynamic).toContain("- c1: codex");
  });
  it("tells agents at the depth limit to do the work themselves", () => {
    const text = systemPrompt({ ...child, depth: 3 }, policy);
    expect(text).toContain("maximum delegation depth (3)");
    expect(text).not.toContain("Delegate when part of your work");
  });
});

describe("agent message tags", () => {
  it("identifies follow-ups by delegation, escapes attributes and preserves the plain-text body", () => {
    expect(followupPrompt('id&"<tag>', 'Check src/a.ts\nKeep "quotes" & <examples> as written.')).toBe(
      '<baton-followup delegation="id&amp;&quot;&lt;tag>">\nCheck src/a.ts\nKeep "quotes" & <examples> as written.\n</baton-followup>',
    );
  });

  it("wraps schema corrections in a correction notice", () => {
    expect(correctionPrompt(["$.value is required", "$.count must be an integer"])).toBe(
      '<baton-notice kind="correction">\nYour report_result `result` does not match the required JSON Schema:\n- $.value is required\n- $.count must be an integer\nFix it and call report_result again with a valid result, then end your turn.\n</baton-notice>',
    );
  });

  it.each(["team", "system", "policy"] as const)("keeps %s notices distinct from follow-ups", (kind) => {
    expect(noticePrompt(kind, "First line\nSecond line")).toBe(`<baton-notice kind="${kind}">\nFirst line\nSecond line\n</baton-notice>`);
  });
});

it("keeps member routing and repository boundaries explicit", () => {
  const text = systemPrompt(child, policy);
  expect(text).toContain("Modify only the files assigned to you");
  expect(text).toContain("git commit, push, merge, rebase, checkout, reset or stash");
  expect(text).toContain("Investigate missing information");
  expect(text).toContain("ask_human");
  expect(systemPrompt(root, policy)).toContain("Team size limit: 5");
});

it("asks every agent to disclose long-running processes, ports and stopping instructions", () => {
  for (const node of [root, child]) for (const mode of ["dynamic", "preset", "solo"] as const) {
    expect(systemPrompt(node, { ...policy, mode })).toContain("tell the human in your reply what it is, its port(s), and how to stop it");
  }
});

it("asks every agent to print PR URLs and include URL artifacts", () => {
  for (const node of [root, child]) for (const mode of ["dynamic", "preset", "solo"] as const) {
    const text = systemPrompt(node, { ...policy, mode });
    expect(text).toContain("make the command print its URL");
    expect(text).toContain('{kind:"url", value:<PR URL>} in report_result.artifacts');
  }
});
