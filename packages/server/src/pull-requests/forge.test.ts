import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREATES_PR, executable, normalizeGithub, parsePullRequest, pullRequestUrls } from "./forge.js";

describe("pull request URLs and creation commands", () => {
  it.each([
    ["https://github.com/Owner/Repo/pull/42/files?x=1#discussion", { forge: "github", repo: "owner/repo", number: 42, url: "https://github.com/owner/repo/pull/42" }],
    ["https://gitlab.example/group/sub/repo/-/merge_requests/7/diffs", { forge: "gitlab", repo: "gitlab.example/group/sub/repo", number: 7, url: "https://gitlab.example/group/sub/repo/-/merge_requests/7" }],
    ["https://forge.example/team/repo/pulls/3", { forge: "other", repo: "forge.example/team/repo", number: 3, url: "https://forge.example/team/repo/pulls/3" }],
  ])("canonicalizes %s", (url, expected) => { expect(parsePullRequest(url as string)).toEqual(expected); });
  it.each(["https://github.com/a/b/issues/1", "file:///a/b/pull/1", "https://user:password@github.com/a/b/pull/1", "https://github.com/a/b/pull/0", "javascript:alert(1)"])("rejects %s", (url) => expect(parsePullRequest(url)).toBeUndefined());
  it("extracts and deduplicates markdown/plain URLs without punctuation", () => {
    expect(pullRequestUrls("Created [PR](https://github.com/a/b/pull/2). https://github.com/a/b/pull/2/files\n<https://gitlab.com/a/b/-/merge_requests/3>" )).toHaveLength(2);
  });
  it.each(["gh pr create --title test", "cd repo && /opt/homebrew/bin/gh pr new", "glab mr create", "hub pull-request -m title"])("recognizes %s", (command) => expect(CREATES_PR.test(command)).toBe(true));
  it("does not treat a view as creation", () => expect(CREATES_PR.test("gh pr view 42")).toBe(false));
});

describe("GitHub status normalization", () => {
  it.each([ ["OPEN", false, "open"], ["OPEN", true, "draft"], ["MERGED", false, "merged"], ["CLOSED", false, "closed"] ])("maps %s/draft=%s to %s", (state, isDraft, expected) => {
    expect(normalizeGithub({ state, isDraft }).state).toBe(expected);
  });
  it("normalizes mixed CheckRun / StatusContext rollups, caps failed checks and preserves metadata", () => {
    const p = normalizeGithub({ state: "OPEN", title: "Fix", headRefName: "fix", baseRefName: "main", author: { login: "author" }, mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED", additions: 3, deletions: 2, changedFiles: 1, comments: [{}, {}], updatedAt: "remote", statusCheckRollup: [
      { __typename: "CheckRun", name: "unit", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "external", state: "SUCCESS" },
      { __typename: "CheckRun", name: "queued", status: "QUEUED", conclusion: null },
      { __typename: "StatusContext", context: "waiting", state: "PENDING" },
      { __typename: "CheckRun", name: "skipped", conclusion: "SKIPPED" },
      ...Array.from({ length: 12 }, (_, i) => ({ name: `failed ${i}`, conclusion: "FAILURE", detailsUrl: `https://example/${i}` })),
    ] });
    expect(p).toMatchObject({ state: "open", title: "Fix", headRef: "fix", baseRef: "main", author: "author", mergeable: "conflicting", reviewDecision: "changes_requested", additions: 3, deletions: 2, changedFiles: 1, commentCount: 2, remoteUpdatedAt: "remote", checks: { state: "failure", total: 17, passed: 2, failed: 12, pending: 2 } });
    expect(p.checks?.failedChecks).toHaveLength(10);
    expect(normalizeGithub({ state: "OPEN", statusCheckRollup: [{ context: "external", state: "ERROR", targetUrl: "https://ci.example" }] }).checks?.failedChecks).toEqual([{ name: "external", url: "https://ci.example" }]);
  });
  it.each([
    [[], "none"], [[{ conclusion: "SUCCESS" }], "success"], [[{ conclusion: "NEUTRAL" }], "neutral"], [[{ conclusion: null, status: "IN_PROGRESS" }], "pending"], [[{ conclusion: "TIMED_OUT" }], "failure"],
  ])("aggregates rollup state", (statusCheckRollup, state) => expect(normalizeGithub({ state: "OPEN", statusCheckRollup }).checks?.state).toBe(state));
  it("rejects malformed status payloads", () => expect(() => normalizeGithub({ message: "not a PR" })).toThrow("missing PR state"));
});

it("resolves an explicit executable before PATH and ignores nonexecutables", async () => {
  const home = await mkdtemp(join(tmpdir(), "baton-gh-path-"));
  try {
    await mkdir(join(home, "bin")); const file = join(home, "bin", "gh"), configured = join(home, "my-gh");
    await writeFile(file, "fixture"); await chmod(file, 0o700); await writeFile(configured, "fixture"); await chmod(configured, 0o700);
    expect(await executable("gh", { PATH: join(home, "bin") })).toBe(file);
    expect(await executable("gh", { PATH: join(home, "bin") }, configured)).toBe(configured);
    expect(await executable("gh", { PATH: join(home, "bin") }, join(home, "missing"))).toBeUndefined();
  } finally { await rm(home, { recursive: true, force: true }); }
});
