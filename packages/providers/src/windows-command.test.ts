import { describe, expect, it } from "vitest";
import { quoteWindowsArgument, processLaunch } from "./windows-command.js";
import { executableCandidates, findExecutable } from "./executable-resolution.js";
import { versionProbeCommand } from "./registry.js";

describe("Windows provider executable resolution", () => {
  it("honors case-insensitive PATH/PATHEXT names and extension order", async () => {
    const env = { Path: '"C:\\Program Files\\Agents";C:\\Tools', PathExt: ".EXE;.CMD;.BAT" };
    expect(executableCandidates("claude", env, "win32")).toEqual([
      "C:\\Program Files\\Agents\\claude", "C:\\Program Files\\Agents\\claude.EXE", "C:\\Program Files\\Agents\\claude.CMD", "C:\\Program Files\\Agents\\claude.BAT",
      "C:\\Tools\\claude", "C:\\Tools\\claude.EXE", "C:\\Tools\\claude.CMD", "C:\\Tools\\claude.BAT",
    ]);
    expect(await findExecutable("claude", env, { platform: "win32", exists: async (file) => file.toLowerCase() === "c:\\tools\\claude.cmd" })).toBe("C:\\Tools\\claude.CMD");
  });
  it("expands literal paths and preserves POSIX behavior", () => {
    expect(executableCandidates("C:\\Tools\\pi", { PATHEXT: ".CMD;.EXE" }, "win32")).toEqual(["C:\\Tools\\pi", "C:\\Tools\\pi.CMD", "C:\\Tools\\pi.EXE"]);
    expect(executableCandidates("C:\\Tools\\pi.cmd", { PATHEXT: ".EXE" }, "win32")).toEqual(["C:\\Tools\\pi.cmd"]);
    expect(executableCandidates("codex", { PATH: "/one:/two", PATHEXT: ".CMD" }, "darwin")).toEqual(["/one/codex", "/two/codex"]);
  });
});

describe("cmd launch quoting", () => {
  it.each([
    ["", '""'], ["--version", "--version"], ["feature&fix|test", "feature^&fix^|test"],
    ["100%", "100%"], ["--format=%(refname)%09", "--format=%^(refname^)%09"],
    ["C:\\Program Files\\Tool\\", '"C:\\Program Files\\Tool\\\\"'],
    ['"already quoted"', '"already quoted"'],
  ])("quotes %s", (input, expected) => expect(quoteWindowsArgument(input)).toBe(expected));
  it.each(["claude", "codex", "pi", "generic-acp"])("routes %s.cmd through cmd.exe without shell interpolation", (name) => {
    const command = `C:\\Program Files\\Agents\\${name}.cmd`, json = '{"mcpServers":{"baton":{"url":"http://127.0.0.1:7433/mcp"}}}';
    const launch = processLaunch(command, ["--mcp-config", json, "space separated", "& echo bad", ""], { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32");
    expect(launch.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]); expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args[3]).toBe(`"${quoteWindowsArgument(command)} --mcp-config ${quoteWindowsArgument(json)} "space separated" "^& echo bad" """`);
    expect(launch.args[3]).toContain('\\"mcpServers\\"');
  });
  it("leaves native binaries and non-Windows launches as argv", () => {
    expect(processLaunch("C:\\Tools\\claude.exe", ["a&b"], {}, "win32")).toEqual({ command: "C:\\Tools\\claude.exe", args: ["a&b"] });
    expect(processLaunch("/tmp/pi.cmd", ["a&b"], {}, "darwin")).toEqual({ command: "/tmp/pi.cmd", args: ["a&b"] });
    expect(processLaunch("tool.BAT", [], {}, "win32").command).toBe("cmd.exe");
    expect(versionProbeCommand(["C:\\Tools\\npx.cmd", "-y", "agent", "acp"])).toEqual(["C:\\Tools\\npx.cmd", "-y", "agent", "--version"]);
  });
});
