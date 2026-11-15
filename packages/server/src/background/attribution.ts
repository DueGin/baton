import { basename, relative, sep } from "node:path";
import type { BackgroundProcess, ToolSpanRecord } from "@baton/protocol";
import { processId, type ProcessInfo } from "./system.js";

export interface ProcessSource { runId: string; nodeId: string; cwd: string; pids: number[]; spans: ToolSpanRecord[] }
interface Owner { source: ProcessSource; attribution: BackgroundProcess["attribution"]; span?: ToolSpanRecord }
export interface AttributedProcess extends ProcessInfo { owner: Owner; ports: number[]; cwd?: string; toolShell?: boolean }
const contains = (cwd: string, child: string): boolean => { const path = relative(cwd, child); return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep)); };
function executable(command: string): string { return basename(command.trim().split(/\s+/, 1)[0] ?? "").replace(/^-/, ""); }
function isShell(command: string): boolean { return /^(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh)$/.test(executable(command)); }
function windowMatches(p: ProcessInfo, span: ToolSpanRecord, timestamp: number): boolean {
  const start = Date.parse(p.startedAt);
  return start >= Date.parse(span.startedAt) - 1000 && start <= (span.endedAt ? Date.parse(span.endedAt) + 3000 : timestamp);
}
function choose(p: ProcessInfo, candidates: Array<{ source: ProcessSource; span: ToolSpanRecord }>): { source: ProcessSource; span: ToolSpanRecord } | undefined {
  const name = executable(p.command);
  return candidates.sort((a, b) => Number(!!name && !!b.span.summary?.includes(name)) - Number(!!name && !!a.span.summary?.includes(name)) || Date.parse(b.span.startedAt) - Date.parse(a.span.startedAt) || a.source.nodeId.localeCompare(b.source.nodeId))[0];
}
/** Remembers observed tool shells even after launchd/systemd reparents their children. */
export class Attribution {
  private owners = new Map<string, { nodeId: string; spanId?: string; attribution: BackgroundProcess["attribution"] }>();
  private infrastructure = new Set<string>();
  private toolShells = new Set<string>();
  private groups = new Map<number, { nodeId: string; spanId?: string; shellId: string }>();
  seed(records: BackgroundProcess[]): void {
    for (const record of records) if (record.nodeId && record.status !== "exited") {
      this.owners.set(record.id, { nodeId: record.nodeId, spanId: record.toolSpanId, attribution: record.attribution });
      this.groups.set(record.pgid, { nodeId: record.nodeId, spanId: record.toolSpanId, shellId: record.id });
    }
  }
  attribute(processes: ProcessInfo[], sources: ProcessSource[], cwds: Map<number, string>, ports: Map<number, number[]>, timestamp: number): AttributedProcess[] {
    const byPid = new Map(processes.map((p) => [p.pid, p])), byNode = new Map(sources.map((s) => [s.nodeId, s]));
    const roots = new Map(sources.flatMap((s) => s.pids.map((pid) => [pid, s] as const)));
    const protectedGroups = new Set(processes.filter((p) => roots.has(p.pid) || p.pid === process.pid).map((p) => p.pgid));
    // A reused shell pid/group must never inherit the previous session's ownership.
    for (const [pgid, group] of this.groups) {
      const current = byPid.get(pgid);
      if (current && processId(current) !== group.shellId && pgid === Number(group.shellId.split(":")[0])) this.groups.delete(pgid);
    }
    const result: AttributedProcess[] = [];
    const visit = (p: ProcessInfo): Owner | undefined => {
      if (roots.has(p.pid) || p.pid === process.pid || this.infrastructure.has(processId(p))) return undefined;
      const chain: ProcessInfo[] = []; let ancestor: ProcessInfo | undefined = p; const seen = new Set<number>();
      while (ancestor && !seen.has(ancestor.pid)) {
        seen.add(ancestor.pid); chain.push(ancestor);
        const source = roots.get(ancestor.ppid);
        if (source) {
          const blocked = chain.some((entry) => this.infrastructure.has(processId(entry)));
          const span = choose(p, source.spans.filter((s) => windowMatches(p, s, timestamp)).map((span) => ({ source, span })))?.span;
          const remembered = chain.map((entry) => this.owners.get(processId(entry))).find((memory) => memory?.nodeId === source.nodeId);
          if (blocked || (!span && !remembered)) { this.infrastructure.add(processId(p)); return undefined; }
          return { source, span: span ?? source.spans.find((s) => s.id === remembered?.spanId), attribution: "tree" };
        }
        ancestor = byPid.get(ancestor.ppid);
      }
      const remembered = this.owners.get(processId(p)), group = protectedGroups.has(p.pgid) ? undefined : this.groups.get(p.pgid);
      const memory = remembered ?? group, source = memory ? byNode.get(memory.nodeId) : undefined;
      if (source) return { source, attribution: remembered?.attribution === "inferred" ? "inferred" : "group", span: source.spans.find((s) => s.id === memory?.spanId) };
      if (p.ppid !== 1) return undefined;
      const cwd = cwds.get(p.pid);
      if (!cwd) return undefined;
      const candidates = sources.flatMap((source) => contains(source.cwd, cwd) ? source.spans.filter((s) => windowMatches(p, s, timestamp)).map((span) => ({ source, span })) : []);
      const inferred = choose(p, candidates);
      return inferred ? { ...inferred, attribution: "inferred" } : undefined;
    };
    // Ancestors first: infrastructure descendants inherit exclusion.
    const depth = (p: ProcessInfo): number => { let n = p, d = 0; const seen = new Set<number>(); while (byPid.has(n.ppid) && !seen.has(n.ppid)) { seen.add(n.ppid); n = byPid.get(n.ppid)!; d++; } return d; };
    for (const p of [...processes].sort((a, b) => depth(a) - depth(b))) {
      const owner = visit(p); if (!owner) continue;
      // Tool-launch shells still supply ownership/group memory, but must never be service roots.
      if (roots.has(p.ppid) && isShell(p.command)) this.toolShells.add(processId(p));
      const memory = { nodeId: owner.source.nodeId, spanId: owner.span?.id, attribution: owner.attribution };
      this.owners.set(processId(p), memory);
      if (owner.attribution === "tree") {
        const groupLeader = byPid.get(p.pgid);
        this.groups.set(p.pid, { ...memory, shellId: processId(p) });
        if (!protectedGroups.has(p.pgid)) this.groups.set(p.pgid, { ...memory, shellId: groupLeader ? processId(groupLeader) : `${p.pgid}:0` });
      }
      result.push({ ...p, owner, cwd: cwds.get(p.pid), ports: ports.get(p.pid) ?? [], ...(this.toolShells.has(processId(p)) ? { toolShell: true } : {}) });
    }
    const living = new Set(processes.map(processId));
    for (const key of this.owners.keys()) if (!living.has(key)) this.owners.delete(key);
    for (const key of this.infrastructure) if (!living.has(key)) this.infrastructure.delete(key);
    for (const key of this.toolShells) if (!living.has(key)) this.toolShells.delete(key);
    return result;
  }
}
export function foldProcesses(attributed: AttributedProcess[], timestamp: number): BackgroundProcess[] {
  const byPid = new Map(attributed.map((p) => [p.pid, p]));
  const background = attributed.filter((p) => !p.toolShell && (p.ports.length || p.owner.attribution !== "tree" || p.owner.span?.endedAt && timestamp >= Date.parse(p.owner.span.endedAt) + 5000));
  const families = new Map<number, AttributedProcess[]>();
  for (const p of background) {
    let top = p; const seen = new Set([p.pid]);
    while (true) {
      const parent = byPid.get(top.ppid);
      if (!parent || parent.toolShell || parent.owner.source.nodeId !== p.owner.source.nodeId || seen.has(parent.pid)) break;
      seen.add(parent.pid); top = parent;
    }
    families.set(top.pid, []);
  }
  for (const p of attributed) for (const [pid, family] of families) {
    let current: AttributedProcess | undefined = p; const seen = new Set<number>();
    while (current && !seen.has(current.pid)) { if (current.pid === pid) { family.push(p); break; } seen.add(current.pid); current = byPid.get(current.ppid); }
  }
  return [...families].map(([pid, family]) => {
    const top = byPid.get(pid)!;
    return { id: processId(top), runId: top.owner.source.runId, nodeId: top.owner.source.nodeId, pid, ppid: top.ppid, pgid: top.pgid, command: top.command, cwd: top.cwd, ports: [...new Set(family.flatMap((p) => p.ports))].sort((a, b) => a - b), children: family.filter((p) => p.pid !== pid).map((p) => ({ pid: p.pid, command: p.command, ports: p.ports })).sort((a, b) => a.pid - b.pid), startedAt: top.startedAt, status: "running", attribution: top.owner.attribution, toolSpanId: top.owner.span?.id, lastSeenAt: new Date(timestamp).toISOString() };
  });
}
