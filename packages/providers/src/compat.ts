// Ported from Paseo (https://github.com/getpaseo/paseo) packages/protocol/src/path-utils.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
export function stripCwdPrefix(filePath: string, cwd?: string | null): string {
    if (!cwd || !filePath)
        return filePath;
    const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedPath = filePath.replace(/\\/g, "/");
    const prefix = `${normalizedCwd}/`;
    if (normalizedPath.startsWith(prefix))
        return normalizedPath.slice(prefix.length);
    if (normalizedPath === normalizedCwd)
        return ".";
    return filePath;
}
// Voice is deliberately absent from baton.
export function isSpeakToolName(_name: string): boolean { return false; }
