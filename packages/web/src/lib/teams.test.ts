import { describe, expect, it } from "vitest";
import { applyEvent, type RunEventEnvelope } from "@baton/protocol";
import { createScenario, replay } from "../demo/scenario.js";
import { activeMembers, cleanMember, rosterRows, validateMembers, validatePreset } from "./teams.js";
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
});
