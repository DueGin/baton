import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchFiles } from "./search.js";

let temp: string, cwd: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "baton-file-search-"));
  cwd = join(temp, "work"); await mkdir(cwd);
});
afterEach(async () => { vi.useRealTimers(); await rm(temp, { recursive: true, force: true }); });
async function file(path: string, data = "") {
  const abs = join(cwd, path); await mkdir(dirname(abs), { recursive: true }); await writeFile(abs, data);
}
const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

describe("file completion", () => {
  it("ranks basenames before path matches and limits results without listing ignored files", async () => {
    git("init", "-q");
    await file("src/Core.ts"); git("add", "src/Core.ts");
    await file(".gitignore", "*.ts\nignored/\n");
    for (const path of ["cob", "coa", "src/escape", "src/mycode", "src/components/a", "src/untracked.ts", "ignored/co"]) await file(path);
    expect((await searchFiles(cwd, "CO")).files.map(entry => entry.path)).toEqual(["coa", "cob", "src/Core.ts", "src/components/", "src/mycode", "src/components/a"]);
    expect(await searchFiles(cwd, "co", 2)).toMatchObject({ truncated: true, files: [{ path: "coa", kind: "file" }, { path: "cob", kind: "file" }] });
    expect(await searchFiles(cwd, "CO", 6)).toMatchObject({ truncated: false });
    expect((await searchFiles(cwd, "")).files.map(entry => entry.path)).toEqual(["coa", "cob", "src/", ".gitignore"]);
  });

  it("scopes nested prefixes and completes just the next level after selecting a directory", async () => {
    git("init", "-q");
    for (const path of ["src/core/index", "src/deep/col", "src/icons", "src/cow", "outside/col", "src/name with spaces"]) await file(path);
    expect((await searchFiles(cwd, "Src/")).files).toEqual([
      { path: "src/cow", kind: "file" }, { path: "src/core/", kind: "dir" }, { path: "src/deep/", kind: "dir" }, { path: "src/icons", kind: "file" }, { path: "src/name with spaces", kind: "file" },
    ]);
    const nested = await searchFiles(cwd, "src/co");
    expect(nested.files.map(entry => entry.path)).toEqual(["src/cow", "src/core/", "src/deep/col", "src/icons", "src/core/index"]);
    expect((await searchFiles(join(cwd, "src"), "col")).files).toEqual([{ path: "deep/col", kind: "file" }]);
    expect((await searchFiles(cwd, "../")).files).toEqual([]);
  });

  it("shares the file index across queries for 10s, independently of the result limit", async () => {
    git("init", "-q"); await file("a");
    vi.useFakeTimers({ toFake: ["Date"] });
    await searchFiles(cwd, "", 1); await file("b");
    expect((await searchFiles(cwd, "b")).files).toEqual([]);
    vi.setSystemTime(Date.now() + 10_001);
    expect((await searchFiles(cwd, "b")).files).toEqual([{ path: "b", kind: "file" }]);
  });

  it("walks non-repositories, preserves empty dirs and ignores dependency, .git and symlink subtrees", async () => {
    await mkdir(join(cwd, "empty"));
    for (const path of ["docs/readme", "node_modules/vendor/readme", ".git/readme", "../outside/readme"]) await file(path);
    await symlink(join(temp, "outside"), join(cwd, "link"), "junction");
    expect((await searchFiles(cwd, "readme")).files).toEqual([{ path: "docs/readme", kind: "file" }]);
    expect((await searchFiles(cwd, "link/")).files).toEqual([]);
    expect((await searchFiles(cwd, "")).files).toContainEqual({ path: "empty/", kind: "dir" });
  });

  it("validates cwd, defaults to 50 results and caps the limit at 200", async () => {
    await Promise.all(Array.from({ length: 201 }, (_, index) => file(`entry_${index}`)));
    for (const invalid of ["work", join(temp, "missing"), join(cwd, "entry_0")]) await expect(searchFiles(invalid, "")).rejects.toThrow(/directory/i);
    const normal = await searchFiles(cwd, ""); expect(normal.files).toHaveLength(50); expect(normal.truncated).toBe(true);
    const capped = await searchFiles(cwd, "", 201); expect(capped.files).toHaveLength(200); expect(capped.truncated).toBe(true);
  });
});
