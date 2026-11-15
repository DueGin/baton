import { setTimeout as delay } from "node:timers/promises";
import type { BackgroundProcess, ListBackgroundResponse } from "@baton/protocol";
import type { Store } from "../store/index.js";
import { Attribution, foldProcesses, type ProcessSource } from "./attribution.js";
import { processId, processSystem, type ProcessInfo, type ProcessSystem } from "./system.js";

export interface BackgroundOptions { system?: ProcessSystem; activeMs?: number; idleMs?: number; afterShellMs?: number; now?: () => number; platform?: NodeJS.Platform }
export class BackgroundRegistry {
  private attribution = new Attribution();
  private flight?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private extras = new Set<NodeJS.Timeout>();
  private unsubscribe: () => void;
  private stopped = false;
  private stops = new Map<string, Promise<BackgroundProcess>>();
  readonly system: ProcessSystem;
  private now: () => number;
  constructor(readonly store: Store, readonly sources: () => ProcessSource[], readonly options: BackgroundOptions = {}) {
    this.system = options.system ?? processSystem; this.now = options.now ?? Date.now;
    this.attribution.seed(store.background());
    this.unsubscribe = store.subscribe((event) => {
      if (event.type === "tool.span" && event.span.kind === "shell" && event.span.endedAt) {
        const timer = setTimeout(() => { this.extras.delete(timer); void this.scan().catch(() => {}); }, options.afterShellMs ?? 2000);
        timer.unref(); this.extras.add(timer);
      }
      if (event.type === "turn.started" || event.type === "run.created") this.schedule(0);
    });
    this.schedule(0);
  }
  private schedule(ms?: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const active = this.store.list().some((r) => this.store.snapshot(r.id).turns.some((t) => t.status === "running"));
    this.timer = setTimeout(() => { this.timer = undefined; void this.scan().catch(() => {}).finally(() => this.schedule()); }, ms ?? (active ? this.options.activeMs ?? 3000 : this.options.idleMs ?? 20000)); this.timer.unref();
  }
  scan(): Promise<void> {
    if (this.stopped || (this.options.platform ?? process.platform) === "win32" || !this.store.list().length) return Promise.resolve();
    if (!this.flight) this.flight = this.inspect().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async inspect(): Promise<void> {
    const [processes, scannedPorts] = await Promise.all([this.system.processes(), this.system.ports()]);
    if (this.stopped) return;
    const sources = this.sources(), candidates = new Set(processes.filter((p) => p.ppid === 1).map((p) => p.pid));
    const roots = new Set(sources.flatMap((s) => s.pids));
    for (const record of this.store.background()) { candidates.add(record.pid); for (const child of record.children) candidates.add(child.pid); }
    const descendants = new Set(roots);
    let changed = true;
    while (changed) { changed = false; for (const p of processes) if (descendants.has(p.ppid) && !descendants.has(p.pid)) { descendants.add(p.pid); candidates.add(p.pid); changed = true; } }
    const cwds = await this.system.cwds([...candidates]);
    const canonical = new Map<string, string | undefined>();
    await Promise.all([...new Set([...cwds.values(), ...sources.map((s) => s.cwd)])].map(async (path) => { try { canonical.set(path, await this.system.realpath(path)); } catch { canonical.set(path, undefined); } }));
    if (this.stopped) return;
    const realCwds = new Map([...cwds].flatMap(([pid, cwd]) => canonical.get(cwd) ? [[pid, canonical.get(cwd)!] as const] : []));
    const realSources = sources.map((s) => ({ ...s, cwd: canonical.get(s.cwd) ?? `\0unresolved:${s.nodeId}` }));
    const ports = scannedPorts ?? new Map(this.store.background().flatMap((p) => [[p.pid, p.ports] as const, ...p.children.map((c) => [c.pid, c.ports] as const)]));
    const timestamp = this.now(), attributed = this.attribution.attribute(processes, realSources, realCwds, ports, timestamp);
    const folded = foldProcesses(attributed, timestamp), current = new Map(processes.map((p) => [processId(p), p]));
    const previous = new Map(this.store.background().map((p) => [p.id, p]));
    for (const record of folded) {
      const old = previous.get(record.id);
      const next = { ...record, ...(!scannedPorts && old ? { ports: old.ports } : {}), ...(old?.dismissed !== undefined ? { dismissed: old.dismissed } : {}), ...(old?.stoppedBy ? { stoppedBy: old.stoppedBy } : {}), ...(old?.status === "stopping" ? { status: "stopping" as const } : {}) };
      if (!old || this.meaningful(old) !== this.meaningful(next) || timestamp - Date.parse(old.lastSeenAt) >= 60000) this.emit(next);
    }
    for (const old of previous.values()) {
      if (old.status === "exited") continue;
      const live = current.get(old.id);
      if (!live) this.emit({ ...old, status: "exited", exitedAt: new Date(timestamp).toISOString() });
      else if (!folded.some((p) => p.id === old.id)) {
        // Known registrations stay attached after restart, even if no agent session is open.
        const family = new Set([old.pid]); let grew = true;
        while (grew) { grew = false; for (const p of processes) if (family.has(p.ppid) && !family.has(p.pid)) { family.add(p.pid); grew = true; } }
        const children = processes.filter((p) => p.pid !== old.pid && family.has(p.pid)).map((p) => ({ pid: p.pid, command: p.command, ports: scannedPorts?.get(p.pid) ?? old.children.find((c) => c.pid === p.pid)?.ports ?? [] })).sort((a, b) => a.pid - b.pid);
        const next = { ...old, ppid: live.ppid, children, ...(realCwds.get(old.pid) ? { cwd: realCwds.get(old.pid) } : {}), ...(scannedPorts ? { ports: [...new Set([...(scannedPorts.get(old.pid) ?? []), ...children.flatMap((c) => c.ports)])].sort((a, b) => a - b) } : {}), lastSeenAt: new Date(timestamp).toISOString() };
        if (this.meaningful(old) !== this.meaningful(next) || timestamp - Date.parse(old.lastSeenAt) >= 60000) this.emit(next);
      }
    }
  }
  private meaningful(p: BackgroundProcess): string { const { lastSeenAt: _last, ...rest } = p; return JSON.stringify(rest); }
  private emit(process: BackgroundProcess): void { this.store.append(process.runId, { type: "background", process }); }
  list(status = "running"): ListBackgroundResponse {
    if (!["running", "all", "exited", "stopping"].includes(status)) throw new Error("Invalid background status");
    if ((this.options.platform ?? process.platform) === "win32") return [];
    return this.store.background().filter((p) => status === "all" || !p.dismissed && (status === "running" ? p.status !== "exited" : p.status === status)).map((p) => ({ ...p, runTitle: this.store.snapshot(p.runId).run.title }));
  }
  dismiss(id: string, dismissed: boolean): BackgroundProcess {
    if (typeof dismissed !== "boolean") throw new Error("dismissed must be a boolean");
    const p = this.store.backgroundProcess(id), next = { ...p, dismissed }; this.emit(next); return next;
  }
  stop(id: string, graceMs = 5000): Promise<BackgroundProcess> {
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 60000) return Promise.reject(new Error("graceMs must be between 0 and 60000"));
    const pending = this.stops.get(id); if (pending) return pending;
    const record = this.store.backgroundProcess(id);
    if (record.status !== "running") return Promise.reject(new Error("Only registered running processes can be stopped"));
    const work = this.stopFamily(record, graceMs).finally(() => { this.stops.delete(id); }); this.stops.set(id, work); return work;
  }
  private async stopFamily(record: BackgroundProcess, graceMs: number): Promise<BackgroundProcess> {
    const initial = await this.system.processes(), root = initial.find((p) => processId(p) === record.id);
    if (!root) { const exited = { ...record, status: "exited" as const, exitedAt: new Date(this.now()).toISOString() }; this.emit(exited); return exited; }
    const forbidden = new Set([process.pid, 1, ...this.sources().flatMap((s) => s.pids)]);
    if (forbidden.has(root.pid)) throw new Error("Cannot stop daemon or agent infrastructure");
    const family = new Map<number, ProcessInfo>([[root.pid, root]]); let changed = true;
    while (changed) { changed = false; for (const p of initial) if (family.has(p.ppid) && !family.has(p.pid)) { family.set(p.pid, p); changed = true; } }
    if ([...family.keys()].some((pid) => forbidden.has(pid))) throw new Error("Process family includes agent infrastructure");
    const daemonGroup = initial.find((p) => p.pid === process.pid)?.pgid;
    const agentGroups = new Set(initial.filter((p) => forbidden.has(p.pid)).map((p) => p.pgid));
    const groupMembers = initial.filter((p) => p.pgid === root.pgid);
    const safeGroup = root.pgid > 1 && root.pgid !== daemonGroup && !agentGroups.has(root.pgid) && groupMembers.every((p) => family.has(p.pid));
    const stopping = { ...record, status: "stopping" as const, stoppedBy: "human" as const }; this.emit(stopping);
    const signal = async (kind: NodeJS.Signals): Promise<boolean> => {
      const latest = await this.system.processes(), live = new Map(latest.map((p) => [p.pid, p]));
      // Include children created during the grace interval while a known parent is still alive.
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of latest) {
          const parent = family.get(p.ppid), currentParent = live.get(p.ppid);
          if (!family.has(p.pid) && parent && currentParent && processId(parent) === processId(currentParent) && !forbidden.has(p.pid)) { family.set(p.pid, p); grew = true; }
        }
      }
      const matches = [...family.values()].filter((p) => live.has(p.pid) && processId(live.get(p.pid)!) === processId(p));
      if (!matches.length) return false;
      // Recheck every group member immediately before a negative-pid signal.
      const grouped = safeGroup && latest.filter((p) => p.pgid === root.pgid).every((p) => family.has(p.pid) && processId(family.get(p.pid)!) === processId(p));
      if (grouped) this.kill(-root.pgid, kind);
      {
        const depth = (p: ProcessInfo): number => { let d = 0, n = p; const seen = new Set<number>(); while (family.has(n.ppid) && !seen.has(n.ppid)) { seen.add(n.ppid); n = family.get(n.ppid)!; d++; } return d; };
        for (const p of matches.filter((p) => !grouped || p.pgid !== root.pgid).sort((a, b) => depth(b) - depth(a))) this.kill(p.pid, kind);
      }
      return true;
    };
    try {
      if (graceMs) {
        await signal("SIGTERM"); const end = Date.now() + graceMs;
        while (Date.now() < end) { const live = await this.system.processes(); if (!live.some((p) => family.has(p.pid) && processId(p) === processId(family.get(p.pid)!))) break; await delay(Math.min(50, end - Date.now())); }
      }
      await signal("SIGKILL");
      for (let i = 0; i < 20; i++) { const live = await this.system.processes(); if (!live.some((p) => family.has(p.pid) && processId(p) === processId(family.get(p.pid)!))) { const exited = { ...stopping, status: "exited" as const, exitedAt: new Date(this.now()).toISOString() }; this.emit(exited); return exited; } await delay(25); }
      throw new Error("Background process did not exit after SIGKILL");
    } catch (error) { this.emit({ ...stopping, status: "running" }); throw error; }
  }
  private kill(pid: number, signal: NodeJS.Signals): void { try { this.system.signal(pid, signal); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error; } }
  async stopRun(runId: string): Promise<void> { for (const p of this.store.background().filter((p) => p.runId === runId && p.status === "running")) await this.stop(p.id); }
  async close(): Promise<void> { this.stopped = true; clearTimeout(this.timer); for (const timer of this.extras) clearTimeout(timer); this.extras.clear(); this.unsubscribe(); await this.flight; await Promise.allSettled(this.stops.values()); }
}
