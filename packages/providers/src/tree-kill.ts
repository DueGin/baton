// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/utils/tree-kill.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import treeKill from "tree-kill";
import { execFile } from "node:child_process";
export interface TreeKillTarget {
    pid?: number;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
    once?(event: "exit", listener: () => void): unknown;
}
export interface TerminateWithTreeKillOptions {
    gracefulSignal?: NodeJS.Signals;
    forceSignal?: NodeJS.Signals;
    gracefulTimeoutMs: number;
    forceTimeoutMs?: number;
    onForceSignal?: () => void;
}
export type TerminateWithTreeKillResult = "already-exited" | "terminated" | "killed" | "kill-timeout";
// Injection seam: production wires terminateWithTreeKill; tests wire a fake that
// records which children were terminated as observable state.
export type ProcessTerminator = (child: TreeKillTarget, options: TerminateWithTreeKillOptions) => Promise<TerminateWithTreeKillResult>;
export async function terminateWithTreeKill(child: TreeKillTarget, options: TerminateWithTreeKillOptions): Promise<TerminateWithTreeKillResult> {
    if (isProcessExited(child)) {
        return "already-exited";
    }
    const exitPromise = waitForProcessExit(child);
    await signalProcessTree(child, options.gracefulSignal ?? "SIGTERM");
    if (await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs)) {
        return "terminated";
    }
    options.onForceSignal?.();
    await signalProcessTree(child, options.forceSignal ?? "SIGKILL");
    if (options.forceTimeoutMs === undefined) {
        return "killed";
    }
    return (await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs))
        ? "killed"
        : "kill-timeout";
}
export function signalProcessTree(child: TreeKillTarget, signal: NodeJS.Signals): Promise<void> {
    if (isProcessExited(child)) {
        return Promise.resolve();
    }
    const pid = child.pid;
    if (typeof pid !== "number" || pid <= 0) {
        signalDirectChild(child, signal);
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        treeKill(pid, signal, (error) => {
            // Enumerate descendants before killing the group: tools may each own a
            // process group and become invisible to tree-kill after the root exits.
            if (process.platform !== "win32") { try { process.kill(-pid, signal); } catch { /* non-group fixture or already exited */ } }
            if (error) {
                signalDirectChild(child, signal);
            }
            resolve();
        });
    });
}
/** Force-close captured session roots even if their control channel is unresponsive. */
export async function terminateProcessIds(pids: number[]): Promise<void> {
    await Promise.all([...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid).map(async (pid) => {
        await signalProcessTree({ pid, kill(signal) { try { process.kill(pid, signal ?? "SIGKILL"); return true; } catch { return false; } } }, "SIGKILL");
    }));
}
/** Capture descendants while the agent is still alive so shutdown can reap them
 * even if a graceful interrupt reparents a tool process. Windows taskkill /T owns
 * its tree enumeration; providers keep the root alive until close(). */
export async function descendantProcessIds(roots: number[]): Promise<number[]> {
    if (process.platform === "win32" || !roots.length) return roots;
    const output = await new Promise<string>((resolve) => execFile("ps", ["-axo", "pid=,ppid="], { timeout: 1000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout)));
    const rows = output.split("\n").flatMap((line) => { const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line); return match ? [{ pid: Number(match[1]), ppid: Number(match[2]) }] : []; });
    const family = new Set(roots); let changed = true;
    while (changed) { changed = false; for (const row of rows) if (family.has(row.ppid) && !family.has(row.pid)) { family.add(row.pid); changed = true; } }
    return [...family];
}
function signalDirectChild(child: TreeKillTarget, signal: NodeJS.Signals): void {
    try {
        child.kill(signal);
    }
    catch {
        // Ignore cleanup races.
    }
}
function isProcessExited(child: TreeKillTarget): boolean {
    return ((child.exitCode !== null && child.exitCode !== undefined) ||
        (child.signalCode !== null && child.signalCode !== undefined));
}
function waitForProcessExit(child: TreeKillTarget): Promise<void> {
    if (isProcessExited(child)) {
        return Promise.resolve();
    }
    if (!child.once) {
        return new Promise(() => undefined);
    }
    return new Promise((resolve) => {
        child.once?.("exit", resolve);
    });
}
async function waitForExitOrTimeout(exitPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | null = null;
    try {
        return await Promise.race([
            exitPromise.then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
