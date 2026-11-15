import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applyEvent, type BackgroundProcess, type ListBackgroundResponse, type ToolSpanRecord } from "@baton/protocol";
import { startServer, type BatonServer } from "./api/server.js";
import { FakeDriverRegistry, type FakeScript } from "./driver/fake.js";
import { BackgroundRegistry } from "./background/index.js";
import { processId, processSystem, type ProcessInfo, type ProcessSystem } from "./background/system.js";
import { exportRun } from "./telemetry/index.js";
import { Notifications, type DesktopNotification } from "./notifications/index.js";

const servers: BatonServer[] = [], homes: string[] = [], children = new Set<number>();
afterEach(async () => {
  for (const pid of children) { try { process.kill(pid, "SIGKILL"); } catch {} } children.clear();
  for (const server of servers.splice(0)) await server.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function setup(script: FakeScript = (c) => c.text("Done"), system?: ProcessSystem, home?: string) {
  home ??= await mkdtemp(join(tmpdir(), "baton-background-")); if (!homes.includes(home)) homes.push(home);
  const registry = new FakeDriverRegistry({ root: script });
  const server = await startServer({ home, port: 0, registry, notifier: () => {}, background: { system, idleMs: 60000, activeMs: 60000, afterShellMs: 60000 } }); servers.push(server);
  return server;
}
async function create(server: BatonServer) { return server.kernel.createRun({ projectId: (await server.kernel.projects.create({ path: server.home })).id, agent: "root", prompt: "background task" }); }
async function until(test: () => boolean | Promise<boolean>): Promise<void> { const end = Date.now() + 5000; while (!await test()) { if (Date.now() > end) throw new Error("Timed out"); await delay(10); } }
async function api(server: BatonServer, path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<Response> {
  return fetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const ts = "2026-11-15T12:00:00.000Z";
function fixtureSystem() {
  let rows: ProcessInfo[] = [], listeners = new Map<number, number[]>(), cwd = new Map<number, string>();
  const signals: Array<[number, NodeJS.Signals]> = [];
  const system: ProcessSystem = {
    processes: async () => rows, ports: async () => listeners, cwds: async () => cwd, realpath,
    signal(pid, kind) { signals.push([pid, kind]); if (kind === "SIGKILL") rows = rows.filter((p) => pid < 0 ? p.pgid !== -pid : p.pid !== pid); },
  };
  return { system, signals, set(value: ProcessInfo[], ports = new Map<number, number[]>(), paths = new Map<number, string>()) { rows = value; listeners = ports; cwd = paths; } };
}
const proc = (pid: number, ppid: number, pgid = pid, command = "node server.js"): ProcessInfo => ({ pid, ppid, pgid, command, startedAt: ts });
async function fakeRegistration(server: BatonServer, fixture: ReturnType<typeof fixtureSystem>) {
  const run = await create(server), root = run.run.rootNodeId;
  const span: ToolSpanRecord = { id: "span", runId: run.run.id, nodeId: root, callId: "shell", name: "shell", kind: "shell", summary: "node server.js", status: "completed", startedAt: ts, endedAt: ts };
  server.store.append(run.run.id, { type: "tool.span", span });
  fixture.set([proc(999991, 1)], new Map([[999991, [3000]]]), new Map([[999991, server.home]]));
  await server.background.scan(); return { run, root, record: server.background.list()[0]! };
}

describe("background persistence and control", () => {
  it("persists meaningful changes, avoids per-scan events, detects PID reuse and expires old snapshots", async () => {
    const fixture = fixtureSystem(), server = await setup(undefined, fixture.system);
    const { run, record } = await fakeRegistration(server, fixture);
    expect(record).toMatchObject({ pid: 999991, attribution: "inferred", ports: [3000] });
    const count = () => server.store.events(run.run.id).filter((e) => e.type === "background").length;
    const initial = count(); await server.background.scan(); expect(count()).toBe(initial);
    fixture.set([{ ...proc(999991, 1), startedAt: "2026-11-16T12:00:00.000Z" }]); await server.background.scan();
    expect(server.store.backgroundProcess(record.id).status).toBe("exited");
    const snapshot = server.store.snapshot(run.run.id);
    expect(server.store.events(run.run.id).reduce(applyEvent, { ...snapshot, backgroundProcesses: [], nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], questions: [], escalations: [], lastSeq: 0 })).toEqual(snapshot);
    server.store.append(run.run.id, { type: "background", process: { ...server.store.backgroundProcess(record.id), exitedAt: "2000-01-01T00:00:00.000Z" } });
    expect(server.store.snapshot(run.run.id).backgroundProcesses).toBeUndefined(); expect(count()).toBeGreaterThan(initial);
  });
  it("lists with run titles, dismisses, exports and restarts tracking", async () => {
    const fixture = fixtureSystem(), server = await setup(undefined, fixture.system);
    const { run, record } = await fakeRegistration(server, fixture);
    const response = await api(server, "/api/background"); const list = await response.json() as ListBackgroundResponse;
    expect(list[0]).toMatchObject({ id: record.id, runTitle: "background task" });
    expect(server.store.list()[0]?.backgroundCount).toBe(1);
    expect(exportRun(server.store, run.run.id, "md")).toContain("## Background processes");
    expect(JSON.parse(exportRun(server.store, run.run.id, "json"))).toMatchObject({ snapshot: { backgroundProcesses: [{ id: record.id }] } });
    await api(server, `/api/background/${encodeURIComponent(record.id)}/dismiss`, { dismissed: true });
    expect(server.store.list()[0]?.backgroundCount).toBe(0); expect(await (await api(server, "/api/background")).json()).toEqual([]);
    expect(await (await api(server, "/api/background?status=all")).json()).toHaveLength(1);
    await server.close(); servers.splice(servers.indexOf(server), 1);
    const restored = await setup(undefined, fixture.system, server.home); await restored.background.scan();
    expect(restored.store.backgroundProcess(record.id)).toMatchObject({ status: "running", dismissed: true });
    fixture.set([]); await restored.background.scan(); expect(restored.store.backgroundProcess(record.id).status).toBe("exited");
  });
  it("uses a safe process group, escalates to SIGKILL and rejects unregistered or reused PIDs", async () => {
    const fixture = fixtureSystem(), server = await setup(undefined, fixture.system);
    const { record } = await fakeRegistration(server, fixture);
    const response = await api(server, `/api/background/${encodeURIComponent(record.id)}/stop`, { graceMs: 10 });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: "exited", stoppedBy: "human" });
    expect(fixture.signals).toEqual([[-999991, "SIGTERM"], [-999991, "SIGKILL"]]);
    expect((await api(server, "/api/background/123:0/stop", {})).status).toBe(404);
    fixture.signals.splice(0); server.store.append(record.runId, { type: "background", process: { ...record, status: "running" } });
    fixture.set([{ ...proc(record.pid, 1), startedAt: "2026-11-16T12:00:00.000Z" }]);
    await server.background.stop(record.id, 0); expect(fixture.signals).toEqual([]);
  });
  it("stops unsafe-group families deepest first without touching an unrelated group member", async () => {
    const fixture = fixtureSystem(), server = await setup(undefined, fixture.system);
    const { record } = await fakeRegistration(server, fixture);
    fixture.set([proc(record.pid, 1, 500), proc(999992, record.pid, 500), proc(999993, 1, 500, "unrelated")]);
    await server.background.stop(record.id, 0);
    expect(fixture.signals).toEqual([[999992, "SIGKILL"], [999991, "SIGKILL"]]);
  });
  it("kills a family's escaped process group and sends completion notifications with the remaining count", async () => {
    const fixture = fixtureSystem(), server = await setup(undefined, fixture.system);
    const { run, record } = await fakeRegistration(server, fixture);
    const notifications: DesktopNotification[] = [];
    const notifier = new Notifications(server.store, (notification) => { notifications.push(notification); }, 5);
    await until(() => server.store.node(run.run.rootNodeId).status === "idle");
    server.store.append(run.run.id, { type: "run.updated", patch: { status: "active" } });
    server.store.append(run.run.id, { type: "run.updated", patch: { status: "idle" } });
    await until(() => notifications.length > 0); notifier.close();
    expect(notifications[0]?.body).toContain("仍有 1 个后台进程在运行");
    fixture.set([proc(record.pid, 1), proc(999992, record.pid, 999992)]);
    await server.background.stop(record.id, 0);
    expect(fixture.signals).toContainEqual([-999991, "SIGKILL"]);
    expect(fixture.signals).toContainEqual([999992, "SIGKILL"]);
  });
  it("keeps background services by default on run cancel and counts stopping entries", async () => {
    const fixture = fixtureSystem(), server = await setup(undefined, fixture.system);
    const { run, record } = await fakeRegistration(server, fixture);
    server.store.append(run.run.id, { type: "background", process: { ...record, status: "stopping" } });
    expect(server.store.list()[0]?.backgroundCount).toBe(1);
    const response = await api(server, `/api/runs/${run.run.id}/cancel`, undefined, "POST");
    expect(response.status).toBe(200); expect(fixture.signals).toEqual([]);
    expect(server.store.backgroundProcess(record.id).status).toBe("stopping");
  });
  it("keeps listening registrations when lsof is unavailable and refreshes children after restart", async () => {
    const fixture = fixtureSystem(), server = await setup(undefined, fixture.system);
    const { record } = await fakeRegistration(server, fixture);
    fixture.system.ports = async () => undefined;
    await server.background.scan(); expect(server.background.list()[0]?.ports).toEqual([3000]);
    await server.close(); servers.splice(servers.indexOf(server), 1);
    fixture.set([proc(record.pid, 1), proc(999992, record.pid, record.pgid)]);
    const restored = await setup(undefined, fixture.system, server.home); await restored.background.scan();
    expect(restored.store.backgroundProcess(record.id).children).toMatchObject([{ pid: 999992 }]);
  });
  it("has single-flight scans and no process work when no runs exist or on Windows", async () => {
    let calls = 0, release: () => void = () => {};
    const fixture = fixtureSystem(), server = await setup(undefined, fixture.system);
    const system = { ...fixture.system, processes: async () => { calls++; await new Promise<void>((resolve) => { release = resolve; }); return []; } };
    const registry = new BackgroundRegistry(server.store, () => [], { system, idleMs: 60000 });
    await registry.scan(); expect(calls).toBe(0); await create(server);
    const first = registry.scan(), second = registry.scan(); expect(first).toBe(second); expect(calls).toBe(1);
    release(); await first; await registry.close();
    const windows = new BackgroundRegistry(server.store, () => [], { system, platform: "win32" }); await windows.scan(); expect(calls).toBe(1); expect(windows.list()).toEqual([]); await windows.close();
  });
  it("shows only the python service across a Claude tool shell exit, with no exited wrapper entry", async () => {
    const fixture = fixtureSystem(), server = await setup(undefined, fixture.system);
    const run = await create(server), nodeId = run.run.rootNodeId;
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const span: ToolSpanRecord = { id: "claude-bash", runId: run.run.id, nodeId, callId: "bash", name: "Bash", kind: "shell", summary: "nohup python3 -m http.server 8765", status: "running", startedAt };
    server.store.append(run.run.id, { type: "tool.span", span });
    server.kernel.processSources = () => [{ runId: run.run.id, nodeId, cwd: server.home, pids: [100], spans: [span] }];
    const agent = proc(100, 1, 100, "claude"), wrapper = { ...proc(62507, 100, 62507, "/bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-123 && eval 'nohup python3 -m http.server 8765 &'"), startedAt }, python = { ...proc(62508, 62507, 62507, "python3 -m http.server 8765"), startedAt };
    const ports = new Map([[python.pid, [8765]]]), cwd = new Map([[wrapper.pid, server.home], [python.pid, server.home]]);
    fixture.set([agent, wrapper, python], ports, cwd); await server.background.scan();
    expect(server.store.snapshot(run.run.id).backgroundProcesses).toMatchObject([{ pid: python.pid, status: "running", attribution: "tree", ports: [8765] }]);
    span.status = "completed"; span.endedAt = new Date().toISOString();
    fixture.set([agent, { ...python, ppid: 1 }], ports, cwd); await server.background.scan();
    const snapshot = server.store.snapshot(run.run.id);
    expect(snapshot.backgroundProcesses).toHaveLength(1);
    expect(snapshot.backgroundProcesses).toMatchObject([{ pid: python.pid, status: "running", attribution: "group", pgid: wrapper.pid, ports: [8765] }]);
    expect(server.background.list("all")).toHaveLength(1); expect(server.background.list("exited")).toEqual([]);
    expect(server.store.events(run.run.id).filter((e) => e.type === "background").every((e) => e.type === "background" && e.process.pid === python.pid)).toBe(true);
  });
  it.each(["running", "exited"] as const)("filters an old %s wrapper registration once its surviving child is registered, including after restart", async (status) => {
    const fixture = fixtureSystem(), server = await setup(undefined, fixture.system);
    const run = await create(server), nodeId = run.run.rootNodeId;
    const span: ToolSpanRecord = { id: "old-shell", runId: run.run.id, nodeId, callId: "shell", name: "Bash", kind: "shell", summary: "nohup python3 -m http.server 8765", status: "completed", startedAt: ts, endedAt: ts };
    server.store.append(run.run.id, { type: "tool.span", span });
    const wrapper = proc(62507, 100, 62507, "/bin/zsh -c source snapshot && eval 'nohup python3 -m http.server 8765 &'"), python = proc(62508, 1, 62507, "python3 -m http.server 8765");
    const parent: BackgroundProcess = { ...wrapper, id: processId(wrapper), runId: run.run.id, nodeId, ports: [8765], children: [{ pid: python.pid, command: python.command, ports: [8765] }], status, ...(status === "exited" ? { exitedAt: new Date().toISOString() } : {}), attribution: "tree", toolSpanId: span.id, lastSeenAt: ts };
    server.store.append(run.run.id, { type: "background", process: parent });
    fixture.set([python], new Map([[python.pid, [8765]]]), new Map([[python.pid, server.home]]));
    await server.close(); servers.splice(servers.indexOf(server), 1);
    const restored = await setup(undefined, fixture.system, server.home);
    await restored.background.scan();
    const snapshot = restored.store.snapshot(run.run.id);
    expect(snapshot.backgroundProcesses).toHaveLength(1);
    expect(snapshot.backgroundProcesses?.[0]).toMatchObject({ pid: python.pid, status: "running", attribution: status === "running" ? "group" : "inferred" });
    expect(restored.background.list("all")).toHaveLength(1); expect(restored.background.list("exited")).toEqual([]);
    expect(await (await api(restored, "/api/background?status=all")).json()).toHaveLength(1);
    expect(restored.store.events(run.run.id).some((e) => e.type === "background" && e.process.id === parent.id)).toBe(true);
    fixture.set([]); await restored.background.scan();
    expect(restored.background.list("all")).toHaveLength(1);
    expect(restored.background.list("exited")).toMatchObject([{ pid: python.pid, status: "exited" }]);
  });
});

describe.skipIf(process.platform === "win32")("real process registration and stopping", () => {
  it("attributes a detached listening server through FakeDriver and stops it", async () => {
    let pid = 0;
    const server = await setup(async (c) => { pid = await c.spawn(process.execPath, ["-e", "require('node:net').createServer().listen(0,'127.0.0.1')"], { detached: true }); children.add(pid); await c.sleep(10000); });
    const run = await create(server); await until(() => !!pid);
    await until(async () => { await server.background.scan(); return server.background.list().some((p) => p.pid === pid && p.ports.length > 0); });
    const record = server.background.list().find((p) => p.pid === pid)!;
    expect(record).toMatchObject({ nodeId: run.run.rootNodeId, attribution: "tree", status: "running" });
    expect(record.cwd).toBe(await processSystem.realpath(server.home));
    const result = await api(server, `/api/background/${encodeURIComponent(record.id)}/stop`, { graceMs: 100 }); expect(result.status).toBe(200);
    expect((await processSystem.processes()).some((p) => p.pid === pid)).toBe(false); children.delete(pid);
  }, 15000);
  it("infers a nohup-style orphan in a shell window and cancel(stopBackground) kills it", async () => {
    const server = await setup(); const run = await create(server), root = run.run.rootNodeId;
    const { spawn } = await import("node:child_process");
    const before = new Date().toISOString();
    const shell = spawn("sh", ["-c", "sleep 600 >/dev/null 2>&1 & echo $!"], { cwd: server.home, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = ""; shell.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise<void>((resolve, reject) => { shell.once("error", reject); shell.once("close", () => resolve()); });
    const pid = Number(output.trim()); expect(pid).toBeGreaterThan(1); children.add(pid);
    server.store.append(run.run.id, { type: "tool.span", span: { id: "orphan-shell", runId: run.run.id, nodeId: root, callId: "orphan-shell", name: "shell", kind: "shell", summary: "sleep 600", status: "completed", startedAt: before, endedAt: new Date().toISOString() } });
    await until(async () => { await server.background.scan(); return server.background.list().some((p) => p.pid === pid); });
    expect(server.background.list().find((p) => p.pid === pid)?.attribution).toBe("inferred");
    const response = await api(server, `/api/runs/${run.run.id}/cancel`, { stopBackground: true }); expect(response.status).toBe(200);
    expect((await processSystem.processes()).some((p) => p.pid === pid)).toBe(false); children.delete(pid);
  }, 15000);
});
