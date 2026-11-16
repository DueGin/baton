import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PermissionResponse, QuestionRecord, RunRecord } from "@baton/protocol";
import { startServer, type BatonServer, type StartServerOptions } from "./api/server.js";
import { FakeDriverRegistry, type FakeScript } from "./driver/fake.js";
import { exportRun } from "./telemetry/index.js";

const servers: BatonServer[] = [], homes: string[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function setup(scripts: Record<string, FakeScript>, options: Partial<StartServerOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "baton-pause-")); homes.push(home);
  const registry = new FakeDriverRegistry(scripts), s = await startServer({ home, port: 0, registry, notifier: () => {}, deliveryDebounceMs: 10, ...options }); servers.push(s);
  const project = await s.kernel.projects.create({ path: tmpdir() });
  const run = await s.kernel.createRun({ projectId: project.id, agent: "root", prompt: "Start", policy: { teamApproval: false, autoApprove: true } });
  return { s, run, registry, root: run.run.rootNodeId, project };
}
async function until(test: () => boolean): Promise<void> { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw new Error("Timed out"); await delay(5); } }
async function api<T>(s: BatonServer, path: string, body?: unknown): Promise<T> {
  const response = await fetch(s.url + path, { method: "POST", headers: { authorization: `Bearer ${s.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(await response.text()); return await response.json() as T;
}
const hold: FakeScript = (c) => c.sleep(100000);
const idle: FakeScript = (c) => c.text("Done");

describe("pause and resume", () => {
  it("interrupts all turns without capturing results, holds messages/delegations/notices and resumes merged content", async () => {
    const { s, run, registry, root, project } = await setup({ root: hold, child: hold, later: idle });
    const child = await s.kernel.delegate(root, { agent: "child", title: "child", task: "Continue child work" });
    await until(() => registry.get("child")!.sessions[0]?.turns === 1);
    await s.kernel.tool(child.nodeId!, "report_result", { status: "success", summary: "Must not capture" });
    const queued = await s.kernel.message(root, "queued before pause");
    const paused = await api<RunRecord>(s, `/api/runs/${run.run.id}/pause`);
    expect(paused.status).toBe("paused"); expect(paused.pauses).toHaveLength(1);
    expect(s.store.snapshot(run.run.id).turns.every((t) => t.status === "canceled" && t.error === "paused by human")).toBe(true);
    expect(s.store.delegation(child.delegationId).result).toBeUndefined();
    expect(s.store.delegation(child.delegationId).deliveredAt).toBeUndefined();
    expect(s.store.list()[0]).toMatchObject({ status: "paused", activeNodeCount: 0 });
    expect((await s.kernel.projects.summary(project.id)).activeRunCount).toBe(0);
    expect((await s.kernel.message(root, "queued during pause", undefined, "interrupt")).delivery).toBe("queued");
    const later = await s.kernel.delegate(root, { agent: "later", title: "later", task: "Start only on resume" });
    await delay(20);
    expect(registry.get("later")!.sessions).toHaveLength(0);
    expect(s.store.delegation(later.delegationId).status).toBe("queued");
    s.store.queueNotice("notice", root, run.run.id, "<baton-notice>Held notice</baton-notice>");
    await api(s, `/api/runs/${run.run.id}/resume`);
    expect(s.store.snapshot(run.run.id).run.pauses?.[0]?.resumedAt).toEqual(expect.any(String));
    await until(() => registry.get("later")!.sessions.length === 1);
    const prompt = registry.get("root")!.sessions[0]!.prompts[1]!;
    expect(prompt).toContain("has now resumed"); expect(prompt).toContain("Held notice");
    expect(prompt).toContain("queued before pause\n\nqueued during pause");
    expect(registry.get("child")!.sessions[0]!.prompts[1]).toContain("has now resumed");
    expect(s.store.snapshot(run.run.id).turns.filter((t) => t.trigger === "resume")).toHaveLength(2);
    expect(s.store.items(root).find((row) => row.seq === queued.itemSeq)?.item).toMatchObject({ delivery: "turn" });
    expect(exportRun(s.store, run.run.id, "md")).toContain("## Pauses");
  });

  it("keeps a paused run and queued content through daemon restart", async () => {
    const { s, root, run } = await setup({ root: hold, child: idle });
    await s.kernel.pauseRun(run.run.id);
    const queued = await s.kernel.message(root, "survives restart");
    const child = await s.kernel.delegate(root, { agent: "child", title: "delayed", task: "start later" }); await delay(10);
    await s.close(); servers.splice(servers.indexOf(s), 1);
    const registry = new FakeDriverRegistry({ root: hold, child: idle });
    const restored = await startServer({ home: s.home, port: 0, registry, notifier: () => {}, deliveryDebounceMs: 10 }); servers.push(restored);
    expect(restored.store.snapshot(run.run.id).run.status).toBe("paused");
    expect(registry.get("root")!.sessions).toHaveLength(0);
    expect(restored.store.delegation(child.delegationId).status).toBe("queued");
    await restored.kernel.resumeRun(run.run.id);
    expect(registry.get("root")!.sessions[0]!.prompts[0]).toContain("has now resumed");
    expect(registry.get("root")!.sessions[0]!.prompts[0]).toContain("survives restart");
    expect(restored.store.items(root).find((row) => row.seq === queued.itemSeq)?.item).toMatchObject({ delivery: "turn" });
    await until(() => restored.store.delegation(child.delegationId).status === "completed");
  });

  it("holds messages on idle nodes and delivers them without a resume notice", async () => {
    const { s, root, run, registry } = await setup({ root: idle });
    await until(() => s.store.node(root).status === "idle"); await s.kernel.pauseRun(run.run.id);
    await s.kernel.message(root, "idle held"); expect(registry.get("root")!.sessions[0]!.prompts).toHaveLength(1);
    await s.kernel.resumeRun(run.run.id);
    expect(registry.get("root")!.sessions[0]!.prompts[1]).toBe("idle held");
  });

  it("waits for an in-flight provider start and interrupts that turn before pause returns", async () => {
    const { s, root, run, registry } = await setup({ root: idle });
    await until(() => s.store.node(root).status === "idle");
    const session = registry.get("root")!.sessions[0]!, original = session.startTurn.bind(session);
    let release = (): void => {}, entered = false;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    registry.get("root")!.options.script = hold;
    session.startTurn = async (prompt) => { entered = true; await waiting; return original(prompt); };
    const sending = s.kernel.message(root, "slow startup"); await until(() => entered);
    const pause = s.kernel.pauseRun(run.run.id); release();
    await sending; await pause;
    expect(s.store.snapshot(run.run.id).run.status).toBe("paused");
    expect(s.store.snapshot(run.run.id).turns.at(-1)).toMatchObject({ status: "canceled", error: "paused by human" });
    expect(s.store.node(root).status).toBe("idle");
  });

  it("merges an undelivered child result into the resume turn", async () => {
    const { s, root, run, registry } = await setup({ root: hold, child: idle }, { deliveryDebounceMs: 100000 });
    const child = await s.kernel.delegate(root, { agent: "child", title: "Finished child", task: "produce a result" });
    await until(() => s.store.delegation(child.delegationId).status === "completed");
    await s.kernel.pauseRun(run.run.id); await s.kernel.resumeRun(run.run.id);
    expect(registry.get("root")!.sessions[0]!.prompts[1]).toContain("<baton-results");
    expect(s.store.delegation(child.delegationId).deliveredVia).toBe("turn");
  });
});

describe("inline questions", () => {
  it.each(["claude", "codex"] as const)("routes %s native questions without permissions or auto-approval", async (provider) => {
    let answer: PermissionResponse | undefined;
    const name = provider === "claude" ? "AskUserQuestion" : "request_user_input";
    const input = { itemId: "call-question", questions: [{ id: "color", header: "Color", question: "Which colors?", options: [{ label: "Blue", description: "Cool" }, { label: "Green" }], multiSelect: true }] };
    const { s, run, root, registry } = await setup({ root: async (c) => {
      c.item({ type: "tool_call", callId: "call-question", name, status: "running", detail: { type: "unknown", input } });
      answer = await c.permission({ id: "native-1", kind: "question", name, input });
      c.text("Continued after native answer");
    } });
    s.kernel.rules.create({ scope: "global", toolName: "*", decision: "allow" });
    await until(() => s.store.snapshot(run.run.id).questions.length === 1);
    const q = s.store.snapshot(run.run.id).questions[0]!;
    expect(answer).toBeUndefined(); expect(s.store.snapshot(run.run.id).permissions).toEqual([]);
    expect(q).toMatchObject({ source: "native", delivery: "inline", anchor: { callId: "call-question", itemSeq: expect.any(Number), turnId: run.turns[0]!.id }, prompts: [{ id: "color", question: "Which colors?", multiSelect: true, allowFreeText: true }] });
    expect(s.store.inbox().filter((item) => item.kind === "permission")).toEqual([]);
    await api(s, `/api/questions/${q.id}/answer`, { answers: { color: ["Blue", "Green", "Other color"] } });
    await until(() => s.store.node(root).status === "idle");
    expect(answer).toMatchObject(provider === "claude" ? { behavior: "allow", updatedInput: { questions: input.questions, answers: { "Which colors?": "Blue, Green, Other color" } } } : { behavior: "allow", updatedInput: { answers: { color: { answers: ["Blue", "Green", "Other color"] } } } });
    expect(registry.get("root")!.sessions[0]!.prompts).toHaveLength(1);
    expect(s.store.question(q.id).status).toBe("answered");
  });

  it("cancels native questions when interrupted or paused, with a reason", async () => {
    const { s, root, run } = await setup({ root: async (c) => {
      if (c.turn <= 2) await c.permission({ id: `q${c.turn}`, name: "AskUserQuestion", kind: "question", input: { questions: [{ question: "Continue?", header: "Continue", options: [] }] } });
      await c.sleep(100000);
    } });
    await until(() => s.store.snapshot(run.run.id).questions.length === 1);
    await s.kernel.message(root, "interrupt", undefined, "interrupt");
    expect(s.store.snapshot(run.run.id).questions[0]).toMatchObject({ status: "canceled", cancelReason: "interrupted by human message" });
    await until(() => s.store.snapshot(run.run.id).questions.length === 2);
    await s.kernel.pauseRun(run.run.id);
    expect(s.store.snapshot(run.run.id).questions[1]).toMatchObject({ status: "canceled", cancelReason: "paused by human" });
  });

  it("times out a blocking MCP question to async, then delivers a late answer", async () => {
    let output: unknown;
    const { s, root, run, registry } = await setup({ root: async (c) => {
      if (c.turn === 1) { output = await c.call("ask_human", { question: "Late decision?", multiSelect: true }); c.text("Other work"); }
    } }, { askTimeoutMinutes: 0.001 });
    await until(() => output !== undefined);
    const q = s.store.snapshot(run.run.id).questions[0]!;
    expect(output).toEqual({ status: "no_answer_yet", questionId: q.id }); expect(q.delivery).toBe("async");
    await api(s, `/api/questions/${q.id}/answer`, { answers: { q1: ["One", "Two"] } });
    await until(() => registry.get("root")!.sessions[0]!.prompts.length === 2);
    expect(registry.get("root")!.sessions[0]!.prompts[1]).toContain("One, Two");
    expect(s.store.node(root).turns).toBe(2);
  });

  it("falls back to async when the session has no long-tool-call capability", async () => {
    const { s, root, run, registry } = await setup({ root: hold });
    const session = registry.get("root")!.sessions[0]!;
    session.supportsLongToolCalls = () => false;
    const output = await s.kernel.tool(root, "ask_human", { question: "Legacy transport?", blocking: true }) as { questionId: string; status: string };
    expect(output.status).toBe("pending"); expect(s.store.question(output.questionId).delivery).toBe("async");
    await api(s, `/api/questions/${output.questionId}/answer`, { answer: "Yes" });
    await until(() => session.steered.some((message) => message.includes("Yes")));
    expect(s.store.snapshot(run.run.id).turns).toHaveLength(1);
  });

  it("answers pi native selection with a value", async () => {
    let answer: PermissionResponse | undefined;
    const { s, run } = await setup({ root: async (c) => { answer = await c.permission({ id: "pi-ask", kind: "question", name: "ask", input: { title: "Direction", message: "Which way?", options: ["Left", "Right"] } }); } });
    await until(() => s.store.snapshot(run.run.id).questions.length === 1);
    const q = s.store.snapshot(run.run.id).questions[0]!;
    expect(q.prompts?.[0]).toMatchObject({ id: "q1", header: "Direction", question: "Which way?", options: [{ label: "Left" }, { label: "Right" }] });
    await api(s, `/api/questions/${q.id}/answer`, { answers: { q1: ["Right"] } });
    expect(answer).toMatchObject({ behavior: "allow", updatedInput: { value: "Right" } });
  });

  it("preserves multiple native prompts and requires an answer to each", async () => {
    let answer: PermissionResponse | undefined;
    const { s, run, root } = await setup({ root: async (c) => {
      answer = await c.permission({ id: "multi", kind: "question", name: "request_user_input", input: { questions: [
        { id: "format", header: "Format", question: "Which format?", options: [{ label: "JSON" }, { label: "Text" }] },
        { id: "notes", header: "Notes", question: "Any notes?", options: [] },
      ] } });
    } });
    await until(() => s.store.snapshot(run.run.id).questions.length === 1);
    const q = s.store.snapshot(run.run.id).questions[0]!;
    expect(q.prompts).toHaveLength(2);
    await expect(s.kernel.human.answer(q.id, { answers: { format: ["JSON"] } })).rejects.toThrow("Answer Notes");
    expect(s.store.question(q.id).status).toBe("pending");
    await api(s, `/api/questions/${q.id}/answer`, { answers: { format: ["JSON"], notes: ["Use UTF-8"] } });
    await until(() => s.store.node(root).status === "idle");
    expect(answer).toMatchObject({ updatedInput: { answers: { format: { answers: ["JSON"] }, notes: { answers: ["Use UTF-8"] } } } });
  });

  it("suppresses stall while waiting inline and preserves ask_human as async on pause", async () => {
    const { s, root, run } = await setup({ root: async (c) => { if (c.turn === 1) await c.call("ask_human", { question: "Pause decision?" }); await c.sleep(100000); } });
    await until(() => s.store.snapshot(run.run.id).questions.length === 1);
    s.kernel.patchRun(run.run.id, { policy: { stallMinutes: 0.0005 } }); await delay(80);
    expect(s.store.snapshot(run.run.id).escalations).toEqual([]);
    const q = s.store.snapshot(run.run.id).questions[0]!;
    await s.kernel.pauseRun(run.run.id);
    expect(s.store.question(q.id)).toMatchObject({ status: "pending", delivery: "async" });
    await api<QuestionRecord>(s, `/api/questions/${q.id}/answer`, { answer: "Go on" });
    await s.kernel.resumeRun(run.run.id);
    const driver = s.kernel.registry as FakeDriverRegistry;
    expect(driver.get("root")!.sessions[0]!.prompts[1]).toContain("Go on");
    expect(driver.get("root")!.sessions[0]!.prompts[1]).toContain("has now resumed");
  });
});
