// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/codex/rewind.ts and codex/thread-history.ts (Paseo app 0.16 build) — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton: the rewind point is the native turn before a prompt; forks via thread/fork lastTurnId (Codex ≥ 0.16x), falling back to beforeTurnId and to the legacy fork + thread/rollback, and verifies the fork's length because older servers ignore unknown parameters.
import { CodexAppServerRpcError } from "./app-server-transport.js";

export interface CodexRewindClient { request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> }
/** Turns before a prompt: `turnId` is the last of them (null: the prompt opened the thread). */
export interface CodexRewindPoint { threadId: string; turnId: string | null; index: number }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const unsupported = (error: unknown): boolean => error instanceof CodexAppServerRpcError && (error.code === -32601 || error.code === -32602);

export function parseCodexRewindPoint(value: unknown): CodexRewindPoint {
    const point = record(value);
    if (typeof point.threadId !== "string" || !point.threadId || (point.turnId !== null && typeof point.turnId !== "string") || typeof point.index !== "number" || !Number.isInteger(point.index) || point.index < -1) throw new Error("Invalid Codex rewind point");
    return { threadId: point.threadId, turnId: point.turnId, index: point.index };
}
/** A thread's turn ids in order (paged thread/turns/list; thread/read with turns on older servers). */
export async function listCodexTurns(client: CodexRewindClient, threadId: string): Promise<string[]> {
    const ids: string[] = [], seen = new Set<string>();
    let cursor: string | null = null;
    try {
        do {
            const page = record(await client.request("thread/turns/list", { threadId, cursor, limit: 100, sortDirection: "asc" }));
            for (const turn of Array.isArray(page.data) ? page.data.map(record) : []) if (typeof turn.id === "string") ids.push(turn.id);
            cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
            // Codex's own client guards against a cursor that does not advance.
            if (cursor && seen.has(cursor)) throw new Error(`Codex repeated a turns cursor for thread ${threadId}`);
            if (cursor) seen.add(cursor);
        } while (cursor);
        return ids;
    } catch (error) {
        if (!unsupported(error)) throw error;
    }
    const read = record(record(await client.request("thread/read", { threadId, includeTurns: true })).thread);
    return (Array.isArray(read.turns) ? read.turns.map(record) : []).flatMap(turn => typeof turn.id === "string" ? [turn.id] : []);
}
/**
 * Rewind to the point: a new thread holding the turns up to `point.turnId` (the old thread stays on
 * disk, recoverable with `codex resume`). Resolves with the thread to continue in; null = start a new
 * thread (the prompt opened the conversation). Codex rewind is chat-only: files stay as they are.
 */
export async function revertCodexConversation(client: CodexRewindClient, point: CodexRewindPoint, fork: { cwd?: string; model?: string }): Promise<string | null> {
    if (point.turnId === null || point.index < 0) return null;
    const turns = await listCodexTurns(client, point.threadId);
    const index = turns.indexOf(point.turnId) >= 0 ? turns.indexOf(point.turnId) : point.index;
    if (index >= turns.length) throw new Error("Codex rewind target is not in the thread");
    const keep = index + 1;
    // Codex does not carry the parent thread's config into a fork; the host resumes the new thread
    // with its full settings (MCP servers, sandbox) right after.
    const base = { threadId: point.threadId, ...(fork.cwd ? { cwd: fork.cwd } : {}), ...(fork.model ? { model: fork.model } : {}), excludeTurns: true };
    const attempts: Array<() => Promise<string | null>> = [
        async () => forked(client, await client.request("thread/fork", { ...base, lastTurnId: turns[index] }), keep),
        async () => turns[keep] ? forked(client, await client.request("thread/fork", { ...base, beforeTurnId: turns[keep] }), keep) : null,
        // Legacy threads on Codex before 0.156: fork, then roll the fork back.
        async () => {
            const copy = threadId(await client.request("thread/fork", base));
            const rolled = threadId(await client.request("thread/rollback", { threadId: copy, numTurns: turns.length - keep }));
            return forked(client, { thread: { id: rolled } }, keep);
        },
    ];
    for (const attempt of attempts) {
        try { const id = await attempt(); if (id) return id; }
        catch (error) { if (!unsupported(error) && !(error instanceof ForkLengthError)) throw error; }
    }
    throw new Error("This Codex version cannot fork a thread at a turn");
}
class ForkLengthError extends Error {}
function threadId(response: unknown): string {
    const id = record(record(response).thread).id;
    if (typeof id !== "string" || !id) throw new Error("Codex did not return a thread id");
    return id;
}
/** The fork's thread id when it holds exactly `keep` turns; a wrong fork is archived and rejected. */
async function forked(client: CodexRewindClient, response: unknown, keep: number): Promise<string> {
    const id = threadId(response), length = (await listCodexTurns(client, id)).length;
    if (length === keep) return id;
    await client.request("thread/archive", { threadId: id }).catch(() => undefined);
    throw new ForkLengthError(`Codex fork kept ${length} turns instead of ${keep}`);
}
