// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/utils/tree-kill.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import treeKill from "tree-kill";
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
    // Provider sessions are their own POSIX process group. Signaling the group also
    // catches children that were reparented after their launcher exited.
    if (process.platform !== "win32") { try { process.kill(-pid, signal); } catch { /* non-group fixture or already exited */ } }
    return new Promise((resolve) => {
        treeKill(pid, signal, (error) => {
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
