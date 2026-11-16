// Ported from Paseo (https://github.com/getpaseo/paseo) packages/plugin/src/server/process-internal/windows-command.ts — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton: injectable platform, explicit cmd.exe argv and empty-argument quoting.
import { win32 } from "node:path";

export function quoteWindowsArgument(value: string): string {
  const isQuoted = value.startsWith('"') && value.endsWith('"');
  const unquoted = isQuoted ? value.slice(1, -1) : value;
  // Keep percent signs literal, as in Paseo; /c does not collapse doubled percent signs.
  const escaped = unquoted.replace(/([&|^<>()!])/g, "^$1");
  if (!unquoted || isQuoted || /[\s"]/u.test(unquoted)) {
    return `"${escaped.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`).replace(/\\+$/u, (slashes) => `${slashes}${slashes}`)}"`;
  }
  return escaped;
}
export interface ProcessLaunch { command: string; args: string[]; windowsVerbatimArguments?: boolean }
export function processLaunch(command: string, args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): ProcessLaunch {
  if (platform !== "win32" || ![".cmd", ".bat"].includes(win32.extname(command).toLowerCase())) return { command, args };
  const comspec = Object.entries(env).find(([key]) => key.toLowerCase() === "comspec")?.[1] ?? "cmd.exe";
  const line = [quoteWindowsArgument(command), ...args.map(quoteWindowsArgument)].join(" ");
  return { command: comspec, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
