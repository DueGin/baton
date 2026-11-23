import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchFilesResponse } from "@baton/protocol";
import { DemoClient } from "../demo/client.js";
import { detectSuggestion, fileInsertion, rankCommands, SuggestionSession } from "./composer-suggest.js";

describe("composer suggestion matching", () => {
  it("detects slash only as the first character of the whole message", () => {
    expect(detectSuggestion("/Sk", true)).toEqual({ kind: "command", from: 0, to: 3, query: "Sk" });
    for (const [prefix, first] of [["/re", false], ["\n/re", true], [" /re", true], ["/re ", true], ["x /re", true]] as const) {
      expect(detectSuggestion(prefix, first)).toBeNull();
    }
  });

  it("detects file completion only at line start or after whitespace", () => {
    expect(detectSuggestion("前文\n@src/", false)).toEqual({ kind: "file", from: 3, to: 8, query: "src/" });
    expect(detectSuggestion("请读\t@", true)?.query).toBe("");
    expect(detectSuggestion("name@example.org", true)).toBeNull();
    expect(detectSuggestion("@src a", true)).toBeNull();
  });

  it("keeps completing inside an open quoted directory, not a finished mention", () => {
    const directory = fileInsertion({ path: "docs/设计 草稿/", kind: "dir" });
    expect(directory).toBe('@"docs/设计 草稿/');
    expect(detectSuggestion(directory, true)?.query).toBe("docs/设计 草稿/");
    const file = fileInsertion({ path: "docs/设计 草稿/索引.md", kind: "file" });
    expect(file).toBe('@"docs/设计 草稿/索引.md" ');
    expect(detectSuggestion(file, true)).toBeNull();
  });

  it("ranks case-insensitive name prefixes before name and description substrings", () => {
    const commands = [{ name: "init", description: "Prepare REpo" }, { name: "skill:review" }, { name: "Review" }, { name: "reset" }, { name: "compact" }];
    expect(rankCommands(commands, "rE").map(command => command.name)).toEqual(["Review", "reset", "skill:review", "init"]);
    expect(rankCommands(commands, "")).toEqual(commands);
    expect(rankCommands(commands, "missing")).toEqual([]);
    expect(rankCommands(Array.from({ length: 75 }, (_, index) => ({ name: `review-${index}` })), "re")).toHaveLength(50);
  });
});

describe("composer suggestion queries", () => {
  afterEach(() => vi.useRealTimers());
  const now = Date.parse("2026-11-10T07:00:00Z");

  it("reuses a node's command list across opens and refreshes stale entries in the background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const client = new DemoClient(() => now);
    const commands = vi.spyOn(client, "commands").mockResolvedValueOnce({ source: "scan", commands: [{ name: "review" }] })
      .mockResolvedValueOnce({ source: "session", commands: [{ name: "recheck" }] });
    const source = { client, cwd: "/workspace/atlas", commandQuery: { nodeId: "cache-test" } };
    const first = new SuggestionSession();
    first.update(detectSuggestion("/", true), source);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.snapshot()?.options[0]?.value).toBe("/review ");
    first.close();

    const second = new SuggestionSession();
    second.update(detectSuggestion("/re", true), source);
    expect(second.snapshot()?.options[0]?.value).toBe("/review ");
    expect(commands).toHaveBeenCalledTimes(1);
    second.close();

    vi.setSystemTime(now + 60_001);
    second.update(detectSuggestion("/re", true), source);
    expect(second.snapshot()?.options[0]?.value).toBe("/review ");
    await vi.advanceTimersByTimeAsync(0);
    expect(commands).toHaveBeenCalledTimes(2);
    expect(second.snapshot()?.options[0]?.value).toBe("/recheck ");
  });

  it("ignores stale file results and silently dismisses a failed query", async () => {
    vi.useFakeTimers();
    const client = new DemoClient(() => now);
    const cwd = "/workspace/atlas";
    let resolveSlow: (result: SearchFilesResponse) => void = () => {};
    const slow = new Promise<SearchFilesResponse>(resolve => { resolveSlow = resolve; });
    const search = vi.spyOn(client, "searchFiles").mockReturnValueOnce(slow)
      .mockResolvedValueOnce({ cwd, files: [{ path: "src/app.ts", kind: "file" }], truncated: false })
      .mockRejectedValueOnce(new Error("offline"));
    const session = new SuggestionSession();
    const source = { client, cwd, commandQuery: null };
    session.update(detectSuggestion("@s", true), source);
    await vi.advanceTimersByTimeAsync(120);
    session.update(detectSuggestion("@src", true), source);
    await vi.advanceTimersByTimeAsync(120);
    resolveSlow({ cwd, files: [{ path: "tests/", kind: "dir" }], truncated: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.snapshot()?.options[0]?.value).toBe("@src/app.ts ");
    const failing = detectSuggestion("@missing", true);
    session.update(failing, source);
    await vi.advanceTimersByTimeAsync(120);
    expect(session.snapshot()).toBeNull();
    session.update(failing, source);
    await vi.advanceTimersByTimeAsync(120);
    expect(search).toHaveBeenCalledTimes(3);
  });
});
