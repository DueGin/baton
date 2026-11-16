// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/executable-resolution/{executable-resolution,windows}.ts — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton: one resolver with injectable platform/probe, PATHEXT candidate enumeration and no version side effects.
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

export function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined { return Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]; }
export function executableCandidates(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const paths = platform === "win32" ? win32 : posix;
  const extensions = platform === "win32" && !paths.extname(name) ? ["", ...(envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => /^\.[a-z0-9]+$/i.test(e))] : [""];
  const bases = /[/\\]/.test(name) ? [name] : (envValue(env, "PATH") ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean).map((dir) => paths.join(dir.replace(/^"|"$/g, ""), name));
  return [...new Set(bases.flatMap((base) => extensions.map((extension) => base + extension)))];
}
export async function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, options: { platform?: NodeJS.Platform; exists?: (path: string) => Promise<boolean> } = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? (async (file: string) => { try { if (!(await stat(file)).isFile()) return false; await access(file, platform === "win32" ? constants.F_OK : constants.X_OK); return true; } catch { return false; } });
  for (const candidate of executableCandidates(name, env, platform)) if (await exists(candidate)) return candidate;
  return undefined;
}
