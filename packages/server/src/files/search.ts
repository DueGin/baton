import { execFile } from "node:child_process";
import { opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { SearchFilesResponse } from "@baton/protocol";
import { AsyncCache } from "../cache.js";

type Entry = SearchFilesResponse["files"][number];
const indexes = new AsyncCache<Entry[]>(10_000, 8);
const run = promisify(execFile);

export async function searchFiles(cwd: string, query = "", limit = 50): Promise<SearchFilesResponse> {
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute directory path");
  const directory = await realpath(cwd).catch(() => undefined);
  if (!directory || !(await stat(directory).catch(() => undefined))?.isDirectory()) throw new Error("cwd must be an existing directory");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const maximum = Math.min(limit, 200);
  const entries = await indexes.get(directory, () => index(directory));
  const needle = query.toLowerCase(), split = needle.lastIndexOf("/") + 1;
  const prefix = needle.slice(0, split), term = needle.slice(split);
  const matches: { entry: Entry; rank: number }[] = [];
  for (const entry of entries) {
    const path = (entry.kind === "dir" ? entry.path.slice(0, -1) : entry.path).toLowerCase();
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(split), basename = relative.slice(relative.lastIndexOf("/") + 1);
    if (!relative || (!term && relative.includes("/"))) continue;
    const rank = basename.startsWith(term) ? 0 : basename.includes(term) ? 1 : relative.includes(term) ? 2 : -1;
    if (rank >= 0) matches.push({ entry, rank });
  }
  matches.sort((left, right) => left.rank - right.rank || left.entry.path.length - right.entry.path.length || left.entry.path.localeCompare(right.entry.path, "en"));
  return { cwd, files: matches.slice(0, maximum).map(match => match.entry), truncated: matches.length > maximum };
}

async function index(cwd: string): Promise<Entry[]> {
  try { return await gitEntries(cwd); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" ||
      (error.code === 128 && "stderr" in error && /^fatal: not a git repository \(or any (?:of the parent|parent)/.test(String(error.stderr))))) return walk(cwd);
    throw error;
  }
}

async function gitEntries(cwd: string): Promise<Entry[]> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"] as const) delete env[key];
  const { stdout } = await run("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "-t", "--stage", "--", "."], { cwd, env, timeout: 5_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true });
  const entries = new Map<string, Entry>();
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const raw = record.startsWith("? ") ? record.slice(2) : record.slice(record.indexOf("\t") + 1);
    const dir = raw.endsWith("/") || record.startsWith("H 160000 ") || record.startsWith("S 160000 ");
    const path = raw.replace(/\/$/, "");
    if (isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) continue;
    const name = dir ? path + "/" : path;
    entries.set(name, { path: name, kind: dir ? "dir" : "file" });
    for (let split = path.lastIndexOf("/"); split >= 0; split = path.lastIndexOf("/", split - 1)) {
      const parent = path.slice(0, split + 1);
      if (entries.has(parent)) break;
      entries.set(parent, { path: parent, kind: "dir" });
    }
  }
  return [...entries.values()];
}

async function walk(cwd: string): Promise<Entry[]> {
  const entries: Entry[] = [], dirs = [{ prefix: "", depth: 0 }];
  let visited = 0;
  for (let cursor = 0; cursor < dirs.length; cursor++) {
    const { prefix, depth } = dirs[cursor]!;
    const directory = resolve(cwd, prefix);
    if (await realpath(directory).catch(() => undefined) !== directory) continue;
    const handle = await opendir(directory).catch((error: unknown) => { if (!prefix) throw error; return undefined; });
    if (!handle) continue;
    for await (const entry of handle) {
      if (++visited > 20_000) return entries;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        entries.push({ path: path + "/", kind: "dir" });
        if (depth < 32) dirs.push({ prefix: path + "/", depth: depth + 1 });
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        entries.push({ path, kind: "file" });
      }
    }
  }
  return entries;
}
