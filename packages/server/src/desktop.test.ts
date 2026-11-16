import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { NotificationEvent } from "@baton/protocol";
import { startServer, type BatonServer, type StartServerOptions } from "./api/server.js";
import { FakeDriverRegistry, type FakeScript } from "./driver/fake.js";
import { installShutdown } from "./cli/shutdown.js";
import { notificationMode } from "./notifications/index.js";

const servers: BatonServer[] = [], homes: string[] = [], children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) child.kill("SIGKILL"); children.clear();
  for (const server of servers.splice(0)) await server.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function home(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "baton-desktop-")); homes.push(path); return path; }
async function until(test: () => boolean | Promise<boolean>): Promise<void> { const end = Date.now() + 6000; while (!await test()) { if (Date.now() > end) throw new Error("Timed out"); await delay(10); } }
async function setup(script: FakeScript = (c) => c.text("Done"), options: Partial<StartServerOptions> = {}) {
  const s = await startServer({ home: await home(), port: 0, registry: new FakeDriverRegistry({ root: script }), notifier: () => {}, notificationCoalesceMs: 15, ...options }); servers.push(s);
  const create = async () => s.kernel.createRun({ projectId: (await s.kernel.projects.create({ path: s.home })).id, agent: "root", prompt: "Test", policy: { teamApproval: false } });
  return { s, create };
}
async function notificationStream(s: BatonServer) {
  const controller = new AbortController();
  const response = await fetch(`${s.url}/api/notifications/events?token=${s.token}`, { signal: controller.signal });
  expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader(); let buffered = "";
  return { async next(): Promise<NotificationEvent> {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) {
        const entry = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (entry.includes("event: notification")) return JSON.parse(entry.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as NotificationEvent;
      } else { const result = await reader.read(); if (result.done) throw new Error("Notification stream closed"); buffered += new TextDecoder().decode(result.value); }
    }
  }, async close() { controller.abort(); await reader.cancel().catch(() => {}); } };
}

describe("desktop notifications", () => {
  it("streams pending and completion notifications with routes while client mode suppresses OS delivery", async () => {
    const os: unknown[] = [];
    const { s, create } = await setup(async (c) => { if (c.turn === 1) await c.call("ask_human", { question: "Continue?", blocking: true }); c.text("Done"); }, { notifications: "client", platform: "darwin", osNotifier: (n) => { os.push(n); } });
    const stream = await notificationStream(s);
    try {
      const run = await create(), pending = await stream.next();
      expect(pending).toMatchObject({ kind: "pending", route: "/inbox", runId: run.run.id, id: expect.any(String), ts: expect.any(String) });
      const q = s.store.snapshot(run.run.id).questions[0]!; await s.kernel.human.answer(q.id, { answer: "Yes" });
      const complete = await stream.next(); expect(complete).toMatchObject({ kind: "run_completed", route: `/runs/${run.run.id}` }); expect(os).toEqual([]);
      expect((await fetch(`${s.url}/api/notifications/events`)).status).toBe(401);
    } finally { await stream.close(); }
  });
  it("respects configured modes, legacy desktop flag and platform defaults", () => {
    expect(notificationMode({}, undefined, "darwin")).toBe("os"); expect(notificationMode({}, undefined, "win32")).toBe("client");
    expect(notificationMode({ notifications: { mode: "off" } }, undefined, "darwin")).toBe("off");
    expect(notificationMode({ notifications: { desktop: false } }, undefined, "darwin")).toBe("off");
    expect(notificationMode({ notifications: { mode: "os" } }, "client", "darwin")).toBe("client");
  });
  it("disables background registry on win32 and advertises capabilities", async () => {
    const { s } = await setup(undefined, { platform: "win32" });
    const response = await fetch(s.url + "/api/info", { headers: { authorization: `Bearer ${s.token}` } });
    expect(await response.json()).toMatchObject({ platform: "win32", features: { backgroundProcesses: false, notificationStream: true } });
    expect(s.background.list("all")).toEqual([]);
  });
});

describe("desktop daemon lifecycle", () => {
  it("falls back from an occupied default base, records actual port, and explicit port fails", async () => {
    const occupied = createServer(); await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    try {
      const address = occupied.address(); if (!address || typeof address === "string") throw new Error("No port");
      const { s } = await setup(undefined, { port: undefined, portBase: address.port });
      expect(s.port).toBeGreaterThan(address.port); expect(s.port).toBeLessThanOrEqual(address.port + 20);
      expect(JSON.parse(await readFile(join(s.home, "daemon.json"), "utf8"))).toMatchObject({ port: s.port, pid: process.pid, url: s.url, startedAt: expect.any(String), version: "0.1.0", spawnedBy: "cli" });
      await expect(startServer({ home: await home(), port: address.port, registry: new FakeDriverRegistry() })).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
  });
  it("CLI honors BATON_HOME and closes cleanly when the desktop stdin pipe ends", async () => {
    const path = await home();
    const child = spawn(process.execPath, ["packages/server/dist/cli/main.js", "serve", "--fake", "--port", "0", "--notifications", "client", "--exit-on-stdin-close"], { env: { ...process.env, BATON_HOME: path, BATON_SPAWNED_BY: "desktop" }, stdio: ["pipe", "pipe", "pipe"] }); children.add(child);
    let output = ""; child.stdout!.on("data", (value: Buffer) => { output += value.toString(); }); child.stderr!.resume();
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await until(() => output.includes("baton listening"));
    expect(JSON.parse(await readFile(join(path, "daemon.json"), "utf8"))).toMatchObject({ spawnedBy: "desktop", port: expect.any(Number), pid: child.pid, startedAt: expect.any(String), version: "0.1.0" });
    child.stdin!.end(); expect(await exited).toBe(0); children.delete(child);
  });
  it.skipIf(process.platform === "win32")("stdin-close interrupts sessions and kills fake child processes", async () => {
    let pid = 0;
    const { s, create } = await setup(async (c) => { pid = await c.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true }); await c.sleep(100000); });
    await create(); await until(() => pid > 0);
    const stdin = new PassThrough(), codes: number[] = [];
    installShutdown(s, { stdin, exitOnStdinClose: true, exit: (code) => { codes.push(code); } }); stdin.end();
    await until(() => codes.length === 1); expect(codes).toEqual([0]);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    expect((s.kernel.registry as FakeDriverRegistry).get("root")!.sessions[0]!.closed).toBe(true);
  });
  it("config client suppresses the OS notifier while the notification stream remains active", async () => {
    const path = await home(); await writeFile(join(path, "config.json"), JSON.stringify({ notifications: { mode: "client" } }));
    let osCalls = 0; const { s, create } = await setup(undefined, { home: path, platform: "darwin", osNotifier: () => { osCalls++; } });
    const stream = await notificationStream(s);
    try { await create(); expect((await stream.next()).kind).toBe("run_completed"); expect(osCalls).toBe(0); } finally { await stream.close(); }
  });
});
