import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applyEvent, type DelegationRecord, type TeamMember, type TeamPreset } from "@baton/protocol";
import { exportRun } from "./telemetry/index.js";
import { startServer, type BatonServer } from "./api/server.js";
import { FakeDriverRegistry, type FakeScript } from "./driver/fake.js";
const servers: BatonServer[] = [], homes: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const idle: FakeScript = (c) => { c.text("Done"); };
async function setup(scripts: Record<string, FakeScript> = { lead: idle, worker: idle, replacement: idle }, debounce = 30): Promise<BatonServer> {
  const home = await mkdtemp(join(tmpdir(), "baton-teams-")); homes.push(home);
  const s = await startServer({ home, port: 0, registry: new FakeDriverRegistry(scripts), deliveryDebounceMs: debounce }); servers.push(s); return s;
}
async function until(test: () => boolean, timeout = 4000): Promise<void> { const end = Date.now() + timeout; while (!test()) { if (Date.now() > end) throw new Error("Timed out"); await delay(10); } }
async function api<T>(s: BatonServer, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(s.url + path, { method, headers: { authorization: `Bearer ${s.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text()); return await response.json() as T;
}
function delegates(s: BatonServer, runId: string): DelegationRecord[] { return s.store.snapshot(runId).delegations; }
const member = (role = "builder") => ({ role, agentId: "worker", model: "member-model", modeId: "plan", thinking: "high", responsibilities: "Own src/builder.ts; implement the feature" });

describe("teams over actual HTTP MCP", () => {
  it("forms a team, delegates by role with overrides, exposes status and replays team.updated", async () => {
    let observed: unknown;
    const s = await setup({ lead: async (c) => {
      if (c.turn > 1) return;
      await c.call("form_team", { rationale: "Separate implementation and review", members: [{ role: "builder", agent: "worker", model: "member-model", mode: "plan", thinking: "high", responsibilities: "Own src/builder.ts" }] });
      await c.call("delegate", { role: "builder", title: "Build", task: "Implement", model: "override" });
      observed = await c.call("get_team", {});
    }, worker: async (c) => { c.text("Built"); await c.call("report_result", { status: "success", summary: "Built" }); } });
    const run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "Build", policy: { teamApproval: false } });
    await until(() => delegates(s, run.run.id).some((d) => d.status === "completed") && !!observed); await delay(100);
    const snapshot = s.store.snapshot(run.run.id), m = snapshot.run.team!.members[0]!, d = snapshot.delegations[0]!;
    expect(m).toMatchObject({ role: "builder", addedBy: "lead", status: "active" });
    expect(d).toMatchObject({ role: "builder", memberId: m.id });
    expect(s.store.node(d.toNodeId)).toMatchObject({ role: "builder", memberId: m.id, model: "override", modeId: "plan", thinking: "high" });
    const session = (s.kernel.registry as FakeDriverRegistry).get("worker")!.sessions[0]!;
    expect(session.spec.systemPrompt).toContain("Your team role: builder"); expect(session.spec.systemPrompt).toContain("Own src/builder.ts");
    expect(observed).toMatchObject({ members: [{ delegations: [expect.objectContaining({ id: d.id })] }] });
    expect(s.store.events(run.run.id).reduce(applyEvent, { ...snapshot, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], lastSeq: 0 })).toEqual(snapshot);
    await expect(s.kernel.tool(run.run.rootNodeId, "form_team", { rationale: "duplicate", members: [{ role: "builder", agent: "worker", responsibilities: "x" }] })).rejects.toThrow(/replace_member/);
  });
  it("auto-adds unique ad-hoc members for direct agent delegation", async () => {
    const s = await setup(), run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "ad hoc", policy: { teamApproval: false } });
    await Promise.all([1, 2, 3].map((n) => s.kernel.delegate(run.run.rootNodeId, { agent: "worker", title: `Task ${n}`, task: "x" })));
    const team = s.store.snapshot(run.run.id).run.team!;
    expect(team.members).toHaveLength(3); expect(new Set(team.members.map((m) => m.role)).size).toBe(3);
    expect(team.members.every((m) => m.addedBy === "agent")).toBe(true);
  });
  it("uses preset lead and enforces role delegation at depth 2", async () => {
    let rejected = false;
    const s = await setup({ lead: async (c) => { if (c.turn === 1) await c.call("delegate", { role: "builder", title: "Build", task: "build" }); }, worker: async (c) => {
      await expect(c.call("delegate", { agent: "replacement", title: "bad", task: "bad" })).rejects.toThrow(/Available roles: builder, reviewer/); rejected = true;
      await expect(c.call("form_team", { rationale: "bad", members: [{ role: "x", agent: "worker", responsibilities: "x" }] })).rejects.toThrow(/lead only/);
      await expect(c.call("replace_member", { role: "reviewer", agent: "replacement", reason: "bad" })).rejects.toThrow(/lead only/);
      await c.call("delegate", { role: "reviewer", title: "Review", task: "review" }); c.text("Built");
    }, replacement: idle });
    const preset = await s.kernel.teams.savePreset({ name: "Engineering", lead: { agentId: "lead", model: "lead-model" }, members: [member(), { role: "reviewer", agentId: "replacement", responsibilities: "Own tests" }] });
    const run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, teamPresetId: preset.id, cwd: tmpdir(), prompt: "preset" });
    await until(() => delegates(s, run.run.id).length === 2 && rejected);
    expect(s.store.node(run.run.rootNodeId)).toMatchObject({ agentId: "lead", model: "lead-model" });
    expect(s.store.snapshot(run.run.id).nodes.map((n) => n.depth)).toEqual([0, 1, 2]);
    expect(s.store.snapshot(run.run.id).run.team?.members.every((m) => m.addedBy === "preset")).toBe(true);
    await expect(s.kernel.tool(run.run.rootNodeId, "form_team", { rationale: "x", members: [{ role: "x", agent: "worker", responsibilities: "x" }] })).rejects.toThrow(/dynamic/);
    const override = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "replacement", teamPresetId: preset.id, cwd: tmpdir(), prompt: "override" }); expect(s.store.node(override.run.rootNodeId).agentId).toBe("replacement");
  });
  it("solo injects only human questions, prohibits delegation and rejects invalid modes", async () => {
    const s = await setup(), run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "solo", policy: { mode: "solo" } });
    const session = (s.kernel.registry as FakeDriverRegistry).get("lead")!.sessions[0]!;
    expect(session.spec.mcpServers.baton?.type).toBe("http"); expect(session.spec.systemPrompt).toContain("Work alone");
    await expect(s.kernel.delegate(run.run.rootNodeId, { agent: "worker", title: "x", task: "x" })).rejects.toThrow(/Solo/);
    await expect(s.kernel.tool(run.run.rootNodeId, "list_agents", {})).rejects.toThrow(/Solo/);
    await expect(api(s, "/api/runs", "POST", { projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "bad", policy: { mode: "bogus" } })).rejects.toThrow(/mode/);
  });
  it("replaces an active member, carries progress/files, resolves wait with replacement and suppresses old results", async () => {
    const s = await setup({ lead: idle, worker: async (c) => {
      c.text("Existing progress " + "x".repeat(2200));
      c.item({ type: "tool_call", callId: "edit", name: "edit", status: "completed", detail: { type: "edit", filePath: "src/builder.ts" } });
      await c.call("delegate", { role: "helper", title: "Nested", task: "nested" });
      await c.sleep(10000);
    }, replacement: idle, helper: async (c) => { await c.sleep(10000); } }, 60);
    const run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "replace", policy: { teamApproval: false }, team: [member(), { role: "helper", agentId: "helper", responsibilities: "Own fixtures" }] });
    const old = await s.kernel.delegate(run.run.rootNodeId, { role: "builder", title: "Build", task: "Original task", context: "Original context" });
    await until(() => delegates(s, run.run.id).length === 2);
    const wait = s.kernel.tool(run.run.rootNodeId, "wait", { delegationIds: [old.delegationId], timeoutSec: 2 });
    const changed = await s.kernel.tool(run.run.rootNodeId, "replace_member", { role: "builder", agent: "replacement", reason: "stalled" }) as { member: TeamMember; replacements: Array<{ delegationId: string }> };
    const successor = s.store.delegation(changed.replacements[0]!.delegationId);
    expect(await wait).toMatchObject({ timedOut: false, results: [expect.objectContaining({ status: "replaced", replacedBy: successor.id })] });
    expect(s.store.node(old.nodeId).status).toBe("replaced"); expect(successor).toMatchObject({ replaces: old.delegationId, fromNodeId: run.run.rootNodeId, memberId: changed.member.id });
    expect(successor.brief.context).toContain("Original context"); expect(successor.brief.context).toContain("src/builder.ts");
    expect(successor.brief.context!.length).toBeLessThan(2300);
    expect(delegates(s, run.run.id).find((d) => d.brief.title === "Nested")?.status).toBe("canceled");
    await until(() => s.store.delegation(successor.id).status === "completed"); await delay(150);
    const messages = s.store.items(run.run.rootNodeId).filter((r) => r.item.type === "user_message").map((r) => r.item.type === "user_message" ? r.item.text : "");
    expect(messages.some((text) => text.includes("<baton-notice>"))).toBe(false);
    expect(messages.some((text) => text.includes(`<result delegation="${old.delegationId}"`))).toBe(false);
    expect(s.store.delegation(old.delegationId).deliveredAt).toBeUndefined();
  });
  it("human reassigns through REST and notifies a running parent, while remove keeps assignments", async () => {
    const s = await setup({ lead: async (c) => { await c.sleep(10000); }, worker: async (c) => { c.text("Progress"); await c.sleep(10000); }, replacement: idle });
    const run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "human", policy: { teamApproval: false }, team: [member(), { role: "reviewer", agentId: "replacement" }] });
    const old = await s.kernel.delegate(run.run.rootNodeId, { role: "builder", title: "Build", task: "x" });
    const reviewer = s.store.snapshot(run.run.id).run.team!.members.find((m) => m.role === "reviewer")!;
    const successor = await api<{ delegationId: string }>(s, `/api/delegations/${old.delegationId}/reassign`, "POST", { memberId: reviewer.id, reason: "Human changed owner" });
    await until(() => s.store.items(run.run.rootNodeId).some((r) => r.item.type === "user_message" && r.item.text.includes("<baton-notice>")));
    expect(s.store.delegation(successor.delegationId).replaces).toBe(old.delegationId);
    const added = await api<TeamMember>(s, `/api/runs/${run.run.id}/team/members`, "POST", { role: "extra", agentId: "worker" });
    const task = await s.kernel.delegate(run.run.rootNodeId, { role: "extra", title: "Keep working", task: "x" });
    await api(s, `/api/runs/${run.run.id}/team/members/${added.id}`, "DELETE");
    expect(s.store.delegation(task.delegationId).status).not.toBe("canceled");
    const current = s.store.snapshot(run.run.id).run.team!.members.find((m) => m.role === "builder")!;
    await api(s, `/api/runs/${run.run.id}/team/members/${current.id}/replace`, "POST", { agentId: "replacement", reason: "swap only", reassignActive: false });
    expect(s.store.snapshot(run.run.id).run.team!.changes.at(-1)?.by).toBe("human");
  });
  it("CRUDs presets, saves a run roster and rejects unknown agents", async () => {
    const s = await setup();
    const preset = await api<TeamPreset>(s, "/api/teams", "POST", { name: "Team", lead: { agentId: "lead" }, members: [member()] });
    expect(await api<TeamPreset[]>(s, "/api/teams")).toHaveLength(1);
    const updated = await api<TeamPreset>(s, `/api/teams/${preset.id}`, "PUT", { name: "Updated", lead: { agentId: "lead" }, members: [member("review")] }); expect(updated.name).toBe("Updated");
    const run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, teamPresetId: preset.id, cwd: tmpdir(), prompt: "preset save" });
    const saved = await api<TeamPreset>(s, `/api/runs/${run.run.id}/team/save-preset`, "POST", { name: "Saved" }); expect(saved.members[0]?.role).toBe("review");
    await api(s, `/api/teams/${preset.id}`, "DELETE"); expect(await api<TeamPreset[]>(s, "/api/teams")).toHaveLength(1);
    await expect(api(s, "/api/teams", "POST", { name: "Bad", lead: { agentId: "unknown" }, members: [] })).rejects.toThrow(/Unknown agent/);
  });
});

describe("team approval gate", () => {
  async function proposed(): Promise<{ s: BatonServer; runId: string; root: string; proposalId: string }> {
    const s = await setup({ lead: async (c) => {
      if (c.turn > 1) return;
      await c.call("form_team", { rationale: "Two independent scopes", members: [{ role: "builder", agent: "worker", responsibilities: "Own src" }, { role: "reviewer", agent: "worker", responsibilities: "Own tests" }] });
      await c.call("delegate", { role: "builder", title: "Build", task: "x" });
      await c.call("delegate", { role: "reviewer", title: "Review", task: "x" });
    }, worker: idle, replacement: idle });
    const run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "approval" });
    await until(() => delegates(s, run.run.id).length === 2);
    return { s, runId: run.run.id, root: run.run.rootNodeId, proposalId: s.store.snapshot(run.run.id).run.team!.proposals[0]!.id };
  }
  it("keeps work queued until as-is approval and always notifies the proposer", async () => {
    const { s, runId, root, proposalId } = await proposed();
    expect(s.store.snapshot(runId).run.team!.members).toHaveLength(0);
    expect(delegates(s, runId).every((d) => d.status === "queued" && d.blockedByProposal === proposalId)).toBe(true);
    expect((s.kernel.registry as FakeDriverRegistry).get("worker")!.sessions).toHaveLength(0);
    expect(s.store.snapshot(runId).nodes).toHaveLength(1);
    await api(s, `/api/runs/${runId}/team/proposals/${proposalId}/approve`, "POST", {});
    await until(() => delegates(s, runId).every((d) => d.status === "completed")); await delay(80);
    expect(s.store.snapshot(runId).run.team!.proposals[0]?.status).toBe("approved");
    expect(exportRun(s.store, runId, "md")).toContain("## Team roster");
    expect(exportRun(s.store, runId, "md")).toContain("### Team change history");
    expect(exportRun(s.store, runId, "otlp")).toContain("baton.team");
    expect(s.store.items(root).some((r) => r.item.type === "user_message" && r.item.text.includes("approved."))).toBe(true);
    const snapshot = s.store.snapshot(runId);
    expect(s.store.events(runId).reduce(applyEvent, { ...snapshot, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], lastSeq: 0 })).toEqual(snapshot);
  });
  it("applies edited specs, cancels dropped roles and rejects second proposals", async () => {
    const { s, runId, root, proposalId } = await proposed();
    await expect(s.kernel.tool(root, "form_team", { rationale: "again", members: [{ role: "extra", agent: "worker", responsibilities: "x" }] })).rejects.toThrow(/already pending/);
    await api(s, `/api/runs/${runId}/team/proposals/${proposalId}/approve`, "POST", { members: [{ role: "builder", agentId: "replacement", model: "human-model", responsibilities: "Human scope" }], note: "Smaller team" });
    await until(() => delegates(s, runId).find((d) => d.role === "builder")?.status === "completed");
    const [built, dropped] = delegates(s, runId);
    expect(s.store.node(built!.toNodeId)).toMatchObject({ agentId: "replacement", model: "human-model" }); expect(dropped?.status).toBe("canceled");
    const session = (s.kernel.registry as FakeDriverRegistry).get("replacement")!.sessions[0]!; expect(session.spec.systemPrompt).toContain("Human scope");
    expect(s.store.snapshot(runId).run.team!.proposals[0]?.feedback).toBe("Smaller team");
  });
  it("rejects a proposal with feedback and cancels every blocked task", async () => {
    const { s, runId, root, proposalId } = await proposed();
    await api(s, `/api/runs/${runId}/team/proposals/${proposalId}/reject`, "POST", { feedback: "Use a single specialist" });
    expect(delegates(s, runId).every((d) => d.status === "canceled")).toBe(true);
    expect(s.store.snapshot(runId).run.team!.members).toHaveLength(0);
    await until(() => s.store.items(root).some((r) => r.item.type === "user_message" && r.item.text.includes("Use a single specialist")));
    expect((s.kernel.registry as FakeDriverRegistry).get("worker")!.sessions).toHaveLength(0);
  });
  it("proposes ad-hoc additions and replacement; human changes bypass approval", async () => {
    const s = await setup({ lead: idle, worker: async (c) => { c.text("work"); await c.sleep(10000); }, replacement: idle });
    const run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "ad hoc" });
    const task = await s.kernel.delegate(run.run.rootNodeId, { agent: "worker", title: "Ad-hoc", task: "x" }); expect(task.status).toBe("pending_approval");
    await api(s, `/api/runs/${run.run.id}/team/proposals/${task.proposalId}/approve`, "POST", {});
    await until(() => s.store.delegation(task.delegationId).status === "running");
    const role = s.store.delegation(task.delegationId).role!;
    const proposal = await s.kernel.tool(run.run.rootNodeId, "replace_member", { role, agent: "replacement", reason: "better fit" }) as { proposalId: string; status: string };
    expect(proposal.status).toBe("pending_approval"); expect(s.store.delegation(task.delegationId).status).toBe("running");
    await api(s, `/api/runs/${run.run.id}/team/proposals/${proposal.proposalId}/approve`, "POST", {});
    expect(s.store.delegation(task.delegationId).status).toBe("replaced");
    await api(s, `/api/runs/${run.run.id}/team/members`, "POST", { role: "human-added", agentId: "worker" });
    expect(s.store.snapshot(run.run.id).run.team!.members.find((m) => m.role === "human-added")?.status).toBe("active");
    expect(s.store.snapshot(run.run.id).run.team!.proposals.filter((p) => p.status === "pending")).toHaveLength(0);
  });
});

describe("team recovery and reassignment approval", () => {
  it("persists blocked work across restart and migrates legacy delegation policy", async () => {
    const s = await setup(), run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "restart" });
    await until(() => s.store.node(run.run.rootNodeId).status === "idle");
    const task = await s.kernel.delegate(run.run.rootNodeId, { agent: "worker", title: "Queued", task: "x" });
    s.store.append(run.run.id, { type: "run.updated", patch: { policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, delegation: "lead" } as unknown as typeof run.run.policy } });
    await s.close(); servers.splice(servers.indexOf(s), 1);
    const registry = new FakeDriverRegistry({ lead: idle, worker: idle, replacement: idle });
    const restored = await startServer({ home: s.home, port: 0, registry, deliveryDebounceMs: 20 }); servers.push(restored);
    expect(restored.store.snapshot(run.run.id).run.policy).toMatchObject({ mode: "dynamic", teamApproval: true });
    expect(restored.store.snapshot(run.run.id).run.policy).not.toHaveProperty("delegation");
    expect(restored.store.delegation(task.delegationId).status).toBe("queued");
    await api(restored, `/api/runs/${run.run.id}/team/proposals/${task.proposalId}/approve`, "POST", {});
    await until(() => restored.store.delegation(task.delegationId).status === "completed");
    expect(registry.get("worker")!.sessions).toHaveLength(1);
  });
  it("delivers a persisted approval notice after restart", async () => {
    const s = await setup(), run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "notice restart" });
    await until(() => s.store.node(run.run.rootNodeId).status === "idle");
    const proposed = await s.kernel.tool(run.run.rootNodeId, "form_team", { rationale: "Build", members: [{ role: "builder", agent: "worker", responsibilities: "Own src" }] }) as { proposalId: string };
    await s.kernel.teams.approve(run.run.id, proposed.proposalId, { note: "Approved before restart" });
    expect(s.store.notices()).toHaveLength(1);
    await s.close(); servers.splice(servers.indexOf(s), 1);
    const restored = await startServer({ home: s.home, port: 0, registry: new FakeDriverRegistry({ lead: idle, worker: idle }), deliveryDebounceMs: 10 }); servers.push(restored);
    await until(() => restored.store.items(run.run.rootNodeId).some((r) => r.item.type === "user_message" && r.item.text.includes("Approved before restart")));
    expect(restored.store.notices()).toHaveLength(0);
  });
  it("keeps the predecessor running during an agent reassign proposal; rejection retains it", async () => {
    const s = await setup({ lead: idle, worker: async (c) => { await c.sleep(10000); }, replacement: idle });
    const run = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "lead", cwd: tmpdir(), prompt: "reassign", team: [member()] });
    const old = await s.kernel.delegate(run.run.rootNodeId, { role: "builder", title: "Build", task: "x" });
    await until(() => s.store.delegation(old.delegationId).status === "running");
    const pending = await s.kernel.tool(run.run.rootNodeId, "reassign", { delegationId: old.delegationId, agent: "replacement", reason: "try another" }) as { delegationId: string; proposalId: string; status: string };
    expect(pending.status).toBe("pending_approval"); expect(s.store.delegation(old.delegationId).status).toBe("running");
    await api(s, `/api/runs/${run.run.id}/team/proposals/${pending.proposalId}/reject`, "POST", { feedback: "Keep the current member" });
    expect(s.store.delegation(old.delegationId).status).toBe("running"); expect(s.store.delegation(pending.delegationId).status).toBe("canceled");
    const next = await s.kernel.tool(run.run.rootNodeId, "reassign", { delegationId: old.delegationId, agent: "replacement", reason: "approved alternative" }) as { delegationId: string; proposalId: string };
    await api(s, `/api/runs/${run.run.id}/team/proposals/${next.proposalId}/approve`, "POST", {});
    await until(() => s.store.delegation(next.delegationId).status === "completed");
    expect(s.store.delegation(old.delegationId)).toMatchObject({ status: "replaced", replacedBy: next.delegationId });
  });
});

describe("dynamic team demo", () => {
  it("stays pending until console approval, replaces the failed member, then completes", async () => {
    const home = await mkdtemp(join(tmpdir(), "baton-teams-")); homes.push(home);
    const s = await startServer({ home, port: 0, fake: true, deliveryDebounceMs: 25 }); servers.push(s);
    const run = await s.kernel.createRun({ projectId: s.store.projects().find((p) => p.name === "Demo project")!.id, agent: "fake-claude", prompt: "Build a feature with a team", policy: { autoApprove: true } });
    await until(() => s.store.snapshot(run.run.id).run.team?.proposals[0]?.status === "pending");
    await delay(100); expect(delegates(s, run.run.id)).toHaveLength(0);
    const formation = s.store.snapshot(run.run.id).run.team!.proposals[0]!;
    await api(s, `/api/runs/${run.run.id}/team/proposals/${formation.id}/approve`, "POST", {});
    await until(() => s.store.snapshot(run.run.id).run.team?.proposals.some((p) => p.kind === "replacement" && p.status === "pending") === true);
    const replacement = s.store.snapshot(run.run.id).run.team!.proposals.find((p) => p.kind === "replacement")!;
    await api(s, `/api/runs/${run.run.id}/team/proposals/${replacement.id}/approve`, "POST", { note: "Try a different specialist" });
    await until(() => {
      const ds = delegates(s, run.run.id);
      return ds.length === 4 && ds.filter((d) => d.status === "completed").length === 3 && s.store.snapshot(run.run.id).run.status === "idle";
    });
    const ds = delegates(s, run.run.id), old = ds.find((d) => d.status === "replaced")!, successor = ds.find((d) => d.replaces === old.id)!;
    expect(successor.brief.context).toContain("src/demo-feature.ts"); expect(successor.status).toBe("completed");
    expect(s.store.snapshot(run.run.id).run.team!.members.filter((m) => m.status === "active")).toHaveLength(3);
  }, 10000);
});
