import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { applyEvent, type DelegationRecord, type RunSnapshot } from "@baton/protocol";
import { startServer, type BatonServer } from "./api/server.js";
import { FakeDriver, FakeDriverRegistry, type FakeScript, type FakeDriverOptions } from "./driver/fake.js";
import { exportRun } from "./telemetry/index.js";
const servers: BatonServer[] = [], homes: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function setup(scripts: Record<string, FakeScript | FakeDriverOptions>, options: { deliveryDebounceMs?: number; maxActiveNodes?: number; home?: string } = {}): Promise<BatonServer> {
  const home = options.home ?? await mkdtemp(join(tmpdir(), "baton-test-")); if (!homes.includes(home)) homes.push(home);
  const server = await startServer({ home, port: 0, registry: new FakeDriverRegistry(scripts), deliveryDebounceMs: 20, ...options }); servers.push(server); return server;
}
async function until(test: () => boolean, timeout = 4000): Promise<void> { const end = Date.now() + timeout; while (!test()) { if (Date.now() > end) throw new Error("Timed out waiting for condition"); await delay(10); } }
async function create(server: BatonServer, agent = "root", policy = {}): Promise<RunSnapshot> { return server.kernel.createRun({ agent, cwd: tmpdir(), prompt: "start", policy: { teamApproval: false, ...policy } }); }
function children(server: BatonServer, id: string): DelegationRecord[] { return server.store.snapshot(id).delegations; }
const idle: FakeScript = (c) => { c.text("Done."); };

describe("kernel over real HTTP MCP", () => {
  it("allows a depth-3 chain, rejects depth 4, and projections equal event replay", async () => {
    const server = await setup({ root: async (c) => { if (c.turn === 1) await c.call("delegate", { agent: "chain", title: "1", task: "chain" }); }, chain: async (c) => {
      const depth = Number(c.spec.title);
      if (c.turn > 1) { c.text(`depth ${depth} incorporated result`); return; }
      if (depth < 3) await c.call("delegate", { agent: "chain", title: String(depth + 1), task: "chain" });
      else await expect(c.call("delegate", { agent: "chain", title: "4", task: "too deep" })).rejects.toThrow(/depth/);
      c.text(`depth ${depth}`); await c.call("report_result", { status: "success", summary: `depth ${depth}` });
    } });
    const run = await create(server);
    await until(() => children(server, run.run.id).length === 3 && children(server, run.run.id).every((d) => d.status === "completed"));
    await delay(100);
    const snapshot = server.store.snapshot(run.run.id), events = server.store.events(run.run.id);
    const replay = events.reduce(applyEvent, { run: snapshot.run, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], lastSeq: 0 });
    expect(replay).toEqual(snapshot); expect(snapshot.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 3]);
    const rows = snapshot.nodes.flatMap((n) => server.store.items(n.id)); expect(rows.every((r) => r.seq > 0)).toBe(true);
    expect(rows.some((r) => r.item.type === "tool_call" && r.item.detail.type === "baton" && !!r.item.detail.delegationId)).toBe(true);
  });
  it("runs parallel children, enforces fan-out and global limits and budget", async () => {
    let rejection = "";
    const server = await setup({ root: async (c) => { if (c.turn !== 1) return;
      await Promise.all([1, 2].map((n) => c.call("delegate", { agent: "slow", title: String(n), task: "wait" })));
      try { await c.call("delegate", { agent: "slow", title: "3", task: "wait" }); } catch (e) { rejection = String(e); }
      await c.sleep(500);
    }, slow: async (c) => { await c.sleep(1000); c.text("slow"); } });
    const run = await create(server, "root", { maxActiveChildren: 2 });
    await until(() => !!rejection); expect(rejection).toContain("fan-out");
    expect(children(server, run.run.id)).toHaveLength(2);
    expect(server.store.snapshot(run.run.id).nodes.filter((n) => n.status === "running")).toHaveLength(3);
    server.kernel.patchRun(run.run.id, { policy: { budget: { maxTokens: 0 } } });
    await expect(server.kernel.delegate(children(server, run.run.id)[0]!.toNodeId, { agent: "slow", title: "budget", task: "x" })).rejects.toThrow(/budget/);
    const other = await setup({ root: async (c) => { await c.sleep(5000); } }, { maxActiveNodes: 1 });
    await create(other); await expect(create(other)).rejects.toThrow(/Global active/);
  });
  it("captures explicit reports and final-message fallback; send reopens round 2", async () => {
    const server = await setup({ root: idle, reported: async (c) => { c.text("final text"); await c.call("report_result", { status: "partial", summary: `report ${c.turn}`, result: { turn: c.turn } }); }, fallback: (c) => { c.text("Hello "); c.text("world"); } });
    const run = await create(server); await until(() => server.store.node(run.run.rootNodeId).status === "idle");
    const a = await server.kernel.delegate(run.run.rootNodeId, { agent: "reported", title: "a", task: "x" });
    const b = await server.kernel.delegate(run.run.rootNodeId, { agent: "fallback", title: "b", task: "x" });
    await until(() => children(server, run.run.id).every((d) => d.status === "completed"));
    expect(server.store.delegation(a.delegationId).result).toMatchObject({ reported: true, summary: "report 1", finalText: "final text" });
    expect(server.store.delegation(b.delegationId).result).toMatchObject({ reported: false, summary: "Hello world" });
    await server.kernel.tool(run.run.rootNodeId, "send", { delegationId: a.delegationId, message: "again" });
    await until(() => server.store.delegation(a.delegationId).result?.summary === "report 2");
    expect(server.store.delegation(a.delegationId).round).toBe(2);
    expect(server.store.snapshot(run.run.id).run.usage.inputTokens).toBeGreaterThan(0);
  });
  it("corrects outputSchema then fails after two corrections", async () => {
    const server = await setup({ root: idle, correct: async (c) => { await c.call("report_result", { status: "success", summary: "schema", result: c.turn === 1 ? {} : { value: 1 } }); }, wrong: async (c) => { await c.call("report_result", { status: "success", summary: "wrong", result: { value: "bad" } }); } });
    const run = await create(server); const schema = { type: "object", required: ["value"], properties: { value: { type: "integer" } }, additionalProperties: false };
    const a = await server.kernel.delegate(run.run.rootNodeId, { agent: "correct", title: "correct", task: "x", outputSchema: schema });
    const b = await server.kernel.delegate(run.run.rootNodeId, { agent: "wrong", title: "wrong", task: "x", outputSchema: schema });
    await until(() => server.store.delegation(a.delegationId).status === "completed" && server.store.delegation(b.delegationId).status === "failed");
    expect(server.store.node(a.nodeId).turns).toBe(2); expect(server.store.node(b.nodeId).turns).toBe(3);
    expect(server.store.delegation(b.delegationId).result?.error).toContain("after 2 corrections");
  });
  it("wait any/all/timeout consumes results without duplicate delivery; get_result also consumes", async () => {
    const server = await setup({ root: idle, fast: async (c) => { await c.sleep(80); c.text("fast"); }, slow: async (c) => { await c.sleep(250); c.text("slow"); }, never: async (c) => { await c.sleep(10000); } }, { deliveryDebounceMs: 3000 });
    const run = await create(server), root = run.run.rootNodeId;
    const a = await server.kernel.delegate(root, { agent: "fast", title: "a", task: "x" }), b = await server.kernel.delegate(root, { agent: "slow", title: "b", task: "x" });
    const any = await server.kernel.tool(root, "wait", { delegationIds: [a.delegationId, b.delegationId], mode: "any", timeoutSec: 1 }) as { results: DelegationRecord[] };
    expect(any.results).toHaveLength(1);
    const all = await server.kernel.tool(root, "wait", { delegationIds: [a.delegationId, b.delegationId], mode: "all", timeoutSec: 1 }) as { timedOut: boolean; results: DelegationRecord[] };
    expect(all.timedOut).toBe(false); expect(all.results).toHaveLength(2);
    const d = await server.kernel.delegate(root, { agent: "never", title: "n", task: "x" });
    expect(await server.kernel.tool(root, "wait", { delegationIds: [d.delegationId], timeoutSec: 1 })).toMatchObject({ timedOut: true, results: [] });
    expect(server.store.delegation(a.delegationId).deliveredVia).toBe("wait");
    expect(server.store.snapshot(run.run.id).turns.filter((t) => t.trigger === "result")).toHaveLength(0);
    const e = await server.kernel.delegate(root, { agent: "fast", title: "get", task: "x" });
    await until(() => server.store.delegation(e.delegationId).status === "completed");
    await server.kernel.tool(root, "get_result", { delegationId: e.delegationId }); expect(server.store.delegation(e.delegationId).deliveredVia).toBe("get_result");
  });
  it.each([true, false])("delivers during active parent turn with steer=%s", async (steer) => {
    const driver = new FakeDriver("root", { steer, script: async (c) => { if (c.turn === 1) { await c.call("delegate", { agent: "fast", title: "fast", task: "x" }); await c.sleep(300); } } });
    const home = await mkdtemp(join(tmpdir(), "baton-test-")); homes.push(home);
    const registry = new FakeDriverRegistry([driver, new FakeDriver("fast", { script: idle })]);
    const server = await startServer({ home, port: 0, registry, deliveryDebounceMs: 20 }); servers.push(server);
    const run = await create(server); await until(() => !!children(server, run.run.id)[0]?.deliveredAt);
    const d = children(server, run.run.id)[0]!;
    expect(d.deliveredVia).toBe(steer ? "steer" : "turn");
    expect(driver.sessions[0]!.steered.length).toBe(steer ? 1 : 0);
    if (!steer) expect(server.store.snapshot(run.run.id).turns.some((t) => t.trigger === "result")).toBe(true);
  });
  it("shows permission pending, accepts human decision, autoapproves by policy", async () => {
    const script: FakeScript = async (c) => { await c.permission({ id: "ask", name: "test", kind: "tool" }); c.text("approved"); };
    const server = await setup({ root: script }); const run = await create(server);
    await until(() => server.store.snapshot(run.run.id).permissions.length === 1);
    expect(server.store.node(run.run.rootNodeId).status).toBe("waiting_permission");
    const p = server.store.snapshot(run.run.id).permissions[0]!; await server.kernel.respondPermission(p.id, { behavior: "allow" });
    await until(() => server.store.node(run.run.rootNodeId).status === "idle");
    expect(server.store.snapshot(run.run.id).permissions[0]?.resolvedBy).toBe("human");
    const auto = await create(server, "root", { autoApprove: true }); await until(() => server.store.node(auto.run.rootNodeId).status === "idle");
    expect(server.store.snapshot(auto.run.id).permissions[0]).toMatchObject({ resolvedBy: "policy", status: "resolved" });
  });
  it("auto-allows permission requests for baton's own tools without autoApprove", async () => {
    const script: FakeScript = async (c) => {
      await c.permission({ id: "claude-style", name: "mcp__baton__delegate", kind: "tool" });
      await c.permission({ id: "codex-style", name: "mcp_elicitation", kind: "tool", input: { serverName: "baton" } });
      c.text("both allowed");
    };
    const server = await setup({ root: script }); const run = await create(server);
    await until(() => server.store.node(run.run.rootNodeId).status === "idle");
    const permissions = server.store.snapshot(run.run.id).permissions;
    expect(permissions.map((p) => [p.requestId, p.status, p.resolvedBy])).toEqual([["claude-style", "resolved", "policy"], ["codex-style", "resolved", "policy"]]);
  });
  it("ignores provider echoes of user messages (the kernel records prompts itself)", async () => {
    const script: FakeScript = (c) => { c.item({ type: "user_message", text: "start" }); c.text("ok"); };
    const server = await setup({ root: script }); const run = await create(server);
    await until(() => server.store.node(run.run.rootNodeId).status === "idle");
    const items = server.store.items(run.run.rootNodeId, 0).map((row) => row.item.type);
    expect(items.filter((type) => type === "user_message")).toHaveLength(1);
  });
  it("validates ownership, rejects root reports, cascades cancellation and closes all sessions", async () => {
    const server = await setup({ root: async (c) => { await c.call("delegate", { agent: "child", title: "child", task: "x" }); await c.sleep(10000); }, child: async (c) => { await c.call("delegate", { agent: "leaf", title: "leaf", task: "x" }); await c.sleep(10000); }, leaf: async (c) => { await c.sleep(10000); } });
    const run = await create(server); await until(() => children(server, run.run.id).length === 2);
    const [first, second] = children(server, run.run.id);
    for (const tool of ["send", "cancel", "get_result", "wait", "reassign"] as const) {
      const args = tool === "wait" ? { delegationIds: [second!.id], timeoutSec: 1 } : { delegationId: second!.id, message: "x", role: "leaf", reason: "x" };
      await expect(server.kernel.tool(run.run.rootNodeId, tool, args)).rejects.toThrow(/direct child/);
    }
    await expect(server.kernel.tool(run.run.rootNodeId, "report_result", { status: "success", summary: "x" })).rejects.toThrow(/Root/);
    await server.kernel.cancelRun(run.run.id);
    expect(server.store.snapshot(run.run.id).nodes.every((n) => n.status === "canceled")).toBe(true);
    expect(server.store.delegation(first!.id).status).toBe("canceled");
    const registry = server.kernel.registry as FakeDriverRegistry; expect([...registry.drivers.values()].flatMap((d) => d.sessions).every((s) => s.closed)).toBe(true);
  });
  it("recovers interrupted nodes and resumes using persisted handle", async () => {
    const script: FakeScript = async (c) => { await c.sleep(10000); };
    const server = await setup({ root: script }); const run = await create(server); await delay(30);
    const persistence = server.store.node(run.run.rootNodeId).persistence;
    await server.close(); servers.splice(servers.indexOf(server), 1);
    const restored = await setup({ root: idle }, { home: server.home });
    expect(restored.store.node(run.run.rootNodeId).status).toBe("interrupted");
    expect(restored.store.snapshot(run.run.id).turns[0]?.status).toBe("interrupted");
    await restored.kernel.message(run.run.rootNodeId, "resume"); await until(() => restored.store.node(run.run.rootNodeId).status === "idle");
    const session = (restored.kernel.registry as FakeDriverRegistry).get("root")!.sessions[0]!;
    expect(session.persistence()).toMatchObject({ sessionId: (persistence as { sessionId: string }).sessionId });
  });
});

describe("lifecycle and demo", () => {
  it("coalesces growing and chunked text into one node-local item", async () => {
    const server = await setup({ root: (c) => { c.text("H"); c.text("Hello"); c.text(" world"); } });
    const run = await create(server); await until(() => server.store.node(run.run.rootNodeId).status === "idle");
    const items = server.store.items(run.run.rootNodeId);
    expect(items.map((item) => item.seq)).toEqual([1, 2]);
    expect(items[1]?.item).toEqual({ type: "assistant_message", text: "Hello world" });
    expect(server.store.events(run.run.id).filter((event) => event.type === "item" && event.item.type === "assistant_message")).toHaveLength(1);
  });
  it("invalidates node tokens at idle close and resumes a closed root", async () => {
    const home = await mkdtemp(join(tmpdir(), "baton-test-")); homes.push(home);
    const registry = new FakeDriverRegistry({ root: idle });
    const server = await startServer({ home, port: 0, registry, idleTimeoutMs: 25 }); servers.push(server);
    const run = await create(server); const first = registry.get("root")!.sessions[0]!;
    const config = first.spec.mcpServers.baton; if (!config || config.type !== "http") throw new Error("Missing injection");
    const token = new URL(config.url).pathname.split("/").at(-1)!;
    await until(() => server.store.node(run.run.rootNodeId).status === "completed");
    expect(first.closed).toBe(true); expect(server.kernel.identify(token)).toBeUndefined();
    await server.kernel.message(run.run.rootNodeId, "continue");
    await until(() => server.store.node(run.run.rootNodeId).status === "idle");
    expect(registry.get("root")!.sessions).toHaveLength(2);
    expect(server.store.snapshot(run.run.id).run.endedAt).toBeUndefined();
    const snapshot = server.store.snapshot(run.run.id);
    expect(server.store.events(run.run.id).reduce(applyEvent, { ...snapshot, lastSeq: 0, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [] })).toEqual(snapshot);
  });
  it("runs the shipped demo with parallel agents, grandchild, permission and failed child", async () => {
    const home = await mkdtemp(join(tmpdir(), "baton-test-")); homes.push(home);
    const server = await startServer({ home, port: 0, fake: true, deliveryDebounceMs: 30 }); servers.push(server);
    const run = await server.kernel.createRun({ agent: "fake-claude", cwd: tmpdir(), prompt: "legacy demo", policy: { autoApprove: true, teamApproval: false } });
    await until(() => {
      const snapshot = server.store.snapshot(run.run.id);
      return snapshot.nodes.length === 5 && snapshot.delegations.every((d) => ["completed", "failed"].includes(d.status)) && snapshot.run.status === "idle";
    }, 9000);
    const snapshot = server.store.snapshot(run.run.id);
    expect(snapshot.nodes.map((n) => n.depth).sort()).toEqual([0, 1, 1, 1, 2]);
    expect(snapshot.delegations.filter((d) => d.status === "failed")).toHaveLength(1);
    expect(snapshot.permissions[0]?.resolvedBy).toBe("policy");
    expect(snapshot.delegations.every((d) => !!d.deliveredAt)).toBe(true);
    expect(snapshot.run.usage.inputTokens).toBe(snapshot.nodes.reduce((sum, n) => sum + n.usage.inputTokens, 0));
    const review = snapshot.delegations.find((d) => d.brief.title === "Review the implementation")!;
    const own = snapshot.nodes.find((n) => n.id === review.toNodeId)!;
    const leaf = snapshot.delegations.find((d) => d.fromNodeId === own.id)!;
    expect(review.subtreeUsage.inputTokens).toBe(own.usage.inputTokens + server.store.node(leaf.toNodeId).usage.inputTokens);
  }, 12000);
});

describe("HTTP and exports", () => {
  it("exercises CLI agents/run/runs/export against the running daemon", async () => {
    const server = await setup({ root: idle });
    const cli = async (...args: string[]): Promise<string> => {
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "packages/server/src/cli/main.ts", ...args, "--home", server.home], { cwd: process.cwd(), env: { ...process.env, BATON_HOME: server.home } });
      return result.stdout;
    };
    expect(await cli("agents", "--refresh")).toContain("root");
    const result = await cli("run", "root", "CLI smoke", "--cwd", tmpdir());
    const id = result.trim().replace(/^Run /, "");
    expect(await cli("runs")).toContain(id);
    expect(await cli("export", id, "--format", "md")).toContain("CLI smoke");
    const response = await fetch(`${server.url}/api/nodes/${server.store.snapshot(id).run.rootNodeId}/messages`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "Human follow-up" }) });
    expect(response.status).toBe(202);
    await until(() => server.store.snapshot(id).turns.length === 2 && server.store.snapshot(id).turns.every((turn) => turn.status === "completed"));
    const canceled = await fetch(`${server.url}/api/runs/${id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: "{}" });
    expect(canceled.status).toBe(200); expect(server.store.snapshot(id).run.status).toBe("canceled");
  });

  it("rejects auth/Host/Origin/non-JSON, serves info and token permissions", async () => {
    const server = await setup({ root: idle });
    expect((await fetch(`${server.url}/api/info`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/info`, { headers: { authorization: `Bearer ${server.token}`, origin: "https://evil.test" } })).status).toBe(403);
    const hostStatus = await new Promise<number>((resolve, reject) => { const req = httpRequest(`${server.url}/api/info`, { headers: { Host: "evil.test", authorization: `Bearer ${server.token}` } }, (res) => { res.resume(); resolve(res.statusCode!); }); req.on("error", reject); req.end(); });
    expect(hostStatus).toBe(403);
    expect((await fetch(`${server.url}/api/runs`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    const info = await fetch(`${server.url}/api/info`, { headers: { authorization: `Bearer ${server.token}` } }); expect(await info.json()).toMatchObject({ name: "baton", port: server.port });
    expect((await stat(join(server.home, "token"))).mode & 0o777).toBe(0o600);
  });
  it("resumes SSE after seq and Last-Event-ID, and exports replayable JSON/MD/OTLP", async () => {
    const server = await setup({ root: idle }); const run = await create(server); await until(() => server.store.node(run.run.rootNodeId).status === "idle");
    const events = server.store.events(run.run.id), after = events.at(-3)!.seq;
    for (const useHeader of [false, true]) {
      const controller = new AbortController();
      const response = await fetch(`${server.url}/api/runs/${run.run.id}/events?token=${server.token}${useHeader ? "" : `&after=${after}`}`, { headers: { accept: "text/event-stream", ...(useHeader ? { "last-event-id": String(after) } : {}) }, signal: controller.signal });
      const reader = response.body!.getReader(); const first = await reader.read(); const text = new TextDecoder().decode(first.value); expect(text).toContain(`id: ${after + 1}\n`); expect(text).not.toContain(`id: ${after}\n`); controller.abort(); await reader.cancel().catch(() => {});
    }
    const json = JSON.parse(exportRun(server.store, run.run.id, "json")) as { snapshot: RunSnapshot; events: unknown[]; items: unknown[] }; expect(json.snapshot.lastSeq).toBe(events.at(-1)!.seq); expect(json.items.length).toBeGreaterThan(0);
    expect(exportRun(server.store, run.run.id, "md")).toContain("## Usage");
    const otlp = JSON.parse(exportRun(server.store, run.run.id, "otlp")) as { resourceSpans: unknown[] }; expect(otlp.resourceSpans).toHaveLength(1);
  });
});
