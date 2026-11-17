import { describe, expect, it } from "vitest";
import { applyEvent, type RunEventEnvelope } from "@baton/protocol";
import { createScenario, replay } from "../demo/scenario.js";
import { activeMembers, candidateRows, cleanCandidate, cleanMember, rosterRows, validateCandidates, validateMembers, validatePreset } from "./teams.js";
import { summarize, terminal } from "./derive.js";

const base = Date.parse("2026-11-10T07:00:00Z");
const snapshot = replay(createScenario(base), base + 86000);
describe("teams projections and form validation", () => {
  it("applies full team.updated rosters through the protocol reducer and ignores stale events", () => {
    const team = snapshot.run.team!;
    const nextTeam = { ...team, rationale: "Updated rationale" };
    const event: RunEventEnvelope = { type: "team.updated", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, ts: snapshot.run.updatedAt, team: nextTeam, change: { kind: "approved", by: "human", at: snapshot.run.updatedAt } };
    const next = applyEvent(snapshot, event);
    expect(next.run.team).toBe(nextTeam);
    expect(next.nodes).toBe(snapshot.nodes);
    expect(snapshot.run.team!.rationale).not.toBe("Updated rationale");
    expect(applyEvent(next, event)).toBe(next);
  });
  it("keeps replaced member counts distinct from the new occupant of the same role", () => {
    const rows = rosterRows(snapshot); const old = rows.find(row => row.member.status === "replaced")!;
    const successor = rows.find(row => row.member.replaces === old.member.id)!;
    expect(activeMembers(snapshot.run.team).map(member => member.id)).not.toContain(old.member.id);
    expect(old.counts.completed).toBe(1);
    expect(successor.counts.replaced).toBe(1);
    expect(successor.total).toBe(1);
    expect(terminal("replaced")).toBe(true);
    expect(summarize(snapshot).activeNodeCount).toBe(snapshot.nodes.filter(node => !terminal(node.status) && node.status !== "idle").length);
  });
  it("validates trimmed unique roles, mandatory agents and lead/name without rejecting solo-sized presets", () => {
    expect(validateMembers([{ role: "frontend", agentId: "claude" }, { role: " frontend ", agentId: "codex" }])).toContain("角色重复：frontend");
    expect(validateMembers([{ role: "", agentId: "" }])).toHaveLength(2);
    expect(validatePreset({ name: "", lead: { agentId: "" }, members: [] })).toHaveLength(2);
    expect(validatePreset({ name: "Small team", lead: { agentId: "claude" }, members: [] })).toEqual([]);
    expect(cleanMember({ role: " api ", agentId: " codex ", model: "", responsibilities: " test " })).toEqual({ role: "api", agentId: "codex", responsibilities: "test" });
  });
  it("validates candidates without roles: candidates-only presets pass, missing agents and duplicate configurations fail", () => {
    expect(validatePreset({ name: "Pool", lead: { agentId: "claude" }, members: [], candidates: [{ agentId: "codex", model: "gpt-x", thinking: "high" }, { agentId: "codex", model: "gpt-x" }] })).toEqual([]);
    expect(validateCandidates([{ agentId: "" }, { agentId: "codex", model: "m" }, { agentId: "codex", model: " m ", description: "other words" }])).toEqual(["候选 1：请选择 agent", "候选 3 重复：codex · m（agent、模型和思考级别都与前面的候选相同）"]);
    expect(validatePreset({ name: "Pool", lead: { agentId: "claude" }, members: [], candidates: [{ agentId: "" }] })).toEqual(["候选 1：请选择 agent"]);
    expect(cleanCandidate({ agentId: " codex ", model: " ", thinking: "", description: " 前端 " })).toEqual({ agentId: "codex", description: "前端" });
    const team = { source: "preset" as const, members: [{ role: "ui", agentId: "codex", id: "m1", status: "active" as const, addedBy: "lead" as const, addedAt: "2026-11-10T07:00:00Z", candidateId: "c1" }], changes: [], proposals: [], candidates: [{ id: "c1", agentId: "codex" }, { id: "c2", agentId: "pi" }], updatedAt: "2026-11-10T07:00:00Z" };
    expect(candidateRows(team).map(row => [row.candidate.id, row.hires.map(member => member.role)])).toEqual([["c1", ["ui"]], ["c2", []]]);
    expect(candidateRows(undefined)).toEqual([]);
  });
});
