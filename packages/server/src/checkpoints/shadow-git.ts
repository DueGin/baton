/**
 * File checkpoints in baton's own shadow git repositories (DESIGN §4.13).
 *
 * Every snapshot runs `git --git-dir=<BATON_HOME/checkpoints/<hash>.git> --work-tree=<cwd> add -A` and
 * commits the resulting tree, so it captures what any agent or shell command did to the cwd. The
 * project's own `.git` is never read or written (git skips `.git` paths, and the shadow repository
 * lives outside the cwd); the project's `.gitignore` files apply because they are in the work tree,
 * and its `.git/info/exclude` is copied into the shadow repository's exclude file. Nodes that share a
 * cwd share one shadow repository; operations on it are serialized.
 *
 * Limits: a cwd with more than `maxFiles` non-ignored files, or more than `maxSnapshotBytes` of new
 * content to hash, is not snapshotted (the checkpoint has no `files`). Single files larger than
 * `maxFileBytes` and nested git repositories are left out of snapshots, so a rollback never touches them.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ShadowGitOptions {
  /** Directory holding the shadow repositories (BATON_HOME/checkpoints). */
  root: string;
  /** Absolute paths never snapshotted when they lie inside a cwd (BATON_HOME itself). */
  exclude?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxSnapshotBytes?: number;
  timeoutMs?: number;
  /** git executable (default "git" on PATH). */
  git?: string;
}
export type FileChangeStatus = "added" | "modified" | "deleted";
export interface FileChange { path: string; status: FileChangeStatus }
export type SnapshotResult = { ref: string } | { skipped: string };

const DEFAULTS = { maxFiles: 20_000, maxFileBytes: 16 * 1024 * 1024, maxSnapshotBytes: 512 * 1024 * 1024, timeoutMs: 30_000 };
const HEAD = "refs/baton/head";
const GITLINK = "160000";
class GitError extends Error { constructor(message: string, readonly code: number | null) { super(message); } }
/** Too large, timed out or unreadable: the checkpoint simply has no files. */
export class SnapshotSkipped extends Error {}

/** git exclude pattern matching exactly one path relative to the work tree root. */
export function literalExclude(path: string): string {
  return `/${path.replace(/[\\*?[\]]/g, (c) => `\\${c}`).replace(/ $/, "\\ ")}`;
}

export class ShadowGit {
  private readonly options: Required<Omit<ShadowGitOptions, "exclude">> & { exclude: string[] };
  private queues = new Map<string, Promise<unknown>>();
  private heads = new Map<string, { commit: string; tree: string }>();
  private available?: Promise<boolean>;
  constructor(options: ShadowGitOptions) {
    this.options = { ...DEFAULTS, git: "git", ...options, exclude: (options.exclude ?? []).map((path) => resolve(path)) };
  }
  /** True when git can be run. Cached. */
  gitAvailable(): Promise<boolean> {
    this.available ??= this.git(["--version"], { gitDir: null }).then(() => true, () => false);
    return this.available;
  }
  /** Commit the cwd's current state; unchanged trees reuse the previous ref. Never rejects. */
  async snapshot(cwd: string): Promise<SnapshotResult> {
    try {
      if (!await this.gitAvailable()) return { skipped: "git is not available" };
      const work = await realpath(cwd);
      return await this.serialize(work, async (gitDir) => {
        await this.stage(work, gitDir);
        const tree = (await this.git(["write-tree"], { gitDir, work })).trim();
        const head = this.heads.get(gitDir) ?? await this.readHead(gitDir, work);
        if (head?.tree === tree) return { ref: head.commit };
        const commit = (await this.git(["commit-tree", tree, ...(head ? ["-p", head.commit] : []), "-m", "baton checkpoint"], { gitDir, work })).trim();
        await this.git(["update-ref", HEAD, commit], { gitDir, work });
        this.heads.set(gitDir, { commit, tree });
        return { ref: commit };
      });
    } catch (error) {
      return { skipped: error instanceof Error ? error.message : String(error) };
    }
  }
  /** What restoring `ref` would undo: files added, modified or deleted since the snapshot. */
  async changes(cwd: string, ref: string): Promise<FileChange[]> {
    const work = await realpath(cwd);
    return this.serialize(work, (gitDir) => this.diff(work, gitDir, ref));
  }
  /** Restore the cwd to `ref`: added files are deleted, deleted ones come back, modified ones revert. */
  async restore(cwd: string, ref: string): Promise<FileChange[]> {
    const work = await realpath(cwd);
    return this.serialize(work, async (gitDir) => {
      const changes = await this.diff(work, gitDir, ref);
      const added = changes.filter((change) => change.status === "added").map((change) => change.path);
      for (const path of added) await removeFile(work, path);
      await pruneEmptyDirs(work, added);
      const restored = changes.filter((change) => change.status !== "added").map((change) => change.path);
      for (let index = 0; index < restored.length; index += 200) await this.git(["checkout", ref, "--", ...restored.slice(index, index + 200)], { gitDir, work, literal: true });
      return changes;
    });
  }
  /** Shadow repository for a (real) cwd path. */
  repoFor(work: string): string { return join(this.options.root, `${createHash("sha256").update(work).digest("hex").slice(0, 24)}.git`); }

  private async serialize<T>(work: string, task: (gitDir: string) => Promise<T>): Promise<T> {
    const gitDir = this.repoFor(work);
    const previous = this.queues.get(gitDir) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => { await this.ensureRepo(gitDir, work); return task(gitDir); });
    const settled = next.catch(() => {});
    this.queues.set(gitDir, settled);
    try { return await next; } finally { if (this.queues.get(gitDir) === settled) this.queues.delete(gitDir); }
  }
  private async ensureRepo(gitDir: string, work: string): Promise<void> {
    try { await lstat(join(gitDir, "HEAD")); return; } catch { /* first use */ }
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    await this.git(["init", "-q"], { gitDir, work });
    await writeFile(join(gitDir, "baton-cwd"), `${work}\n`);
    // Store bytes exactly: no eol conversion, clean/smudge filters (LFS) or ident expansion from the
    // project's .gitattributes ($GIT_DIR/info/attributes has the highest precedence).
    await mkdir(join(gitDir, "info"), { recursive: true });
    await writeFile(join(gitDir, "info", "attributes"), "* -text -ident -filter -working-tree-encoding\n");
  }
  private async readHead(gitDir: string, work: string): Promise<{ commit: string; tree: string } | undefined> {
    const commit = await this.git(["rev-parse", "-q", "--verify", `${HEAD}^{commit}`], { gitDir, work }).then((out) => out.trim(), () => "");
    if (!commit) return undefined;
    const head = { commit, tree: (await this.git(["rev-parse", `${commit}^{tree}`], { gitDir, work })).trim() };
    this.heads.set(gitDir, head); return head;
  }
  /** Bring the shadow index in line with the work tree (same rules for snapshots and diffs). */
  private async stage(work: string, gitDir: string): Promise<void> {
    const excludes = await this.baseExcludes(work);
    await mkdir(join(gitDir, "info"), { recursive: true });
    await writeFile(join(gitDir, "info", "exclude"), excludes.join("\n") + "\n");
    // Tags: H cached, C changed (modified), R removed, ? untracked-not-ignored.
    const listed = await this.git(["ls-files", "-z", "-t", "-c", "-o", "-m", "--exclude-standard"], { gitDir, work, maxEntries: this.options.maxFiles * 2 + 10 });
    let files = 0; const candidates = new Set<string>();
    for (const entry of listed.split("\0")) {
      if (entry.length < 3) continue;
      const tag = entry[0], path = entry.slice(2);
      if (tag === "?") { files++; candidates.add(path); }
      else if (tag === "H") files++;
      else if (tag === "C") candidates.add(path);
    }
    if (files > this.options.maxFiles) throw new SnapshotSkipped(`more than ${this.options.maxFiles} files`);
    const large: string[] = []; let bytes = 0;
    for (const path of candidates) {
      const stats = await lstat(join(work, path)).catch(() => undefined);
      if (!stats?.isFile()) continue;
      if (stats.size > this.options.maxFileBytes) large.push(path);
      else bytes += stats.size;
    }
    if (bytes > this.options.maxSnapshotBytes) throw new SnapshotSkipped(`more than ${Math.round(this.options.maxSnapshotBytes / 1048576)} MB of changed content`);
    if (large.length) {
      await writeFile(join(gitDir, "info", "exclude"), [...excludes, ...large.map(literalExclude)].join("\n") + "\n");
      for (let index = 0; index < large.length; index += 200) await this.git(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...large.slice(index, index + 200)], { gitDir, work, literal: true });
    }
    // Unreadable files are skipped (exit code 1 with --ignore-errors); everything else is staged.
    await this.git(["add", "-A", "--ignore-errors", "--", "."], { gitDir, work, okCodes: [0, 1] });
  }
  private async baseExcludes(work: string): Promise<string[]> {
    const lines = ["# baton shadow checkpoint excludes (regenerated)"];
    // The project's own .git/info/exclude (read only; never written).
    const project = await this.git(["rev-parse", "--git-path", "info/exclude"], { gitDir: null, cwd: work }).then((out) => out.trim(), () => "");
    if (project) {
      const content = await readFile(isAbsolute(project) ? project : join(work, project), "utf8").catch(() => "");
      if (content) lines.push(...content.split(/\r?\n/));
    }
    for (const path of [...this.options.exclude, this.options.root]) {
      const inside = relative(work, await realpath(path).catch(() => path));
      if (inside && !inside.startsWith("..") && !isAbsolute(inside)) lines.push(literalExclude(inside.split(sep).join("/")));
    }
    return lines;
  }
  private async diff(work: string, gitDir: string, ref: string): Promise<FileChange[]> {
    await this.git(["cat-file", "-e", `${ref}^{commit}`], { gitDir, work }).catch(() => { throw new Error("Checkpoint snapshot is missing from the shadow repository"); });
    await this.stage(work, gitDir);
    const raw = await this.git(["diff-index", "--cached", "--raw", "-z", "--no-renames", ref], { gitDir, work });
    const parts = raw.split("\0"), changes: FileChange[] = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const meta = parts[index]!.replace(/^:/, "").split(" "), path = parts[index + 1]!;
      const [oldMode, newMode, , , status] = meta;
      if (!status || oldMode === GITLINK || newMode === GITLINK) continue;
      if (status.startsWith("A")) changes.push({ path, status: "added" });
      else if (status.startsWith("D")) changes.push({ path, status: await lstat(join(work, path)).then(() => "modified" as const, () => "deleted" as const) });
      else changes.push({ path, status: "modified" });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }
  private git(args: string[], options: { gitDir: string | null; work?: string; cwd?: string; literal?: boolean; okCodes?: number[]; maxEntries?: number }): Promise<string> {
    const config = ["-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.quotepath=false", "-c", "gc.auto=0", "-c", "commit.gpgsign=false", "-c", "advice.addEmbeddedRepo=false", "-c", `core.hooksPath=${join(this.options.root, "no-hooks")}`, "-c", "maintenance.auto=false"];
    const location = options.gitDir ? [`--git-dir=${options.gitDir}`, `--work-tree=${options.work}`] : [];
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "baton", GIT_AUTHOR_EMAIL: "baton@localhost", GIT_COMMITTER_NAME: "baton", GIT_COMMITTER_EMAIL: "baton@localhost", LC_ALL: "C" };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_PREFIX"]) delete env[key];
    const full = [...config, ...location, ...(options.literal ? ["--literal-pathspecs"] : []), ...args];
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.options.git, full, { cwd: options.cwd ?? options.work ?? tmpdir(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const out: Buffer[] = [], err: Buffer[] = []; let entries = 0, done = false;
      const finish = (error?: Error): void => { if (done) return; done = true; clearTimeout(timer); if (error) { child.kill("SIGKILL"); reject(error); } };
      const timer = setTimeout(() => finish(new SnapshotSkipped(`git ${args[0]} timed out`)), this.options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        out.push(chunk);
        if (options.maxEntries) { for (const byte of chunk) if (byte === 0) entries++; if (entries > options.maxEntries) finish(new SnapshotSkipped(`more than ${this.options.maxFiles} files`)); }
      });
      child.stderr.on("data", (chunk: Buffer) => { if (err.length < 64) err.push(chunk); });
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (done) return; done = true; clearTimeout(timer);
        if ((options.okCodes ?? [0]).includes(code ?? -1)) resolvePromise(Buffer.concat(out).toString("utf8"));
        else reject(new GitError(`git ${args[0]} failed: ${Buffer.concat(err).toString("utf8").trim().slice(0, 500) || `exit ${code}`}`, code));
      });
    });
  }
}
async function removeFile(work: string, path: string): Promise<void> {
  const target = join(work, path);
  if (!target.startsWith(work + sep)) return;
  const stats = await lstat(target).catch(() => undefined);
  if (stats && !stats.isDirectory()) await unlink(target).catch(() => {});
}
/** Remove directories left empty by deleting added files (deepest first, never the cwd itself). */
async function pruneEmptyDirs(work: string, paths: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const path of paths) for (let dir = dirname(join(work, path)); dir.startsWith(work + sep); dir = dirname(dir)) dirs.add(dir);
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    const entries = await readdir(dir).catch(() => undefined);
    if (entries && entries.length === 0) await rmdir(dir).catch(() => {});
  }
}
