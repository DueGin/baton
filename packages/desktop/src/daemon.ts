import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface DaemonConnection { url: string; token: string; port: number }
type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function daemonAddress(value: unknown): { url: string; port: number } | null {
  if (!object(value) || typeof value.url !== "string" || typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null;
  try {
    const url = new URL(value.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || Number(url.port || 80) !== value.port) return null;
    return { url: url.origin, port: value.port };
  } catch { return null; }
}

/** A stale descriptor, unrelated HTTP service, mismatched home, or token never counts as a daemon. */
export async function discoverDaemon(home: string, request: typeof fetch = fetch): Promise<DaemonConnection | null> {
  try {
    const [descriptor, tokenFile] = await Promise.all([readFile(join(home, "daemon.json"), "utf8"), readFile(join(home, "token"), "utf8")]);
    const address = daemonAddress(JSON.parse(descriptor) as unknown), token = tokenFile.trim();
    if (!address || !/^[a-zA-Z0-9_-]{32,256}$/u.test(token)) return null;
    const response = await request(`${address.url}/api/info`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const info: unknown = await response.json();
    const sameHome = object(info) && typeof info.home === "string" && (process.platform === "win32" ? resolve(info.home).toLowerCase() === resolve(home).toLowerCase() : resolve(info.home) === resolve(home));
    if (!sameHome || !object(info) || info.name !== "baton" || info.port !== address.port) return null;
    return { ...address, token };
  } catch { return null; }
}

export class DaemonManager {
  private child?: ChildProcess;
  private stopping = false;
  private restart?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private connection?: DaemonConnection;
  private starting?: Promise<DaemonConnection>;
  constructor(private readonly options: { home: string; executable: string; entry: string; env: NodeJS.ProcessEnv; connected: (connection: DaemonConnection) => void; failed: (error: unknown) => void }) {}
  get owned(): boolean { return Boolean(this.child); }
  async start(): Promise<DaemonConnection> {
    this.starting ??= this.connect().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async connect(withNotificationFlag = true): Promise<DaemonConnection> {
    const existing = await discoverDaemon(this.options.home);
    if (existing) { this.connection = existing; this.options.connected(existing); return existing; }
    if (this.stopping) throw new Error("Desktop is stopping");
    await mkdir(this.options.home, { recursive: true, mode: 0o700 });
    const logPath = join(this.options.home, "desktop-daemon.log");
    const previousLogSize = await stat(logPath).then(value => value.size).catch(() => 0);
    const log = openSync(logPath, "a", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(this.options.executable, [this.options.entry, "serve", ...(withNotificationFlag ? ["--notifications", "client", "--exit-on-stdin-close"] : []), ...(this.options.env.BATON_DESKTOP_PORT ? ["--port", this.options.env.BATON_DESKTOP_PORT] : []), ...(this.options.env.BATON_DESKTOP_FAKE === "1" ? ["--fake"] : [])], {
        env: { ...this.options.env, BATON_HOME: this.options.home, BATON_SPAWNED_BY: "desktop", ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", log, log], windowsHide: true,
      });
    } finally { closeSync(log); }
    this.child = child;
    let spawnError: Error | undefined;
    child.on("error", error => { spawnError = error; });
    const startedAt = Date.now();
    let ready = false;
    child.once("exit", () => {
      if (this.child === child) this.child = undefined;
      if (!this.stopping && ready) {
        this.options.failed(new Error("Daemon exited unexpectedly; restarting. See desktop-daemon.log."));
        if (Date.now() - startedAt > 60_000) this.attempts = 0;
        this.queueRestart();
      }
    });
    for (let attempt = 0; attempt < 150 && !this.stopping; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        if (withNotificationFlag && Date.now() - startedAt < 3000) {
          const startupLog = (await readFile(logPath, "utf8")).slice(previousLogSize);
          if (/unknown (?:option|argument)[^\n]*(?:notifications|exit-on-stdin-close)/iu.test(startupLog)) {
            await appendFile(logPath, "\n[desktop] Older daemon does not support --notifications; retrying once without it. Native notification SSE may be unavailable.\n");
            return this.connect(false);
          }
        }
        throw new Error("Daemon exited during startup. See desktop-daemon.log.");
      }
      const connection = await discoverDaemon(this.options.home);
      if (connection) { ready = true; this.connection = connection; this.options.connected(connection); return connection; }
      await delay(200);
    }
    // Never leave an unobserved child behind after a failed startup.
    if (process.platform === "win32") child.stdin?.end(); else child.kill("SIGTERM");
    throw new Error("Timed out starting daemon. See desktop-daemon.log.");
  }
  private queueRestart(): void {
    if (this.restart || this.stopping) return;
    this.restart = setTimeout(() => { this.restart = undefined; void this.start().catch(error => { this.options.failed(error); this.queueRestart(); }); }, Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)));
  }
  async activeRuns(): Promise<number> {
    if (!this.connection) return 0;
    const response = await fetch(`${this.connection.url}/api/runs`, { headers: { authorization: `Bearer ${this.connection.token}` }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("Unable to check active runs");
    const runs: unknown = await response.json();
    if (!Array.isArray(runs)) throw new Error("Invalid runs response");
    return runs.filter((run: unknown) => object(run) && (run.status === "active" || run.status === "paused")).length;
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restart);
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolveStopped => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
      child.once("exit", () => { clearTimeout(timer); resolveStopped(); });
      if (process.platform === "win32") child.stdin?.end(); else child.kill("SIGTERM");
    });
  }
}
