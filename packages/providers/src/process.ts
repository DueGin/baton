// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/utils/spawn.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
export function externalEnv(...overlays: Array<Record<string, string | undefined> | undefined>): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // A child must not inherit the parent agent's session identity.
    for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION", "CODEX_THREAD_ID", "CODEX_TURN_ID"])
        delete env[key];
    for (const overlay of overlays)
        Object.assign(env, overlay);
    return env;
}
export function spawnProcess(command: string, args: string[], options: SpawnOptions & {
    envOverlay?: Record<string, string>;
}): ChildProcessWithoutNullStreams {
    const { envOverlay, ...rest } = options;
    return spawn(command, args, { ...rest, env: externalEnv(rest.env, envOverlay), stdio: ["pipe", "pipe", "pipe"], shell: false }) as ChildProcessWithoutNullStreams;
}
