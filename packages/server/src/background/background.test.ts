import { describe, expect, it } from "vitest";
import type { ToolSpanRecord } from "@baton/protocol";
import { Attribution, foldProcesses, type ProcessSource } from "./attribution.js";
import { parseCwds, parsePorts, parsePs, processId, type ProcessInfo } from "./system.js";
const start = Date.parse("2026-11-15T12:00:00Z"), time = (seconds: number): string => new Date(start + seconds * 1000).toISOString();
const p = (pid: number, ppid: number, pgid = pid, command = "node server.js", seconds = 0): ProcessInfo => ({ pid, ppid, pgid, command, startedAt: time(seconds) });
const span = (id = "shell", seconds = 0, command = "node server.js", end: number | undefined = 2): ToolSpanRecord => ({ id, nodeId: "node", runId: "run", callId: id, name: "shell", kind: "shell", summary: command, status: end === undefined ? "running" : "completed", startedAt: time(seconds), ...(end === undefined ? {} : { endedAt: time(end) }) });
const source = (spans = [span()]): ProcessSource => ({ nodeId: "node", runId: "run", cwd: "/project", pids: [100], spans });

describe("process output parsers", () => {
  it("parses macOS/Linux lstart with padded days and command arguments", () => {
    const rows = parsePs("  100     1  100 Sun Nov 15 12:00:00 2026 /usr/bin/node server.js --flag a b\n101 100 101 Mon Nov  2 09:03:02 2026 sh -c sleep 600\n102 1 102 Sun Nov 15 12:00:00 2026 (node) <defunct>\ninvalid");
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ pid: 100, ppid: 1, pgid: 100, command: "/usr/bin/node server.js --flag a b" });
    expect(new Date(rows[1]!.startedAt).getFullYear()).toBe(2026); expect(processId(rows[0]!)).toMatch(/^100:\d+$/);
  });
  it("parses IPv4/IPv6 listeners, deduplicates ports, and reads cwd paths with spaces", () => {
    expect(parsePorts("p10\nn*:7433\nn127.0.0.1:7433\nn[::1]:9000\np11\nn*:80\n")).toEqual(new Map([[10, [7433, 9000]], [11, [80]]]));
    expect(parseCwds("p10\nfcwd\nn/tmp/project with spaces\np11\nfcwd\nn/another\n")).toEqual(new Map([[10, "/tmp/project with spaces"], [11, "/another"]]));
  });
});

describe("process attribution and folding", () => {
  it("attributes a descendant tree and folds the top ancestor with aggregate ports", () => {
    const classifier = new Attribution(), sources = [source()];
    const rows = [p(100, 1), p(110, 100, 110, "sh -c npm run dev"), p(111, 110, 110, "npm run dev"), p(112, 111, 110)];
    const found = classifier.attribute(rows, sources, new Map([[110, "/project"]]), new Map([[112, [3000]]]), start + 1000);
    expect(found).toHaveLength(3); expect(found.every((p) => p.owner.attribution === "tree")).toBe(true);
    const folded = foldProcesses(found, start + 1000);
    expect(folded).toHaveLength(1); expect(folded[0]).toMatchObject({ pid: 111, ports: [3000], children: [{ pid: 112, ports: [3000] }], attribution: "tree", toolSpanId: "shell" });
  });
  it("remembers a shell pgid after reparenting and classifies orphan workers", () => {
    const classifier = new Attribution(), sources = [source()];
    classifier.attribute([p(100, 1), p(110, 100, 110, "sh"), p(111, 110, 110)], sources, new Map(), new Map(), start + 1000);
    const found = classifier.attribute([p(100, 1), p(111, 1, 110)], sources, new Map(), new Map(), start + 10000);
    expect(found[0]?.owner.attribution).toBe("group"); expect(foldProcesses(found, start + 10000)[0]?.pid).toBe(111);
  });
  it("infers orphan ownership from the exact window and cwd, preferring executable then latest tool", () => {
    const other = { ...source([span("other", 1, "sleep 600", 2)]), nodeId: "other", pids: [200] };
    const cwd = new Map([[111, "/project/src"]]), orphan = p(111, 1, 110, "/usr/bin/node server.js", 1);
    expect(new Attribution().attribute([orphan], [source(), other], cwd, new Map(), start + 3000)[0]?.owner.source.nodeId).toBe("node");
    other.spans = [span("other", 1, "node server.js", 2)];
    expect(new Attribution().attribute([orphan], [source(), other], cwd, new Map(), start + 3000)[0]?.owner.source.nodeId).toBe("other");
    expect(new Attribution().attribute([orphan], [source()], new Map([[111, "/project-other"]]), new Map(), start + 3000)).toEqual([]);
    expect(new Attribution().attribute([p(111, 1, 110, "node", 6)], [source()], cwd, new Map(), start + 7000)).toEqual([]);
  });
  it("excludes agent/MCP infrastructure seen outside shell calls, including its future children", () => {
    const classifier = new Attribution(), sources = [source([])];
    const rows = [p(100, 1), p(105, 100, 100, "node mcp-server"), p(106, 105, 100, "language-server")];
    expect(classifier.attribute(rows, sources, new Map(), new Map([[105, [8000]]]), start)).toEqual([]);
    sources[0]!.spans = [span()];
    expect(classifier.attribute([...rows, p(107, 105, 100)], sources, new Map(), new Map([[107, [8001]]]), start + 1000)).toEqual([]);
  });
  it("waits five seconds after shell end for non-listeners and rejects pid reuse", () => {
    const classifier = new Attribution(), sources = [source()];
    const rows = [p(100, 1), p(110, 100, 110, "sh"), p(111, 110, 110, "sleep")];
    const found = classifier.attribute(rows, sources, new Map(), new Map(), start + 3000);
    expect(foldProcesses(found, start + 6000)).toEqual([]); expect(foldProcesses(found, start + 7000)).toHaveLength(1);
    expect(classifier.attribute([p(110, 1, 110, "unrelated", 50), p(111, 1, 110, "unrelated", 50)], sources, new Map(), new Map(), start + 51000)).toEqual([]);
  });
  it("attributes new workers spawned later by an already-known service", () => {
    const classifier = new Attribution(), sources = [source()];
    classifier.attribute([p(100, 1), p(110, 100, 110)], sources, new Map(), new Map([[110, [3000]]]), start + 3000);
    const found = classifier.attribute([p(100, 1), p(110, 100, 110), p(111, 110, 110, "node worker", 30)], sources, new Map(), new Map([[110, [3000]], [111, [3001]]]), start + 31000);
    expect(found.map((p) => p.pid)).toEqual([110, 111]); expect(foldProcesses(found, start + 31000)[0]?.ports).toEqual([3000, 3001]);
  });
  it("uses the listening service beneath a Claude tool shell and keeps its group after reparenting", () => {
    const classifier = new Attribution(), sources = [source([span("bash", 0, "nohup python3 -m http.server 8765", 2)])];
    const agent = p(100, 1, 100, "claude"), wrapper = p(62507, 100, 62507, "/bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-123 && eval 'nohup python3 -m http.server 8765 &'"), python = p(62508, 62507, 62507, "python3 -m http.server 8765");
    const ports = new Map([[python.pid, [8765]]]);
    const initial = classifier.attribute([agent, wrapper, python], sources, new Map(), ports, start + 1000);
    expect(foldProcesses(initial, start + 1000)).toMatchObject([{ pid: python.pid, attribution: "tree", ports: [8765], children: [] }]);
    expect(foldProcesses(initial.filter((p) => p.pid !== python.pid), start + 10000)).toEqual([]);
    const reparented = classifier.attribute([agent, { ...python, ppid: 1 }], sources, new Map(), ports, start + 10000);
    expect(foldProcesses(reparented, start + 10000)).toMatchObject([{ pid: python.pid, status: "running", attribution: "group", ports: [8765] }]);
  });
});
