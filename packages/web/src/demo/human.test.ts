import { describe, expect, it } from "vitest";
import { applyEvent, type PermissionRecord, type RunEventEnvelope } from "@baton/protocol";
import { DemoClient } from "./client.js";
import { parseBatonMessage } from "../lib/baton-messages.js";
import { snapshotInbox } from "../lib/inbox.js";

const base = Date.parse("2026-11-10T07:00:00Z");
describe("human-in-the-loop browser demo", () => {
  it("contains every inbox kind, answers as baton-answer and removes canceled questions", async () => {
    const client = new DemoClient(() => base);
    expect(new Set((await client.inbox()).map(item => item.kind))).toEqual(new Set(["permission", "proposal", "question", "escalation"]));
    const question = (await client.run("run-local-2")).questions[0]!;
    await expect(client.answer(question.id, { answer: " " })).rejects.toThrow("请填写回答");
    await client.answer(question.id, { answer: "默认隐藏" });
    const answered = await client.run(question.runId);
    expect(answered.questions[0]).toMatchObject({ status: "answered", answer: "默认隐藏" });
    const parts = (await client.items(question.nodeId)).items.flatMap(row => row.item.type === "user_message" ? parseBatonMessage(row.item.text) ?? [] : []);
    expect(parts).toContainEqual({ type: "answer", questionId: question.id, text: "默认隐藏" });
    await expect(client.answer(question.id, { answer: "again" })).rejects.toThrow("已处理");
    const fresh = new DemoClient(() => base); await fresh.cancelRun(question.runId);
    expect((await fresh.run(question.runId)).questions[0]!.status).toBe("canceled");
    expect(snapshotInbox(await fresh.run(question.runId))).toHaveLength(0);
  });
  it("extends the held follow-up once, dismisses stalls and cancels escalated subtrees", async () => {
    const client = new DemoClient(() => base); const before = await client.run("run-local-2");
    const round = before.escalations.find(row => row.kind === "round_limit")!;
    await client.resolveEscalation(round.id, { resolution: "extend", extraRounds: 3, note: "补上测试" });
    const extended = await client.run(before.run.id);
    expect(extended.run.policy.maxRoundsPerDelegation).toBe(3);
    expect(extended.delegations.find(edge => edge.id === round.delegationId)!.round).toBe(4);
    expect((await client.items(round.nodeId)).items.some(row => row.item.type === "user_message" && row.item.text === round.pendingMessage)).toBe(true);
    const stall = before.escalations.find(row => row.kind === "stall")!;
    await expect(client.resolveEscalation(stall.id, { resolution: "extend" })).rejects.toThrow("仅轮次上限");
    await client.resolveEscalation(stall.id, { resolution: "dismiss", note: "继续观察" });
    expect((await client.run(before.run.id)).escalations.find(row => row.id === stall.id)!.resolution).toBe("dismiss");
    const fresh = new DemoClient(() => base); await fresh.resolveEscalation(round.id, { resolution: "cancel" });
    const canceled = await fresh.run(before.run.id);
    expect(canceled.nodes.find(node => node.id === round.nodeId)!.status).toBe("canceled");
  });
  it("remembers permissions and records deterministic rule hits before autoApprove", async () => {
    const client = new DemoClient(() => base); const before = await client.run("run-demo"); const pending = before.permissions[0]!;
    await client.decide(pending.requestId, { response: { behavior: "allow" }, remember: { scope: "run", pattern: "npm install", agentOnly: true } });
    expect((await client.permissionRules()).some(rule => rule.pattern === "npm install" && rule.runId === before.run.id && rule.agentId === "claude")).toBe(true);
    const run = await client.run("run-local-2"); const node = run.nodes.find(row => row.role === "builder")!;
    await client.patchRun(run.run.id, { policy: { autoApprove: true } });
    await client.createPermissionRule({ toolName: "shell", pattern: "rm", scope: "global", decision: "deny" });
    const permission: PermissionRecord = { id: "danger", requestId: "danger", nodeId: node.id, runId: run.run.id, requestedAt: new Date(base).toISOString(), status: "pending", request: { id: "danger", name: "shell", kind: "tool", detail: { type: "shell", command: "rm temporary.txt" } } };
    await client.requestPermission(node.id, permission);
    const resolved = (await client.run(run.run.id)).permissions.find(row => row.id === permission.id)!;
    expect(resolved).toMatchObject({ resolvedBy: "rule", resolution: { behavior: "deny" } });
    expect((await client.permissionRules()).find(rule => rule.id === resolved.ruleId)!.hits).toBe(1);
    expect((await client.items(node.id)).items.some(row => row.item.type === "user_message" && row.item.text.includes("Do not retry it"))).toBe(true);
    await client.deletePermissionRule(resolved.ruleId!);
    expect((await client.permissionRules()).some(rule => rule.id === resolved.ruleId)).toBe(false);
  });
  it("emits valid reducer-replayable events through human decisions", async () => {
    const client = new DemoClient(() => base); const initial = await client.run("run-local-2"); const events: RunEventEnvelope[] = [];
    const controller = new AbortController(); const streaming = client.events(initial.run.id, initial.lastSeq, event => events.push(event), controller.signal);
    await client.answer(initial.questions[0]!.id, { answer: "隐藏归档" });
    await client.resolveEscalation(initial.escalations[0]!.id, { resolution: "dismiss" });
    controller.abort(); await streaming;
    let snapshot = initial;
    for (const event of events) {
      expect(event.seq).toBe(snapshot.lastSeq + 1);
      if (event.type === "question") expect(snapshot.nodes.some(node => node.id === event.question.nodeId)).toBe(true);
      if (event.type === "escalation") expect(snapshot.nodes.some(node => node.id === event.escalation.nodeId)).toBe(true);
      snapshot = applyEvent(snapshot, JSON.parse(JSON.stringify(event)) as RunEventEnvelope);
    }
    expect(snapshot).toEqual(await client.run(initial.run.id));
  });
  it("supports human questions in solo mode and enforces the team size cap", async () => {
    const client = new DemoClient(() => base);
    const solo = await client.createRun({ agent: "pi", cwd: "/tmp/demo", prompt: "Inspect", policy: { mode: "solo" } });
    const question = client.askHuman(solo.run.rootNodeId, { question: "Which format?", options: ["JSON", "Markdown"], blocking: true });
    await client.answer(question.id, { answer: "JSON" });
    const answered = await client.run(solo.run.id);
    expect(answered.questions[0]!.status).toBe("answered"); expect(answered.run.team).toBeUndefined(); expect(answered.delegations).toHaveLength(0);
    const team = await client.createRun({ agent: "claude", cwd: "/tmp/demo", prompt: "Build", policy: { maxTeamSize: 1, teamApproval: true } });
    const proposal = team.run.team!.proposals[0]!;
    expect(proposal.members).toHaveLength(1);
    await expect(client.approveTeam(team.run.id, proposal.id, { members: [{ role: "one", agentId: "pi" }, { role: "two", agentId: "codex" }] })).rejects.toThrow("maxTeamSize");
    await client.approveTeam(team.run.id, proposal.id, {});
    await expect(client.addMember(team.run.id, { role: "extra", agentId: "pi" })).rejects.toThrow("maxTeamSize");
    expect(() => client.proposeTeam(team.run.id, [{ role: "extra", agentId: "pi" }], "more")).toThrow("maxTeamSize");
  });
});
