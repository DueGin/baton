import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSessionEntry, RunPolicy, RunSnapshot } from "@baton/protocol";
import { startServer, type BatonServer } from "./api/server.js";
import { FakeDriverRegistry, type FakeScript } from "./driver/fake.js";
import { MESSAGE_CHAIN_LIMIT } from "./kernel/index.js";

const servers: BatonServer[] = [], dirs: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const idle: FakeScript = (c) => { c.text("Done"); };
async function temp(prefix: string): Promise<string> { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; }
async function setup(scripts: Record<string, FakeScript>): Promise<BatonServer> {
  const s = await startServer({ home: await temp("baton-sessions-"), port: 0, registry: new FakeDriverRegistry(scripts), deliveryDebounceMs: 15, notifier: () => {} }); servers.push(s); return s;
}
async function until(test: () => boolean, timeout = 4000): Promise<void> { const end = Date.now() + timeout; while (!test()) { if (Date.now() > end) throw new Error("Timed out"); await delay(5); } }
/** A run in its own project directory (so projects differ by name and path). */
async function run(s: BatonServer, agent: string, project: string, policy: Partial<RunPolicy> = {}): Promise<RunSnapshot> {
  const dir = await temp(`${project}-`);
  const created = await s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: dir, name: project })).id, agent, cwd: dir, prompt: `${project} work`, policy: { teamApproval: false, ...policy } });
  await until(() => s.store.node(created.run.rootNodeId).status === "idle");
  return created;
}
const turns = (s: BatonServer, nodeId: string) => s.store.snapshot(s.store.node(nodeId).runId).turns.filter((t) => t.nodeId === nodeId);
const settled = (s: BatonServer, nodeId: string, count: number) => () => { const list = turns(s, nodeId); return list.length >= count && list.every((t) => t.status !== "running"); };

describe("agent sessions talk by Agent ID", () => {
  it("lists every session across runs and projects, newest first, with filters", async () => {
    const s = await setup({ alpha: idle, beta: idle });
    const a = await run(s, "alpha", "atlas"), b = await run(s, "beta", "borealis");
    const all = await s.kernel.tool(a.run.rootNodeId, "list_sessions", {}) as { you: string; total: number; sessions: AgentSessionEntry[] };
    expect(all.you).toBe(a.run.rootNodeId);
    expect(all.sessions.map((entry) => entry.agentId).sort()).toEqual([a.run.rootNodeId, b.run.rootNodeId].sort());
    expect(all.sessions.find((entry) => entry.agentId === a.run.rootNodeId)).toMatchObject({ you: true, agent: "alpha", role: "lead", run: { id: a.run.id }, project: { name: "atlas" } });
    expect(all.sessions.find((entry) => entry.agentId === b.run.rootNodeId)).not.toHaveProperty("you");
    const query = await s.kernel.tool(a.run.rootNodeId, "list_sessions", { query: "beta borealis" }) as { sessions: AgentSessionEntry[] };
    expect(query.sessions.map((entry) => entry.agentId)).toEqual([b.run.rootNodeId]);
    const scoped = await s.kernel.tool(a.run.rootNodeId, "list_sessions", { project: "atlas" }) as { sessions: AgentSessionEntry[] };
    expect(scoped.sessions.map((entry) => entry.agentId)).toEqual([a.run.rootNodeId]);
    // Archived projects drop out of the directory and cannot be messaged.
    s.kernel.projects.patch(b.run.projectId!, { archived: true });
    expect((await s.kernel.tool(a.run.rootNodeId, "list_sessions", {}) as { sessions: AgentSessionEntry[] }).sessions.map((entry) => entry.agentId)).toEqual([a.run.rootNodeId]);
    await expect(s.kernel.tool(a.run.rootNodeId, "send_message", { to: b.run.rootNodeId, message: "hi" })).rejects.toThrow(/archived/);
  });

  it("delivers a message to another project's session, wakes it, and carries the reply back over MCP", async () => {
    let received = "", reply = "";
    const s = await setup({
      alpha: async (c) => { if (c.turn === 1) c.text("Done"); else { reply = c.prompt; c.text("Thanks"); } },
      beta: async (c) => {
        if (c.turn === 1) { c.text("Ready"); return; }
        received = c.prompt;
        const from = /from="([^"]+)"/.exec(c.prompt)![1]!;
        await c.call("send_message", { to: from, message: "pong" });
        c.text("Replied");
      },
    });
    const a = await run(s, "alpha", "atlas"), b = await run(s, "beta", "borealis");
    const sent = await s.kernel.tool(a.run.rootNodeId, "send_message", { to: b.run.rootNodeId, message: "ping: is the API ready?" }) as { sent: boolean; delivery: string; to: { agentId: string; project?: string } };
    expect(sent).toMatchObject({ sent: true, delivery: expect.stringContaining("started a turn"), to: { agentId: b.run.rootNodeId, project: "borealis" } });
    await until(settled(s, a.run.rootNodeId, 2));
    expect(received).toContain(`<baton-message from="${a.run.rootNodeId}" agent="alpha" role="lead"`);
    expect(received).toContain(`run="${a.run.id}"`); expect(received).toContain('project="atlas"'); expect(received).toContain("ping: is the API ready?");
    expect(reply).toContain(`<baton-message from="${b.run.rootNodeId}"`); expect(reply).toContain("pong");
    expect(turns(s, b.run.rootNodeId).map((t) => t.trigger)).toEqual(["user", "message"]);
    expect(turns(s, a.run.rootNodeId).map((t) => t.trigger)).toEqual(["user", "message"]);
    // Both transcripts keep the message: the receiver's prompt row carries the <baton-message> wrapper.
    expect(s.store.items(b.run.rootNodeId).some((row) => row.item.type === "user_message" && row.item.text.includes("<baton-message"))).toBe(true);
  });

  it("queues behind a running turn instead of interrupting it", async () => {
    let second = "";
    const s = await setup({ alpha: idle, beta: async (c) => { if (c.turn === 1) c.text("Done"); else if (c.turn === 2) await c.sleep(250); else second = c.prompt; } });
    const a = await run(s, "alpha", "atlas"), b = await run(s, "beta", "borealis");
    await s.kernel.message(b.run.rootNodeId, "long task");
    await until(() => turns(s, b.run.rootNodeId).length === 2);
    const sent = await s.kernel.tool(a.run.rootNodeId, "send_message", { to: b.run.rootNodeId, message: "when you are free" }) as { delivery: string };
    expect(sent.delivery).toContain("queued");
    expect(turns(s, b.run.rootNodeId)[1]!.status).toBe("running");
    await until(settled(s, b.run.rootNodeId, 3));
    expect(second).toContain("when you are free");
  });

  it("lets a delegate that already delivered answer a message without reopening its assignment", async () => {
    let reportError = "";
    const s = await setup({
      alpha: async (c) => { if (c.turn === 1) await c.call("delegate", { agent: "gamma", title: "Build", task: "build it" }); },
      gamma: async (c) => {
        if (c.turn === 1) { await c.call("report_result", { status: "success", summary: "built" }); return; }
        try { await c.call("report_result", { status: "success", summary: "hijacked" }); } catch (error) { reportError = String(error); }
        c.text("Answered the question");
      },
      beta: idle,
    });
    const a = await run(s, "alpha", "atlas"), b = await run(s, "beta", "borealis");
    await until(() => s.store.snapshot(a.run.id).delegations[0]?.status === "completed" && turns(s, a.run.rootNodeId).length === 2 && settled(s, a.run.rootNodeId, 2)());
    const d = s.store.snapshot(a.run.id).delegations[0]!, rootTurns = turns(s, a.run.rootNodeId).length;
    await s.kernel.tool(b.run.rootNodeId, "send_message", { to: d.toNodeId, message: "which port does it use?" });
    await until(settled(s, d.toNodeId, 2));
    await delay(80);
    expect(reportError).toMatch(/answers a message from another session/);
    expect(s.store.delegation(d.id)).toMatchObject({ status: "completed", result: { summary: "built" } });
    expect(s.store.node(d.toNodeId)).toMatchObject({ status: "completed", activity: "Answered a session message" });
    expect(turns(s, a.run.rootNodeId)).toHaveLength(rootTurns);   // the parent got no second <baton-results>
  });

  it("stops a back-and-forth after the limit until the human writes to either session", async () => {
    const s = await setup({ alpha: idle, beta: idle });
    const a = await run(s, "alpha", "atlas"), b = await run(s, "beta", "borealis");
    for (let index = 0; index < MESSAGE_CHAIN_LIMIT; index++) {
      await s.kernel.tool(index % 2 ? b.run.rootNodeId : a.run.rootNodeId, "send_message", { to: index % 2 ? a.run.rootNodeId : b.run.rootNodeId, message: `m${index}` });
      await until(settled(s, index % 2 ? a.run.rootNodeId : b.run.rootNodeId, Math.floor(index / 2) + 2));
    }
    await expect(s.kernel.tool(a.run.rootNodeId, "send_message", { to: b.run.rootNodeId, message: "again" })).rejects.toThrow(/Message limit reached/);
    await s.kernel.message(b.run.rootNodeId, "carry on");
    await until(settled(s, b.run.rootNodeId, MESSAGE_CHAIN_LIMIT / 2 + 2));
    await expect(s.kernel.tool(a.run.rootNodeId, "send_message", { to: b.run.rootNodeId, message: "again" })).resolves.toMatchObject({ sent: true });
  });

  it("rejects unknown and own Agent IDs, works in solo runs, and tells every agent its Agent ID", async () => {
    const s = await setup({ alpha: idle, beta: idle });
    const a = await run(s, "alpha", "atlas", { mode: "solo" }), b = await run(s, "beta", "borealis");
    await expect(s.kernel.tool(a.run.rootNodeId, "send_message", { to: a.run.rootNodeId, message: "me" })).rejects.toThrow(/your own session/);
    await expect(s.kernel.tool(a.run.rootNodeId, "send_message", { to: "no-such-agent", message: "hi" })).rejects.toThrow(/No agent session has Agent ID/);
    await expect(s.kernel.tool(a.run.rootNodeId, "delegate", { agent: "beta", title: "x", task: "x" })).rejects.toThrow(/Solo runs cannot delegate/);
    await expect(s.kernel.tool(a.run.rootNodeId, "send_message", { to: b.run.rootNodeId, message: "from solo" })).resolves.toMatchObject({ sent: true });
    const registry = s.kernel.registry as FakeDriverRegistry;
    expect(registry.get("alpha")!.sessions[0]!.spec.systemPrompt).toContain(`Your Agent ID is ${a.run.rootNodeId}`);
    expect(registry.get("beta")!.sessions[0]!.spec.systemPrompt).toContain(`Your Agent ID is ${b.run.rootNodeId}`);
    expect(registry.get("beta")!.sessions[0]!.spec.systemPrompt).toContain("not from the human");
  });
});
