import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CheckpointChangesResponse, CheckpointRecord, ListCheckpointsResponse, RollbackResponse } from "@baton/protocol";
import { startServer, type BatonServer, type StartServerOptions } from "./api/server.js";
import { FakeDriver, FakeDriverRegistry, type FakeContext, type FakeDriverOptions } from "./driver/fake.js";
import { ROLLBACK_REASON } from "./kernel/index.js";

const servers: BatonServer[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function gate(): { release(): void; wait(c: FakeContext): Promise<void> } {
  let release = (): void => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait: async (c) => {
    c.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(c.signal.reason);
      c.signal.addEventListener("abort", abort, { once: true });
      void ready.then(() => { c.signal.removeEventListener("abort", abort); resolve(); });
    });
  } };
}
/** `write <file> <text>` and `delete <file>` lines change files; everything else just answers. */
async function fileScript(c: FakeContext): Promise<void> {
  for (const [, verb, file, text] of c.prompt.matchAll(/^(write|delete) (\S+) ?(.*)$/gm)) {
    if (verb === "write") await writeFile(join(c.spec.cwd, file!), text ?? ""); else await rm(join(c.spec.cwd, file!), { force: true });
  }
  c.text(`reply ${c.turn}: ${c.prompt.split("\n").at(-1)}`);
}
async function setup(options: FakeDriverOptions = {}, server: Partial<StartServerOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "baton-rollback-home-")), cwd = await mkdtemp(join(tmpdir(), "baton-rollback-cwd-"));
  dirs.push(home, cwd);
  await writeFile(join(cwd, "readme.md"), "v1");
  const driver = new FakeDriver("root", { script: fileScript, ...options });
  const baton = await startServer({ home, port: 0, registry: new FakeDriverRegistry([driver]), notifier: () => {}, deliveryDebounceMs: 10, ...server });
  servers.push(baton);
  const project = await baton.kernel.projects.create({ path: cwd });
  const run = await baton.kernel.createRun({ projectId: project.id, agent: "root", cwd, prompt: "start", policy: { teamApproval: false } });
  const root = run.run.rootNodeId;
  const api = async <T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${baton.url}/api${path}`, { method, headers: { authorization: `Bearer ${baton.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as T };
  };
  const checkpoints = (): CheckpointRecord[] => baton.kernel.rollbacks.list(root).checkpoints;
  const idle = (): Promise<void> => until(() => baton.store.node(root).status === "idle" && !baton.store.snapshot(run.run.id).turns.some((t) => t.status === "running"));
  return { server: baton, driver, run, root, cwd, api, checkpoints, idle, rows: () => baton.store.items(root) };
}
async function until(test: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!test()) { if (Date.now() > end) throw new Error("Timed out waiting for condition"); await delay(5); }
}

describe("rollback checkpoints", () => {
  it("records one on the first prompt and on every human turn, reusing unchanged snapshots", async () => {
    const { server, root, idle, checkpoints, rows } = await setup();
    await idle();
    const first = checkpoints();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ nodeId: root, itemSeq: rows().find((r) => r.item.type === "user_message")!.seq, conversation: "native", files: { ref: expect.any(String) } });
    const sent = await server.kernel.message(root, "nothing changes");
    await idle();
    const second = await server.kernel.message(root, "write a.txt hello");
    await idle();
    const third = await server.kernel.message(root, "plain question");
    await idle();
    const list = checkpoints();
    expect(list.map((c) => c.itemSeq)).toEqual([third.itemSeq, second.itemSeq, sent.itemSeq, first[0]!.itemSeq]);
    // No file changed between the first two: the same ref is reused. The third sees a.txt.
    expect(list[2]!.files!.ref).toBe(list[3]!.files!.ref);
    expect(list[1]!.files!.ref).toBe(list[2]!.files!.ref);
    expect(list[0]!.files!.ref).not.toBe(list[1]!.files!.ref);
  });

  it("covers queued drains (one per batch) and interrupts, but not steering or kernel prompts", async () => {
    const hold = gate();
    const { server, root, idle, checkpoints, driver } = await setup({ steer: true, script: async (c) => { if (c.prompt.includes("hold")) await hold.wait(c); await fileScript(c); } });
    await idle();
    const busy = await server.kernel.message(root, "hold please");
    await until(() => server.store.node(root).status === "running");
    const queuedA = await server.kernel.message(root, "queued one");
    const queuedB = await server.kernel.message(root, "queued two");
    const steered = await server.kernel.message(root, "steer this", undefined, "steer");
    expect([queuedA.delivery, queuedB.delivery, steered.delivery]).toEqual(["queued", "queued", "steered"]);
    hold.release();
    await until(() => checkpoints().length === 3);
    await idle();
    expect(checkpoints().map((c) => c.itemSeq)).toEqual([queuedA.itemSeq, busy.itemSeq, checkpoints().at(-1)!.itemSeq]);
    // 立即发送 interrupts the running turn and opens a new one.
    const hold2 = gate();
    driver.options.script = async (c) => { if (c.prompt.includes("again")) await hold2.wait(c); await fileScript(c); };
    await server.kernel.message(root, "hold again");
    await until(() => server.store.node(root).status === "running");
    const interrupt = await server.kernel.message(root, "right now", undefined, "interrupt");
    expect(interrupt.delivery).toBe("turn");
    await idle();
    expect(checkpoints()[0]!.itemSeq).toBe(interrupt.itemSeq);
    // A delegated child's brief is a kernel prompt: no checkpoint on the child.
    const child = await server.kernel.delegate(root, { agent: "root", title: "child", task: "work" });
    await until(() => server.store.delegation(child.delegationId).status === "completed");
    expect(server.kernel.rollbacks.list(child.nodeId!).checkpoints).toEqual([]);
  });
});

describe("POST /api/nodes/:nodeId/rollback", () => {
  it("previews and restores files (added deleted, modified reverted, deleted restored)", async () => {
    const { server, driver, root, cwd, idle, api } = await setup();
    await idle();
    await writeFile(join(cwd, "gone.md"), "keep me");
    const turn = await server.kernel.message(root, "write readme.md v2\nwrite new.txt created\ndelete gone.md");
    await idle();
    expect(await readFile(join(cwd, "readme.md"), "utf8")).toBe("v2");
    const checkpoint = (await api<ListCheckpointsResponse>(`/nodes/${root}/checkpoints`)).body.checkpoints.find((c) => c.itemSeq === turn.itemSeq)!;
    const changes = await api<CheckpointChangesResponse>(`/checkpoints/${checkpoint.id}/changes`);
    expect(changes.body.files).toEqual([{ path: "gone.md", status: "deleted" }, { path: "new.txt", status: "added" }, { path: "readme.md", status: "modified" }]);
    const result = await api<RollbackResponse>(`/nodes/${root}/rollback`, "POST", { checkpointId: checkpoint.id, mode: "files" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ mode: "files", files: ["gone.md", "new.txt", "readme.md"] });
    expect(await readFile(join(cwd, "readme.md"), "utf8")).toBe("v1");
    expect(await readFile(join(cwd, "gone.md"), "utf8")).toBe("keep me");
    expect(existsSync(join(cwd, "new.txt"))).toBe(false);
    // Files only: the conversation stays, and the agent hears about the restore with its next prompt.
    expect(server.store.items(root).some((r) => r.rolledBack)).toBe(false);
    await server.kernel.message(root, "what now");
    await idle();
    expect(server.store.items(root).filter((r) => r.rolledBack)).toEqual([]);
    const prompt = driver.sessions.at(-1)!.prompts.at(-1)!;
    expect(prompt).toContain("restored the files");
    expect(prompt.endsWith("what now")).toBe(true);
    // The transcript shows only the human's text.
    expect(server.store.items(root).find((r) => r.item.type === "user_message" && r.item.text === "what now")).toBeDefined();
  });

  it("resumes a node interrupted by a files-only rollback", async () => {
    const hold = gate();
    const { server, driver, root, cwd, idle, checkpoints } = await setup({ script: async (c) => { await fileScript(c); if (c.prompt.includes("slow")) await hold.wait(c); } });
    await idle();
    const turn = await server.kernel.message(root, "write wip.txt partial\nslow work");
    await until(() => existsSync(join(cwd, "wip.txt")) && server.store.node(root).status === "running");
    const result = await server.kernel.rollbacks.rollback(root, { checkpointId: checkpoints().find((c) => c.itemSeq === turn.itemSeq)!.id, mode: "files" });
    expect(result).toEqual({ mode: "files", files: ["wip.txt"] });
    expect(existsSync(join(cwd, "wip.txt"))).toBe(false);
    await until(() => driver.sessions[0]!.prompts.some((p) => p.includes("restored the files") && p.includes("Continue where you left off")));
    await idle();
    expect(server.store.items(root).some((r) => r.rolledBack)).toBe(false);
  });

  it("rewinds the conversation natively, flags rows, returns the draft and continues from the fork", async () => {
    const { server, driver, root, idle, rows, checkpoints, api } = await setup();
    await idle();
    await server.kernel.message(root, "second");
    await idle();
    const third = await server.kernel.message(root, "third message");
    await idle();
    const before = server.store.node(root).persistence;
    const checkpoint = checkpoints().find((c) => c.itemSeq === third.itemSeq)!;
    const result = await api<RollbackResponse>(`/nodes/${root}/rollback`, "POST", { checkpointId: checkpoint.id, mode: "conversation" });
    expect(result.body).toEqual({ mode: "conversation", draft: "third message", conversation: "native", canceledDelegations: [] });
    expect(driver.rewinds).toEqual([expect.objectContaining({ turns: 2 })]);
    const flagged = rows().filter((r) => r.rolledBack);
    expect(flagged[0]!.seq).toBe(third.itemSeq);
    expect(flagged.map((r) => r.item.type)).toEqual(["user_message", "assistant_message"]);
    expect(rows().filter((r) => !r.rolledBack).map((r) => r.item.type === "user_message" || r.item.type === "assistant_message" ? r.item.text : "")).toEqual(["start", "reply 1: start", "second", "reply 2: second"]);
    // GET items still returns the rolled-back rows, flagged.
    const items = await api<{ items: Array<{ seq: number; rolledBack?: boolean }> }>(`/nodes/${root}/items`);
    expect(items.body.items.filter((r) => r.rolledBack).map((r) => r.seq)).toEqual(flagged.map((r) => r.seq));
    expect(server.store.node(root).persistence).not.toEqual(before);
    // The edited message resumes the forked session: it is the conversation's third turn again.
    await server.kernel.message(root, "third, edited");
    await idle();
    const session = driver.sessions.at(-1)!;
    expect(session.prompts).toEqual(["third, edited"]);
    expect(rows().at(-1)!.item).toMatchObject({ type: "assistant_message", text: "reply 3: third, edited" });
    // The same message cannot be rolled back twice.
    const again = await api<{ error: { message: string } }>(`/nodes/${root}/rollback`, "POST", { checkpointId: checkpoint.id, mode: "conversation" });
    expect(again.status).toBe(409);
  });

  it("replays the earlier transcript into a fresh session for agents without native rewind", async () => {
    const { server, driver, root, idle, checkpoints } = await setup({ rewind: false });
    await idle();
    await server.kernel.message(root, "remember the number 42");
    await idle();
    const target = await server.kernel.message(root, "forget it");
    await idle();
    expect(checkpoints()[0]).toMatchObject({ itemSeq: target.itemSeq, conversation: "replay" });
    const result = await server.kernel.rollbacks.rollback(root, { checkpointId: checkpoints()[0]!.id, mode: "conversation" });
    expect(result).toMatchObject({ conversation: "replay", draft: "forget it" });
    expect(server.store.node(root).persistence).toBeUndefined();
    const sessions = driver.sessions.length;
    await server.kernel.message(root, "what was the number?");
    await idle();
    expect(driver.sessions.length).toBe(sessions + 1);
    const prompt = driver.sessions.at(-1)!.prompts[0]!;
    expect(prompt).toContain("<baton-replay>");
    expect(prompt).toContain("[human] remember the number 42");
    expect(prompt).toContain("[you] reply 2: remember the number 42");
    expect(prompt).not.toContain("forget it");
    expect(prompt.endsWith("what was the number?")).toBe(true);
    // The transcript keeps only what the human sent.
    expect(server.store.items(root).at(-2)!.item).toMatchObject({ type: "user_message", text: "what was the number?" });
  });

  it("interrupts running turns without pausing and cancels delegations started after the checkpoint", async () => {
    const hold = gate();
    const { server, driver, root, run, idle, checkpoints, api } = await setup({ script: async (c) => { if (c.prompt.includes("<baton-assignment") || c.prompt.includes("<baton-notice")) { await hold.wait(c); return; } if (c.prompt.includes("hold")) await hold.wait(c); await fileScript(c); } });
    await idle();
    const early = await server.kernel.delegate(root, { agent: "root", title: "early child", task: "keep working" });
    const turn = await server.kernel.message(root, "hold and delegate");
    await until(() => server.store.node(root).status === "running");
    const late = await server.kernel.delegate(root, { agent: "root", title: "late child", task: "rolled back" });
    await until(() => server.store.node(late.nodeId!).status === "running" && server.store.node(early.nodeId!).status === "running");
    const checkpoint = checkpoints().find((c) => c.itemSeq === turn.itemSeq)!;
    const result = await api<RollbackResponse>(`/nodes/${root}/rollback`, "POST", { checkpointId: checkpoint.id, mode: "both" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ mode: "both", draft: "hold and delegate", canceledDelegations: [late.delegationId], files: [] });
    const s = server.store.snapshot(run.run.id);
    expect(s.run.status).not.toBe("paused");
    expect(s.turns.find((t) => t.nodeId === root && t.status === "canceled")?.error).toBe(ROLLBACK_REASON);
    expect(server.store.delegation(late.delegationId).status).toBe("canceled");
    expect(server.store.node(late.nodeId!).status).toBe("canceled");
    // The early child keeps its delegation and was restarted with a notice.
    await until(() => driver.sessions.some((session) => session.spec.title === "early child" && session.prompts.some((p) => p.includes("restored the files"))));
    expect(server.store.delegation(early.delegationId).status).toBe("running");
    // The canceled delegation never reports back to the root.
    await delay(100);
    expect(server.store.node(root).turns).toBe(2);
    hold.release();
    // The early child's result still reaches the root.
    await until(() => server.store.delegation(early.delegationId).status === "completed" && server.store.node(root).turns === 3);
    await idle();
  });

  it("answers 409 for unavailable modes and 400/404 for bad requests", async () => {
    const { server, root, idle, checkpoints, api } = await setup({}, { fileCheckpoints: false });
    await idle();
    const checkpoint = checkpoints()[0]!;
    expect(checkpoint.files).toBeUndefined();
    const files = await api<{ error: { message: string } }>(`/nodes/${root}/rollback`, "POST", { checkpointId: checkpoint.id, mode: "files" });
    expect(files.status).toBe(409);
    expect(files.body.error.message).toContain("没有文件快照");
    expect((await api(`/nodes/${root}/rollback`, "POST", { checkpointId: checkpoint.id, mode: "both" })).status).toBe(409);
    expect((await api(`/checkpoints/${checkpoint.id}/changes`)).status).toBe(409);
    expect((await api(`/nodes/${root}/rollback`, "POST", { checkpointId: checkpoint.id, mode: "everything" })).status).toBe(400);
    expect((await api(`/nodes/${root}/rollback`, "POST", { checkpointId: "cp_missing", mode: "files" })).status).toBe(404);
    const child = await server.kernel.delegate(root, { agent: "root", title: "child", task: "work" });
    await until(() => server.store.delegation(child.delegationId).status === "completed");
    expect((await api(`/nodes/${child.nodeId}/rollback`, "POST", { checkpointId: checkpoint.id, mode: "conversation" })).status).toBe(409);
  });
});
