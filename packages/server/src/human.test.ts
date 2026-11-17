import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyEvent, type InboxItem, type PermissionResponse, type PermissionRule, type RunPolicy, type RunSnapshot } from "@baton/protocol";
import { startServer, type BatonServer, type StartServerOptions } from "./api/server.js";
import { FakeDriverRegistry, type FakeScript } from "./driver/fake.js";
import { HUMAN_DENIAL } from "./kernel/permission-rules.js";
import { exportRun } from "./telemetry/index.js";
const servers: BatonServer[] = [], homes: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const idle: FakeScript = (c) => { c.text("Done"); };
async function setup(scripts: Record<string, FakeScript> = { root: idle, child: idle }, options: Partial<StartServerOptions> = {}): Promise<BatonServer> {
  const home = await mkdtemp(join(tmpdir(), "baton-human-")); homes.push(home);
  const s = await startServer({ home, port: 0, registry: new FakeDriverRegistry(scripts), deliveryDebounceMs: 15, notifier: () => {}, ...options }); servers.push(s); return s;
}
async function until(test: () => boolean, timeout = 4000): Promise<void> { const end = Date.now() + timeout; while (!test()) { if (Date.now() > end) throw new Error("Timed out"); await delay(5); } }
async function api<T>(s: BatonServer, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(s.url + path, { method, headers: { authorization: `Bearer ${s.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text()); return await response.json() as T;
}
async function create(s: BatonServer, policy: Partial<RunPolicy> = {}): Promise<RunSnapshot> { return s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: tmpdir() })).id, agent: "root", cwd: tmpdir(), prompt: "test", policy: { teamApproval: false, ...policy } }); }

describe("human questions", () => {
  it("asks a blocking question over MCP and continues below the card in the same turn", async () => {
    let received: unknown;
    const s = await setup({ root: idle, child: async (c) => {
      received = await c.call("ask_human", { question: "Which output format?", options: ["JSON", "Markdown"], blocking: true });
      c.text("Continued after answer");
      await c.call("report_result", { status: "success", summary: "Used Markdown" });
    } });
    const run = await create(s), d = await s.kernel.delegate(run.run.rootNodeId, { agent: "child", title: "Question", task: "x" });
    await until(() => s.store.snapshot(run.run.id).questions.length === 1);
    const q = s.store.snapshot(run.run.id).questions[0]!;
    expect(s.store.node(d.nodeId!).activity).toBe("等你回答: Which output format?");
    expect(q).toMatchObject({ source: "ask_human", delivery: "inline", anchor: { itemSeq: expect.any(Number), callId: expect.any(String), turnId: expect.any(String) } });
    expect(received).toBeUndefined();
    await api(s, `/api/questions/${q.id}/answer`, "POST", { answer: "Markdown" });
    await until(() => s.store.delegation(d.delegationId).status === "completed");
    expect(received).toMatchObject({ status: "answered", answer: "Markdown", answers: { q1: ["Markdown"] } });
    expect(s.store.snapshot(run.run.id).turns.filter((t) => t.nodeId === d.nodeId)).toHaveLength(1);
    expect(exportRun(s.store, run.run.id, "md")).toContain("## Questions"); expect(exportRun(s.store, run.run.id, "otlp")).toContain("baton.questions");
    const snap = s.store.snapshot(run.run.id); expect(s.store.events(run.run.id).reduce(applyEvent, { ...snap, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], questions: [], escalations: [], lastSeq: 0 })).toEqual(snap);
  });
  it("lets the human close a question without answering; the agent is told and carries on", async () => {
    let received: unknown;
    const s = await setup({ root: async (c) => { if (c.turn === 1) await c.call("ask_human", { question: "Optional detail?", blocking: false }); }, child: async (c) => {
      received = await c.call("ask_human", { question: "Which output format?", options: ["JSON", "Markdown"], blocking: true });
      c.text("Picked JSON myself");
      await c.call("report_result", { status: "success", summary: "Used JSON" });
    } });
    const run = await create(s), d = await s.kernel.delegate(run.run.rootNodeId, { agent: "child", title: "Question", task: "x" });
    await until(() => s.store.snapshot(run.run.id).questions.some((q) => q.nodeId === d.nodeId));
    const blocking = s.store.snapshot(run.run.id).questions.find((q) => q.nodeId === d.nodeId)!;
    const declined = await api<{ status: string; declinedAt?: string }>(s, `/api/questions/${encodeURIComponent(blocking.id)}/decline`, "POST");
    expect(declined).toMatchObject({ status: "canceled", declinedAt: expect.any(String) });
    await until(() => s.store.delegation(d.delegationId).status === "completed");
    expect(received).toMatchObject({ status: "declined", message: expect.stringContaining("without answering") });
    expect(s.store.node(d.nodeId!).activity).not.toContain("等你回答");
    // An async question gets a notice so an idle agent is not left waiting for an answer forever.
    const asynchronous = s.store.snapshot(run.run.id).questions.find((q) => q.nodeId === run.run.rootNodeId)!;
    await api(s, `/api/questions/${asynchronous.id}/decline`, "POST");
    const prompts = () => (s.kernel.registry as FakeDriverRegistry).get("root")!.sessions[0]!;
    await until(() => [...prompts().prompts, ...prompts().steered].some((m) => m.includes('declined="true"')));
    await expect(api(s, `/api/questions/${asynchronous.id}/decline`, "POST")).rejects.toThrow(/not pending/);
  });
  it("delivers a nonblocking answer by steer while working, keeps asynchronous questions on completion", async () => {
    const s = await setup({ root: async (c) => { if (c.turn === 1) { await c.call("ask_human", { question: "Preference?", blocking: false }); await c.sleep(500); } }, child: async (c) => { await c.call("ask_human", { question: "Optional?", blocking: false }); c.text("Done anyway"); } });
    const run = await create(s); await until(() => s.store.snapshot(run.run.id).questions.length === 1);
    const q = s.store.snapshot(run.run.id).questions[0]!; await api(s, `/api/questions/${q.id}/answer`, "POST", { answer: "Blue" });
    await until(() => (s.kernel.registry as FakeDriverRegistry).get("root")!.sessions[0]!.steered.some((m) => m.includes("Blue")));
    const child = await s.kernel.delegate(run.run.rootNodeId, { agent: "child", title: "optional", task: "x" });
    await until(() => s.store.delegation(child.delegationId).status === "completed");
    expect(s.store.snapshot(run.run.id).questions.find((q) => q.nodeId === child.nodeId)?.status).toBe("pending");
    await s.kernel.tool(run.run.rootNodeId, "ask_human", { question: "Still needed?", blocking: false }); await s.kernel.cancelRun(run.run.id);
    expect(s.store.snapshot(run.run.id).questions.filter((q) => q.status === "pending")).toHaveLength(0);
  });
  it("solo advertises only ask_human and calls it through real MCP", async () => {
    const s = await setup({ root: async (c) => { if (c.turn === 1) await c.call("ask_human", { question: "Solo decision?", blocking: true }); } });
    const run = await create(s, { mode: "solo" }); await until(() => s.store.snapshot(run.run.id).questions.length === 1);
    const config = (s.kernel.registry as FakeDriverRegistry).get("root")!.sessions[0]!.spec.mcpServers.baton;
    if (!config || config.type !== "http") throw new Error("No MCP");
    const client = new Client({ name: "test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(config.url)));
    try { expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ask_human"]); expect((await client.callTool({ name: "delegate", arguments: {} })).isError).toBe(true); }
    finally { await client.close(); }
    await api(s, `/api/questions/${s.store.snapshot(run.run.id).questions[0]!.id}/answer`, "POST", { answer: "Continue" });
  });
});

describe("supervision", () => {
  it("raises stall once per eventless episode, resets on driver events, notifies parent", async () => {
    let emit: (() => void) | undefined;
    const s = await setup({ root: async (c) => { await c.sleep(10000); }, child: async (c) => { emit = () => c.text("heartbeat"); await c.sleep(10000); } });
    const run = await create(s, { stallMinutes: 0.002 });
    const child = await s.kernel.delegate(run.run.rootNodeId, { agent: "child", title: "Slow", task: "x" });
    await until(() => !!emit); await delay(70); emit!(); await delay(70);
    expect(s.store.snapshot(run.run.id).escalations.filter((e) => e.nodeId === child.nodeId)).toHaveLength(0);
    await until(() => s.store.snapshot(run.run.id).escalations.some((e) => e.nodeId === child.nodeId)); await delay(150);
    expect(s.store.snapshot(run.run.id).escalations.filter((e) => e.nodeId === child.nodeId)).toHaveLength(1);
    expect((s.kernel.registry as FakeDriverRegistry).get("root")!.sessions[0]!.steered.some((m) => m.startsWith('<baton-notice kind="system">') && m.includes("appears stalled"))).toBe(true);
    emit!(); await until(() => s.store.snapshot(run.run.id).escalations.filter((e) => e.nodeId === child.nodeId).length === 2);
    const e = s.store.snapshot(run.run.id).escalations.find((e) => e.nodeId === child.nodeId)!;
    await api(s, `/api/escalations/${e.id}/resolve`, "POST", { resolution: "dismiss", note: "Expected delay" }); expect(s.store.escalation(e.id).resolution).toBe("dismiss");
    expect(exportRun(s.store, run.run.id, "md")).toContain("## Escalations");
  });
  it.each(["extend", "cancel", "dismiss"] as const)("escalates beyond round limit and handles %s", async (resolution) => {
    const messages: string[] = [];
    const s = await setup({ root: idle, child: async (c) => { messages.push(c.prompt); c.text(`round ${c.turn}`); } });
    const run = await create(s, { maxRoundsPerDelegation: 1 }), child = await s.kernel.delegate(run.run.rootNodeId, { agent: "child", title: "Review", task: "x" });
    await until(() => s.store.delegation(child.delegationId).status === "completed");
    const result = await s.kernel.tool(run.run.rootNodeId, "send", { delegationId: child.delegationId, message: "Fix the edge case" }) as { status: string; escalationId: string };
    expect(result.status).toBe("escalated"); expect(s.store.delegation(child.delegationId).round).toBe(1); expect(messages).toHaveLength(1);
    await api(s, `/api/escalations/${result.escalationId}/resolve`, "POST", { resolution, extraRounds: 2, note: "Human decision" });
    if (resolution === "extend") { await until(() => messages.length === 2); expect(messages[1]).toBe(`<baton-followup delegation="${child.delegationId}">\nFix the edge case\n</baton-followup>`); expect(s.store.delegation(child.delegationId).round).toBe(2); }
    if (resolution === "cancel") expect(s.store.delegation(child.delegationId).status).toBe("canceled");
    if (resolution === "dismiss") expect(messages).toHaveLength(1);
    await until(() => s.store.items(run.run.rootNodeId).some((r) => r.item.type === "user_message" && r.item.text.includes('<baton-notice kind="system">') && r.item.text.includes("Human decision")));
  });
});

describe("permission rules", () => {
  it("matches command prefixes, case-insensitive tool/agent scope, deny before allow and run before global", async () => {
    const responses: PermissionResponse[] = [];
    const s = await setup({ root: async (c) => { responses.push(await c.permission({ id: "shell", name: "Shell", kind: "tool", detail: { type: "shell", command: "npm   test -- --run" } })); } });
    const globalAllow = s.kernel.rules.create({ scope: "global", toolName: "shell", pattern: "npm test", decision: "allow" });
    s.kernel.rules.create({ scope: "global", toolName: "Shell", pattern: "npm test", decision: "deny", agentId: "another-agent" });
    const run = await create(s); await until(() => responses.length === 1);
    expect(responses[0]?.behavior).toBe("allow"); expect(s.store.snapshot(run.run.id).permissions[0]).toMatchObject({ resolvedBy: "rule", ruleId: globalAllow.id });
    expect(s.store.rules().find((r) => r.id === globalAllow.id)).toMatchObject({ hits: 1, lastHitAt: expect.any(String) });
    const localAllow = s.kernel.rules.create({ scope: "run", runId: run.run.id, toolName: "*", pattern: "npm test", decision: "allow" });
    await s.kernel.message(run.run.rootNodeId, "second"); await until(() => responses.length === 2);
    expect(s.store.snapshot(run.run.id).permissions[0]?.ruleId).toBe(localAllow.id);
    const deny = s.kernel.rules.create({ scope: "global", toolName: "Shell", pattern: "npm test", decision: "deny" });
    await s.kernel.message(run.run.rootNodeId, "third"); await until(() => responses.length === 3);
    expect(responses[2]?.behavior).toBe("deny"); expect(s.store.snapshot(run.run.id).permissions[0]?.ruleId).toBe(deny.id);
    s.store.deleteRule(deny.id); s.store.deleteRule(globalAllow.id); s.store.deleteRule(localAllow.id);
    s.kernel.rules.create({ scope: "global", toolName: "Shell", pattern: "npm testing", decision: "allow" });
    await s.kernel.message(run.run.rootNodeId, "fourth"); await until(() => s.store.snapshot(run.run.id).permissions[0]?.status === "pending");
    expect(responses).toHaveLength(3); // A prefix must end at an argument boundary.
  });
  it("matches relative file globs and records remembered decisions and fixed human denial", async () => {
    const responses: PermissionResponse[] = [];
    const s = await setup({ root: async (c) => { responses.push(await c.permission({ id: `read-${c.turn}`, name: "ReadFile", kind: "tool", detail: { type: "read", filePath: join(tmpdir(), "src/nested/file.ts") } })); } });
    const run = await create(s); await until(() => s.store.snapshot(run.run.id).permissions.length === 1);
    const p = s.store.snapshot(run.run.id).permissions[0]!;
    await api(s, `/api/permissions/${encodeURIComponent(p.id)}`, "POST", { response: { behavior: "deny", message: "custom" }, remember: { scope: "run", pattern: "src/**", agentOnly: true } });
    await until(() => responses.length === 1); expect(responses[0]).toMatchObject({ behavior: "deny", message: HUMAN_DENIAL });
    const rules = await api<PermissionRule[]>(s, "/api/permission-rules"); expect(rules[0]).toMatchObject({ createdFrom: p.id, scope: "run", runId: run.run.id, agentId: "root", pattern: "src/**" });
    await s.kernel.message(run.run.rootNodeId, "again"); await until(() => responses.length === 2);
    expect(s.store.snapshot(run.run.id).permissions.at(-1)).toMatchObject({ resolvedBy: "rule", ruleId: rules[0]!.id });
    expect(s.store.rules()[0]?.hits).toBe(1);
    await api(s, `/api/permission-rules/${rules[0]!.id}`, "DELETE"); expect(s.store.rules()).toHaveLength(0);
    await s.kernel.message(run.run.rootNodeId, "allow next"); await until(() => s.store.snapshot(run.run.id).permissions.at(-1)?.status === "pending");
    const next = s.store.snapshot(run.run.id).permissions.at(-1)!;
    await api(s, `/api/permissions/${encodeURIComponent(next.id)}`, "POST", { response: { behavior: "allow" }, remember: { scope: "global", pattern: "src/**" } });
    await until(() => responses.length === 3); expect(s.store.rules()[0]?.decision).toBe("allow");
  });
  it("auto-allows baton tools before rules, applies rules before autoApprove", async () => {
    const responses: PermissionResponse[] = [];
    const s = await setup({ root: async (c) => { responses.push(await c.permission({ id: "baton", name: "mcp__baton__ask_human", kind: "tool" })); responses.push(await c.permission({ id: "shell", name: "Shell", kind: "tool", input: { command: "rm file" } })); } });
    s.kernel.rules.create({ scope: "global", toolName: "*", decision: "deny" });
    const run = await create(s, { autoApprove: true }); await until(() => responses.length === 2);
    expect(responses.map((r) => r.behavior)).toEqual(["allow", "deny"]);
    expect(s.store.snapshot(run.run.id).permissions.map((p) => p.resolvedBy)).toEqual(["policy", "rule"]);
  });
});

describe("human interaction recovery", () => {
  it("persists questions, rules and round extensions through a daemon restart", async () => {
    const s = await setup({ root: async (c) => { if (c.turn === 1) await c.call("ask_human", { question: "Persist?", blocking: true }); }, child: idle });
    const run = await create(s); await until(() => s.store.snapshot(run.run.id).questions.length === 1);
    const q = s.store.snapshot(run.run.id).questions[0]!;
    const rule = s.kernel.rules.create({ toolName: "Read", scope: "global", pattern: "src/**", decision: "allow" });
    const child = await s.kernel.delegate(run.run.rootNodeId, { agent: "child", title: "child", task: "x" });
    await until(() => s.store.delegation(child.delegationId).status === "completed"); s.store.extendRounds(child.delegationId, 2);
    await s.close(); servers.splice(servers.indexOf(s), 1);
    const restored = await startServer({ home: s.home, port: 0, registry: new FakeDriverRegistry({ root: idle, child: idle }), deliveryDebounceMs: 5, notifier: () => {} }); servers.push(restored);
    expect(restored.store.question(q.id).status).toBe("pending"); expect(restored.store.rules()[0]?.id).toBe(rule.id); expect(restored.store.extraRounds(child.delegationId)).toBe(2);
    await api(restored, `/api/questions/${q.id}/answer`, "POST", { answer: "Restored" });
    await until(() => restored.store.items(run.run.rootNodeId).some((r) => r.item.type === "user_message" && r.item.text.includes("Restored")));
  });
});

describe("inbox, notifications and team cap", () => {
  it("aggregates oldest-first pending items and pendingTotal; emits debounced SSE changed", async () => {
    const s = await setup({ root: async (c) => { if (c.turn === 1) await c.call("ask_human", { question: "First?", blocking: true }); }, child: idle });
    const first = await create(s); await until(() => s.store.snapshot(first.run.id).questions.length === 1);
    await delay(5); const second = await create(s); await until(() => s.store.snapshot(second.run.id).questions.length === 1);
    const inbox = await api<InboxItem[]>(s, "/api/inbox"); expect(inbox.map((i) => i.runId)).toEqual([first.run.id, second.run.id]); expect(inbox[0]?.runTitle).toBe("test");
    expect(s.store.list().every((r) => r.pendingTotal === 1)).toBe(true);
    const controller = new AbortController();
    const response = await fetch(`${s.url}/api/inbox/events?token=${s.token}`, { headers: { accept: "text/event-stream" }, signal: controller.signal }); const reader = response.body!.getReader();
    const question = s.store.snapshot(first.run.id).questions[0]!;
    await api(s, `/api/questions/${question.id}/answer`, "POST", { answer: "Yes" });
    const read = await reader.read(); expect(new TextDecoder().decode(read.value)).toContain("event: changed"); controller.abort(); await reader.cancel().catch(() => {});
    expect(s.store.list().find((r) => r.id === first.run.id)?.pendingTotal).toBe(0);
    await s.kernel.tool(second.run.rootNodeId, "form_team", { rationale: "proposed", members: [{ role: "builder", agent: "child", responsibilities: "Own src" }] });
    // create() opts out of approval: create a proposal with an explicit policy update.
    s.kernel.patchRun(second.run.id, { policy: { teamApproval: true } });
    await s.kernel.tool(second.run.rootNodeId, "form_team", { rationale: "proposed", members: [{ role: "reviewer", agent: "child", responsibilities: "Own tests" }] });
    expect(s.store.inbox().some((i) => i.kind === "proposal")).toBe(true);
    expect(s.store.list().find((r) => r.id === second.run.id)?.pendingTotal).toBe(2);
  });
  it("coalesces pending notifications per run and notifies completion with injected notifier", async () => {
    const sent: Array<{ runId: string; body: string }> = [];
    const s = await setup({ root: async (c) => { void c.call("ask_human", { question: "One?", blocking: true }).catch(() => {}); await c.call("ask_human", { question: "Two?", blocking: true }); } }, { notifier: (n) => { sent.push(n); }, notificationCoalesceMs: 60 });
    const run = await create(s); await until(() => sent.length === 1); expect(sent[0]?.body).toContain("2 item(s)");
    await delay(90); expect(sent).toHaveLength(1);
    const other = await setup({ root: idle }, { notifier: (n) => { sent.push(n); }, notificationCoalesceMs: 15 });
    await create(other); await until(() => sent.length === 2); expect(sent[1]?.body).toContain("completed"); expect(sent[0]?.runId).toBe(run.run.id);
  });
  it("rejects formation/additions over maxTeamSize, preserves existing lead team rules", async () => {
    const s = await setup(), run = await create(s, { maxTeamSize: 1 });
    await expect(s.kernel.tool(run.run.rootNodeId, "form_team", { rationale: "too large", members: ["builder", "reviewer"].map((role) => ({ role, agent: "child", responsibilities: "Send me: scoped work; don't send me: other files" })) })).rejects.toThrow(/maxTeamSize/);
    await s.kernel.teams.add(run.run.id, { role: "builder", agentId: "child" });
    await expect(s.kernel.teams.add(run.run.id, { role: "reviewer", agentId: "child" })).rejects.toThrow(/maxTeamSize/);
    await expect(create(s, { stallMinutes: -1 })).rejects.toThrow(/stallMinutes/);
    const prompt = (s.kernel.registry as FakeDriverRegistry).get("root")!.sessions[0]!.spec.systemPrompt!; expect(prompt).toContain("Reuse existing members first"); expect(prompt).toContain("Send me:");
  });
  it("loads notifications.desktop=false config without starting external notification processes", async () => {
    const home = await mkdtemp(join(tmpdir(), "baton-human-")); homes.push(home); await writeFile(join(home, "config.json"), JSON.stringify({ notifications: { desktop: false } }));
    const s = await startServer({ home, port: 0, registry: new FakeDriverRegistry({ root: idle }), notificationCoalesceMs: 1 }); servers.push(s); await create(s); await delay(25);
  });
});
