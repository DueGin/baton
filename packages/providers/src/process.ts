// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/utils/spawn.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { processLaunch } from "./windows-command.js";
export function externalEnv(...overlays: Array<Record<string, string | undefined> | undefined>): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // A child must not inherit the parent agent's session identity.
    for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION", "CODEX_THREAD_ID", "CODEX_TURN_ID"])
        delete env[key];
    for (const overlay of overlays) {
        if (process.platform === "win32" && overlay) for (const key of Object.keys(overlay)) for (const previous of Object.keys(env)) if (key.toLowerCase() === previous.toLowerCase()) delete env[previous];
        Object.assign(env, overlay);
    }
    return env;
}
export function spawnProcess(command: string, args: string[], options: SpawnOptions & {
    envOverlay?: Record<string, string>;
}): ChildProcessWithoutNullStreams {
    const { envOverlay, ...rest } = options;
    const env = externalEnv(rest.env, envOverlay), launch = processLaunch(command, args, env);
    return spawn(launch.command, launch.args, { detached: process.platform !== "win32", ...rest, env, ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false }) as ChildProcessWithoutNullStreams;
}
