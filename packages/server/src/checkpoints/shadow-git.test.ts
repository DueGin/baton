import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowGit, literalExclude } from "./shadow-git.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(options: Partial<ConstructorParameters<typeof ShadowGit>[0]> = {}) {
  const base = await mkdtemp(join(tmpdir(), "baton-shadow-")); dirs.push(base);
  const cwd = join(base, "project"), root = join(base, "home", "checkpoints");
  await mkdir(cwd, { recursive: true });
  return { cwd, root, base, git: new ShadowGit({ root, ...options }) };
}
const ref = (result: Awaited<ReturnType<ShadowGit["snapshot"]>>): string => { if (!("ref" in result)) throw new Error(`snapshot skipped: ${result.skipped}`); return result.ref; };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

describe("shadow git checkpoints", () => {
  it("restores added, modified and deleted files", async () => {
    const { cwd, git: shadow } = await setup();
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n");
    await writeFile(join(cwd, "edit.txt"), "before\n");
    await writeFile(join(cwd, "gone.txt"), "still here\n");
    const snapshot = ref(await shadow.snapshot(cwd));
    await writeFile(join(cwd, "edit.txt"), "after\n");
    await rm(join(cwd, "gone.txt"));
    await mkdir(join(cwd, "new", "deep"), { recursive: true });
    await writeFile(join(cwd, "new", "deep", "file.ts"), "new\n");
    await writeFile(join(cwd, "added.txt"), "added\n");
    expect(await shadow.changes(cwd, snapshot)).toEqual([
      { path: "added.txt", status: "added" },
      { path: "edit.txt", status: "modified" },
      { path: "gone.txt", status: "deleted" },
      { path: "new/deep/file.ts", status: "added" },
    ]);
    const restored = await shadow.restore(cwd, snapshot);
    expect(restored.map((change) => change.path)).toEqual(["added.txt", "edit.txt", "gone.txt", "new/deep/file.ts"]);
    expect(await readFile(join(cwd, "edit.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(cwd, "gone.txt"), "utf8")).toBe("still here\n");
    expect(existsSync(join(cwd, "added.txt"))).toBe(false);
    expect(existsSync(join(cwd, "new"))).toBe(false);
    expect(await readFile(join(cwd, "src", "keep.ts"), "utf8")).toBe("export const keep = 1;\n");
    expect(await shadow.changes(cwd, snapshot)).toEqual([]);
  });

  it("reuses the previous ref when nothing changed and chains new snapshots", async () => {
    const { cwd, git: shadow } = await setup();
    await writeFile(join(cwd, "a.txt"), "1");
    const first = ref(await shadow.snapshot(cwd));
    expect(ref(await shadow.snapshot(cwd))).toBe(first);
    // A fresh instance reads the head back from the shadow repository.
    expect(ref(await new ShadowGit({ root: (shadow as unknown as { options: { root: string } }).options.root }).snapshot(cwd))).toBe(first);
    await writeFile(join(cwd, "a.txt"), "2");
    const second = ref(await shadow.snapshot(cwd));
    expect(second).not.toBe(first);
    await shadow.restore(cwd, first);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("1");
    await shadow.restore(cwd, second);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("2");
  });

  it("respects .gitignore and the project's info/exclude, and never touches the project's .git", async () => {
    const { cwd, root, git: shadow } = await setup();
    git(cwd, "init", "-q");
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n*.log\n");
    await writeFile(join(cwd, ".git", "info", "exclude"), "local-only/\n");
    await writeFile(join(cwd, "tracked.txt"), "v1\n");
    git(cwd, "add", "-A"); git(cwd, "commit", "-qm", "init");
    const projectHead = git(cwd, "rev-parse", "HEAD"), projectIndex = await stat(join(cwd, ".git", "index"));
    const gitEntries = (await readdir(join(cwd, ".git"))).sort();
    const snapshot = ref(await shadow.snapshot(cwd));
    await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "pkg", "index.js"), "ignored\n");
    await writeFile(join(cwd, "debug.log"), "ignored\n");
    await mkdir(join(cwd, "local-only"));
    await writeFile(join(cwd, "local-only", "notes.md"), "excluded\n");
    await writeFile(join(cwd, "tracked.txt"), "v2\n");
    expect(await shadow.changes(cwd, snapshot)).toEqual([{ path: "tracked.txt", status: "modified" }]);
    await shadow.restore(cwd, snapshot);
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("v1\n");
    // Ignored paths are left alone.
    expect(await readFile(join(cwd, "node_modules", "pkg", "index.js"), "utf8")).toBe("ignored\n");
    expect(await readFile(join(cwd, "debug.log"), "utf8")).toBe("ignored\n");
    expect(await readFile(join(cwd, "local-only", "notes.md"), "utf8")).toBe("excluded\n");
    // The project's repository is untouched: same HEAD, same index file, no new entries, and the
    // restored file shows up as an ordinary working-tree modification there.
    expect(git(cwd, "rev-parse", "HEAD")).toBe(projectHead);
    expect((await stat(join(cwd, ".git", "index"))).mtimeMs).toBe(projectIndex.mtimeMs);
    expect((await readdir(join(cwd, ".git"))).sort()).toEqual(gitEntries);
    expect(git(cwd, "status", "--porcelain")).toBe("");
    // Shadow data lives under the checkpoints root only.
    expect((await readdir(root)).some((name) => name.endsWith(".git"))).toBe(true);
  });

  it("applies a parent repository's ignore rules to a subdirectory cwd", async () => {
    const { base, git: shadow } = await setup();
    const repo = join(base, "mono"), cwd = join(repo, "packages", "web");
    await mkdir(join(cwd, "node_modules", "dep"), { recursive: true });
    git(repo, "init", "-q");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n*.tmp\n");
    await writeFile(join(cwd, "index.ts"), "v1");
    await writeFile(join(cwd, "node_modules", "dep", "x.js"), "dep");
    const snapshot = ref(await shadow.snapshot(cwd));
    await writeFile(join(cwd, "scratch.tmp"), "ignored");
    await writeFile(join(cwd, "node_modules", "dep", "y.js"), "dep");
    await writeFile(join(cwd, "index.ts"), "v2");
    expect(await shadow.changes(cwd, snapshot)).toEqual([{ path: "index.ts", status: "modified" }]);
    await shadow.restore(cwd, snapshot);
    expect(existsSync(join(cwd, "scratch.tmp"))).toBe(true);
    expect(existsSync(join(cwd, "node_modules", "dep", "y.js"))).toBe(true);
    expect(await readFile(join(cwd, "index.ts"), "utf8")).toBe("v1");
    expect(git(repo, "status", "--porcelain")).toBe("?? .gitignore\n?? packages/\n");
  });

  it("leaves oversized files and the baton home out of snapshots", async () => {
    const { cwd, git: shadow } = await setup({ maxFileBytes: 1024 });
    const home = join(cwd, ".baton-home");
    const withHome = new ShadowGit({ root: join(home, "checkpoints"), maxFileBytes: 1024, exclude: [home] });
    await writeFile(join(cwd, "small.txt"), "small");
    const snapshot = ref(await withHome.snapshot(cwd));
    await writeFile(join(cwd, "big.bin"), Buffer.alloc(4096, 1));
    await writeFile(join(cwd, "small.txt"), "changed");
    const changes = await withHome.changes(cwd, snapshot);
    expect(changes).toEqual([{ path: "small.txt", status: "modified" }]);
    await withHome.restore(cwd, snapshot);
    expect((await stat(join(cwd, "big.bin"))).size).toBe(4096);
    expect(existsSync(join(home, "checkpoints"))).toBe(true);
    void shadow;
  });

  it("skips cwds with too many files", async () => {
    const { cwd, git: shadow } = await setup({ maxFiles: 3 });
    for (const name of ["a", "b", "c", "d", "e"]) await writeFile(join(cwd, name), name);
    const result = await shadow.snapshot(cwd);
    expect(result).toMatchObject({ skipped: expect.stringContaining("more than 3 files") });
  });

  it("reports a skipped snapshot when git is unavailable", async () => {
    const { cwd } = await setup();
    const shadow = new ShadowGit({ root: join(cwd, "..", "cp"), git: join(cwd, "no-such-git") });
    expect(await shadow.snapshot(cwd)).toEqual({ skipped: "git is not available" });
  });

  it("escapes exclude patterns literally", () => {
    expect(literalExclude("a b/[x]*.txt")).toBe("/a b/\\[x\\]\\*.txt");
    expect(literalExclude("!important#")).toBe("/!important#");
  });
});
