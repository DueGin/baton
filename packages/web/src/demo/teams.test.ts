import { describe, expect, it } from "vitest";
import { DemoClient } from "./client.js";
import { activeMembers, pendingProposals } from "../lib/teams.js";
import { parseBatonMessage } from "../lib/baton-messages.js";
import { summarize } from "../lib/derive.js";

const base = Date.parse("2026-11-10T07:00:00Z");
async function gate(client: DemoClient) {
  const summaries = await client.runs();
  const run = summaries.find(entry => entry.title.startsWith("待确认团队"))!;
  const snapshot = await client.run(run.id);
  return { id: run.id, snapshot, proposal: pendingProposals(snapshot.run.team)[0]! };
}
describe("browser demo teams and approval gate", () => {
  it("keeps proposed roles queued until approval, then uses the approved specs", async () => {
    let now = base; const client = new DemoClient(() => now); const { id, proposal, snapshot } = await gate(client);
    expect(snapshot.run.policy.teamApproval).toBe(true);
    expect(activeMembers(snapshot.run.team)).toHaveLength(0);
    expect(summarize(snapshot).pendingPermissions).toBe(1);
    expect(snapshot.delegations.every(edge => edge.status === "queued" && edge.blockedByProposal === proposal.id)).toBe(true);
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.delegations.every(edge => !snapshot.nodes.some(node => node.id === edge.toNodeId))).toBe(true);
    now += 60000;
    expect((await client.run(id)).delegations.every(edge => edge.status === "queued")).toBe(true);
    await client.approveTeam(id, proposal.id, {});
    const after = await client.run(id);
    expect(activeMembers(after.run.team)).toHaveLength(2);
    expect(after.delegations.every(edge => edge.status === "running" && !edge.blockedByProposal && edge.memberId)).toBe(true);
    expect(after.nodes).toHaveLength(3);
    expect(after.run.team!.proposals[0]!.status).toBe("approved");
    now += 13000;
    expect((await client.run(id)).delegations.every(edge => edge.status === "completed")).toBe(true);
  });
  it("approves edited members and cancels the queued tasks whose roles were dropped", async () => {
    const client = new DemoClient(() => base); const { id, proposal } = await gate(client);
    const spec = { ...proposal.members![0]!, agentId: "pi", model: "custom-model", responsibilities: "Edited scope" };
    await client.approveTeam(id, proposal.id, { members: [spec], note: "先完成核心功能" });
    const after = await client.run(id);
    expect(activeMembers(after.run.team)).toHaveLength(1);
    const running = after.delegations.find(edge => edge.status === "running")!;
    const node = after.nodes.find(node => node.id === running.toNodeId)!;
    expect(node.agentId).toBe("pi"); expect(node.model).toBe("custom-model");
    expect(after.delegations.some(edge => edge.status === "canceled" && edge.role === "reviewer")).toBe(true);
    expect(after.nodes).toHaveLength(2);
    expect(after.delegations.filter(edge => edge.status === "canceled").every(edge => !edge.blockedByProposal && !after.nodes.some(node => node.id === edge.toNodeId))).toBe(true);
    expect(after.run.team!.proposals[0]!.approvedMembers).toEqual([spec]);
    const notices = (await client.items(after.run.rootNodeId)).items.flatMap(row => row.item.type === "user_message" ? parseBatonMessage(row.item.text) ?? [] : []);
    expect(notices.some(part => part.type === "notice" && part.text.includes("先完成核心功能"))).toBe(true);
  });
  it("rejects with feedback, cancels queued work, and refuses a second pending proposal", async () => {
    const client = new DemoClient(() => base); const { id, proposal } = await gate(client);
    expect(() => client.proposeTeam(id, [{ role: "new", agentId: "codex" }], "more")).toThrow("已有待确认提案");
    await expect(client.rejectTeam(id, proposal.id, { feedback: "" })).rejects.toThrow("请填写驳回理由");
    await client.rejectTeam(id, proposal.id, { feedback: "先给出更小的团队" });
    const after = await client.run(id);
    expect(after.delegations.every(edge => edge.status === "canceled")).toBe(true);
    expect(after.nodes).toHaveLength(1);
    expect(after.run.team!.proposals[0]!.feedback).toBe("先给出更小的团队");
    await expect(client.approveTeam(id, proposal.id, {})).rejects.toThrow("提案已处理");
  });
  it("cancels reserved delegates and the pending proposal when the Run is canceled", async () => {
    const client = new DemoClient(() => base); const { id } = await gate(client);
    await client.cancelRun(id);
    const after = await client.run(id);
    expect(after.run.status).toBe("canceled");
    expect(after.nodes).toHaveLength(1);
    expect(after.delegations.every(edge => edge.status === "canceled" && !edge.blockedByProposal)).toBe(true);
    expect(pendingProposals(after.run.team)).toHaveLength(0);
  });
  it("starts dynamic work immediately with teamApproval=false and keeps solo without any team", async () => {
    const client = new DemoClient(() => base);
    const run = await client.createRun({ agent: "claude", cwd: "/tmp/demo", prompt: "Build", policy: { mode: "dynamic", teamApproval: false } });
    expect(pendingProposals(run.run.team)).toHaveLength(0); expect(activeMembers(run.run.team)).toHaveLength(2);
    expect(run.delegations.every(edge => edge.status === "running")).toBe(true);
    const solo = await client.createRun({ agent: "pi", cwd: "/tmp/demo", prompt: "Question", policy: { mode: "solo" } });
    expect(solo.run.team).toBeUndefined(); expect(solo.delegations).toHaveLength(0);
    await expect(client.addMember(solo.run.id, { role: "test", agentId: "pi" })).rejects.toThrow("单独完成");
  });
  it("supports preset CRUD, root lead configuration and saving a roster", async () => {
    const client = new DemoClient(() => base); const preset = (await client.teams())[0]!;
    const run = await client.createRun({ teamPresetId: preset.id, cwd: "/tmp/demo", prompt: "Preset work" });
    expect(run.run.policy.mode).toBe("preset"); expect(run.nodes[0]!.agentId).toBe(preset.lead.agentId);
    expect(activeMembers(run.run.team).every(member => member.addedBy === "preset")).toBe(true);
    await client.saveTeam(run.run.id, { name: "Saved team" });
    const saved = (await client.teams()).find(entry => entry.name === "Saved team")!;
    await client.updateTeam(saved.id, { name: "Renamed", lead: { agentId: "codex" }, members: [] });
    expect((await client.teams()).find(entry => entry.id === saved.id)!.lead.agentId).toBe("codex");
    await client.deleteTeam(saved.id); expect((await client.teams()).some(entry => entry.id === saved.id)).toBe(false);
  });
  it("returns warnings for known unavailable agents and rejects unknown preset agents", async () => {
    const client = new DemoClient(() => base);
    const input = { name: "Offline team", lead: { agentId: "gemini" }, members: [] };
    const saved = await client.createTeam(input);
    expect(saved.warnings).toHaveLength(1);
    expect(saved.warnings![0]).toContain("Gemini");
    expect((await client.updateTeam(saved.id, { ...input, lead: { agentId: "claude" } })).warnings).toEqual([]);
    await expect(client.createTeam({ ...input, lead: { agentId: "unknown" } })).rejects.toThrow("Unknown agent id");
    await expect(client.updateTeam(saved.id, { ...input, members: [{ role: "builder", agentId: "unknown" }] })).rejects.toThrow("Unknown agent id");
  });
  it("replaces members and reassigns unfinished work with linked history and progress", async () => {
    const client = new DemoClient(() => base); const before = await client.run("run-demo");
    const member = activeMembers(before.run.team).find(member => member.role === "frontend")!;
    await client.replaceMember("run-demo", member.id, { agentId: "codex", model: "replacement-model", reason: "需要更快的测试迭代", reassignActive: true });
    const after = await client.run("run-demo"); const successor = activeMembers(after.run.team).find(entry => entry.replaces === member.id)!;
    expect(successor.agentId).toBe("codex");
    const replaced = after.delegations.find(edge => edge.toNodeId.endsWith(":ui"))!;
    expect(replaced.status).toBe("replaced");
    const next = after.delegations.find(edge => edge.id === replaced.replacedBy)!;
    expect(next.replaces).toBe(replaced.id); expect(next.memberId).toBe(successor.id);
    expect(next.brief.context).toContain("前任进展摘要"); expect(next.brief.context).toContain("SearchPalette.tsx");
    await client.removeMember("run-demo", successor.id);
    expect((await client.run("run-demo")).delegations.find(edge => edge.id === next.id)!.status).toBe("running");
  });
  it("allows failed tasks to be reassigned so a new member can recover them", async () => {
    const client = new DemoClient(() => base); const before = await client.run("run-demo");
    const failed = before.delegations.find(edge => edge.status === "failed")!;
    const target = activeMembers(before.run.team).find(member => member.agentId === "codex")!;
    await client.reassign(failed.id, { memberId: target.id, reason: "重试失败的索引检查" });
    const after = await client.run(before.run.id);
    const predecessor = after.delegations.find(edge => edge.id === failed.id)!;
    expect(predecessor.status).toBe("replaced");
    expect(after.nodes.find(node => node.id === failed.toNodeId)!.status).toBe("replaced");
    expect(after.delegations.find(edge => edge.id === predecessor.replacedBy)).toMatchObject({ status: "running", memberId: target.id, replaces: failed.id });
  });
  it("approves an edited replacement proposal and moves active tasks to the approved agent", async () => {
    const client = new DemoClient(() => base);
    const run = await client.createRun({ agent: "claude", cwd: "/tmp/demo", prompt: "Build", policy: { mode: "dynamic", teamApproval: false } });
    await client.patchRun(run.run.id, { policy: { teamApproval: true } });
    const member = activeMembers(run.run.team)[0]!;
    client.proposeReplacement(run.run.id, member.id, { role: member.role, agentId: "pi" }, "需要独立执行者");
    const proposed = await client.run(run.run.id); const proposal = pendingProposals(proposed.run.team)[0]!;
    expect(activeMembers(proposed.run.team).some(entry => entry.id === member.id)).toBe(true);
    await expect(client.approveTeam(run.run.id, proposal.id, { replacement: { role: "renamed-role", agentId: "claude" } })).rejects.toThrow("保留原角色");
    await client.approveTeam(run.run.id, proposal.id, { replacement: { role: member.role, agentId: "claude", model: "human-selected" }, note: "改用 Claude" });
    const after = await client.run(run.run.id); const replacement = activeMembers(after.run.team).find(entry => entry.replaces === member.id)!;
    expect(replacement.agentId).toBe("claude"); expect(replacement.model).toBe("human-selected");
    expect(after.run.team!.proposals.find(entry => entry.id === proposal.id)!.approvedReplacement?.model).toBe("human-selected");
    expect(after.delegations.some(edge => edge.status === "replaced" && edge.memberId === member.id)).toBe(true);
    expect(after.delegations.some(edge => edge.status === "running" && edge.memberId === replacement.id)).toBe(true);
  });
});
