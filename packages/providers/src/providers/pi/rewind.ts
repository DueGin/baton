// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/pi/rewind.ts (Paseo app 0.16 build) — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton: instead of Paseo's tree-navigation extension, uses Pi's RPC `fork` (a new session from before a user message), addressed by the session leaf recorded just before the prompt was sent.

/** Sends one Pi RPC command and resolves with its `data`. */
export type PiRequest = (command: { type: string; [key: string]: unknown }) => Promise<unknown>;
/** The session leaf just before a prompt: the prompt became a user entry whose parent is `leafId`. */
export interface PiRewindPoint { sessionFile: string; leafId: string | null }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
interface PiEntry { id: string; parentId: string | null; type: string; role?: string }
function entries(data: unknown): { entries: PiEntry[]; leafId: string | null } {
    const response = record(data);
    const list = (Array.isArray(response.entries) ? response.entries : []).map(record).flatMap((entry): PiEntry[] => text(entry.id) ? [{ id: text(entry.id), parentId: text(entry.parentId) || null, type: text(entry.type), role: text(record(entry.message).role) || undefined }] : []);
    return { entries: list, leafId: text(response.leafId) || null };
}
export function parsePiRewindPoint(value: unknown): PiRewindPoint {
    const point = record(value);
    if (!text(point.sessionFile) || (point.leafId !== null && typeof point.leafId !== "string")) throw new Error("Invalid Pi rewind point");
    return { sessionFile: text(point.sessionFile), leafId: point.leafId };
}
/**
 * The current leaf (cheap after the first call: `since` returns only new entries). Resolves with the
 * cursor to pass next time.
 */
export async function piLeaf(request: PiRequest, since: string | null): Promise<{ leafId: string | null; cursor: string | null }> {
    let data: unknown;
    try { data = await request(since ? { type: "get_entries", since } : { type: "get_entries" }); }
    catch (error) { if (!since) throw error; data = await request({ type: "get_entries" }); }
    const { entries: list, leafId } = entries(data);
    return { leafId, cursor: list.at(-1)?.id ?? since };
}
/**
 * Fork the session from just before the prompt recorded in `point` (Pi copies the branch up to the
 * prompt's parent into a new session file and switches to it). Resolves with the new session state.
 */
export async function revertPiConversation(request: PiRequest, point: PiRewindPoint, currentFile: string | undefined): Promise<{ sessionFile: string; sessionId: string }> {
    if (point.sessionFile !== currentFile && record(await request({ type: "switch_session", sessionPath: point.sessionFile })).cancelled === true) throw new Error("Pi refused to switch sessions");
    const { entries: list } = entries(await request({ type: "get_entries" }));
    const target = list.findLast(entry => entry.type === "message" && entry.role === "user" && entry.parentId === point.leafId);
    if (!target) throw new Error("Pi rewind target was not found in the session");
    if (record(await request({ type: "fork", entryId: target.id })).cancelled === true) throw new Error("Pi refused to fork the session");
    const state = record(await request({ type: "get_state" }));
    const sessionFile = text(state.sessionFile), sessionId = text(state.sessionId) || sessionFile;
    if (!sessionFile) throw new Error("Pi did not report the forked session");
    return { sessionFile, sessionId };
}
