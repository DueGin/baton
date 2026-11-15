import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

export interface ProcessInfo { pid: number; ppid: number; pgid: number; startedAt: string; command: string }
export const processId = (p: Pick<ProcessInfo, "pid" | "startedAt">): string => `${p.pid}:${Math.floor(Date.parse(p.startedAt) / 1000)}`;
export function parsePs(output: string): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!match) continue;
    const time = Date.parse(match[4]!);
    if (!Number.isFinite(time) || /(?:<defunct>|\(zombie\))/.test(match[5]!)) continue;
    result.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAt: new Date(time).toISOString(), command: match[5]!.slice(0, 2000) });
  }
  return result;
}
export function parsePorts(output: string): Map<number, number[]> {
  const result = new Map<number, number[]>(); let pid = 0;
  for (const line of output.split("\n")) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (pid && line.startsWith("n")) {
      const port = Number(/:(\d+)(?:\s|$)/.exec(line)?.[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) result.set(pid, [...new Set([...(result.get(pid) ?? []), port])].sort((a, b) => a - b));
    }
  }
  return result;
}
export function parseCwds(output: string): Map<number, string> {
  const result = new Map<number, string>(); let pid = 0;
  for (const line of output.split("\n")) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (pid && line.startsWith("n/")) result.set(pid, line.slice(1));
  }
  return result;
}
function command(file: string, args: string[], tolerate = false): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
    if (!error || (tolerate && stdout)) resolve(stdout);
    else reject(error);
  }));
}
export interface ProcessSystem {
  processes(): Promise<ProcessInfo[]>;
  ports(): Promise<Map<number, number[]> | undefined>;
  cwds(pids: number[]): Promise<Map<number, string>>;
  realpath(path: string): Promise<string>;
  signal(pid: number, signal: NodeJS.Signals): void;
}
export const processSystem: ProcessSystem = {
  async processes() { return parsePs(await command("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="])); },
  async ports() { try { return parsePorts(await command("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], true)); } catch { return undefined; } },
  async cwds(pids) {
    const result = new Map<number, string>();
    for (let i = 0; i < pids.length; i += 200) {
      try { for (const [pid, cwd] of parseCwds(await command("lsof", ["-a", "-d", "cwd", "-p", pids.slice(i, i + 200).join(","), "-Fpn"], true))) result.set(pid, cwd); }
      catch { /* missing/slow lsof must not disable tree/group tracking */ }
    }
    return result;
  },
  realpath,
  signal(pid, signal) { process.kill(pid, signal); },
};
