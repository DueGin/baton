// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/claude/rewind.ts and claude/project-dir.ts (Paseo app 0.16 build) — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton: rewinds to a fork point recorded when a prompt is sent (the last main-chain assistant entry before it) instead of Paseo's per-message anchors; adds a transcript reader for resumed sessions.
import { forkSession as claudeForkSession, type SessionStore, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { access, appendFile, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The SDK surface rewind needs; injectable for tests. */
export interface ClaudeRewindSdk {
    forkSession(sessionId: string, options: { upToMessageId: string; transcriptPath: string }): Promise<{ sessionId: string }>;
}
// On its own, the SDK looks for the session under the daemon's CLAUDE_CONFIG_DIR, while a
// provider can point Claude Code at another one. Forking through a store rooted at the
// transcript's folder reads the session where Claude Code wrote it and writes the fork beside it.
export const realClaudeRewindSdk: ClaudeRewindSdk = {
    forkSession: (sessionId, options) => claudeForkSession(sessionId, { upToMessageId: options.upToMessageId, sessionStore: projectFolderSessionStore(dirname(options.transcriptPath)) }),
};
function projectFolderSessionStore(projectFolder: string): SessionStore {
    const transcriptPath = (sessionId: string): string => join(projectFolder, `${sessionId}.jsonl`);
    return {
        async load({ sessionId }) {
            let text: string;
            try { text = await readFile(transcriptPath(sessionId), "utf8"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
            return parseTranscriptEntries(text);
        },
        async append({ sessionId }, entries) {
            await appendFile(transcriptPath(sessionId), entries.map(entry => `${JSON.stringify(entry)}\n`).join(""), "utf8");
        },
    };
}
function parseTranscriptEntries(text: string): SessionStoreEntry[] {
    const entries: SessionStoreEntry[] = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let parsed: unknown;
        // Skip a line that is not JSON, as the SDK's own transcript reader does.
        try { parsed = JSON.parse(line); } catch { continue; }
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && typeof (parsed as { type?: unknown }).type === "string") entries.push(parsed as SessionStoreEntry);
    }
    return entries;
}
/**
 * The uuid of the transcript's last main-chain assistant entry: forking there keeps the conversation
 * up to (not including) the next prompt. Null when the transcript has none (nothing to keep); throws
 * when it cannot be read.
 */
export async function lastAssistantEntry(transcriptPath: string): Promise<string | null> {
    let last: string | null = null;
    for (const entry of parseTranscriptEntries(await readFile(transcriptPath, "utf8"))) {
        const record = entry as { type: string; uuid?: unknown; isSidechain?: unknown };
        if (record.type === "assistant" && record.isSidechain !== true && typeof record.uuid === "string") last = record.uuid;
    }
    return last;
}
/** Where to fork for "just before the next prompt": null = a fresh session (no earlier answer). */
export interface ClaudeRewindPoint { sessionId: string | null; forkAt: string | null }
export function parseClaudeRewindPoint(value: unknown): ClaudeRewindPoint {
    const point = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    const sessionId = point.sessionId ?? null, forkAt = point.forkAt ?? null;
    if ((sessionId !== null && typeof sessionId !== "string") || (forkAt !== null && typeof forkAt !== "string") || (forkAt !== null && sessionId === null)) throw new Error("Invalid Claude rewind point");
    return { sessionId, forkAt };
}
/** Fork the session up to the point; resolves with the session to continue in (null = start fresh). */
export async function revertClaudeConversation(input: { sdk: ClaudeRewindSdk; point: ClaudeRewindPoint; transcriptPath: (sessionId: string) => Promise<string> }): Promise<string | null> {
    const { sessionId, forkAt } = input.point;
    if (forkAt === null || sessionId === null) return null;
    const fork = await input.sdk.forkSession(sessionId, { upToMessageId: forkAt, transcriptPath: await input.transcriptPath(sessionId) });
    return fork.sessionId;
}

// Verbatim port of the Claude Agent SDK's project-directory encoding so baton computes the same
// `~/.claude/projects/<dir>` path the SDK does.
const PROJECT_DIR_LENGTH_CAP = 200;
/** Claude Code keeps its settings and transcripts here for a process launched with `env`. */
export function claudeConfigDir(env: Record<string, string | undefined>): string { return env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"); }
export async function claudeProjectDir(cwd: string, configDir: string): Promise<string> {
    return join(configDir, "projects", encode(await canonicalize(cwd)));
}
// Claude Code resumes a session by id from any working directory and keeps appending to the
// transcript in the project folder where the session started. Returns the expected path when no
// transcript exists anywhere.
export async function claudeTranscriptPath(input: { cwd: string; sessionId: string; configDir: string }): Promise<string> {
    const fileName = `${input.sessionId}.jsonl`;
    const expected = join(await claudeProjectDir(input.cwd, input.configDir), fileName);
    if (await exists(expected)) return expected;
    const projectsRoot = join(input.configDir, "projects");
    let projectDirs: string[];
    try { projectDirs = await readdir(projectsRoot); }
    catch { return expected; }
    for (const projectDir of projectDirs) {
        const candidate = join(projectsRoot, projectDir, fileName);
        if (await exists(candidate)) return candidate;
    }
    return expected;
}
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
async function canonicalize(input: string): Promise<string> {
    const path = await realpath(input).catch(() => input);
    return process.platform === "darwin" ? path.normalize("NFC") : path;
}
function encode(input: string): string {
    const replaced = input.replace(/[^a-zA-Z0-9]/g, "-");
    return replaced.length <= PROJECT_DIR_LENGTH_CAP ? replaced : `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${hashSuffix(input)}`;
}
function hashSuffix(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    return Math.abs(hash).toString(36);
}
