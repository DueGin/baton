import type { BackgroundProcess } from "@baton/protocol";
import { describe, expect, it, vi } from "vitest";
import { dismissExitedHistory, exitTimeLabel, groupExitedProcesses } from "./background.js";

const record = (pid: number, command: string, nodeId: string, exitedAt?: string): BackgroundProcess => ({
  id: String(pid), pid, command, nodeId, exitedAt, runId: "run", ppid: 1, pgid: pid, ports: [], children: [],
  startedAt: "2026-11-21T10:00:00Z", lastSeenAt: "2026-11-21T10:00:00Z", status: "exited", attribution: "tree",
});

describe("exited background history", () => {
  it("groups only identical full commands from the same node, latest exit first", () => {
    const input = [record(1, "go test ./...", "backend", "2026-11-21T20:00:00+08:00"),
      record(2, "go test ./...", "lead", "2026-11-21T12:01:00Z"), record(3, "go test ./... -v", "backend"),
      record(4, "go test ./...", "backend", "2026-11-21T12:02:00Z")];
    expect(groupExitedProcesses(input).map(group => group.records.map(entry => entry.pid))).toEqual([[4, 1], [2], [3]]);
    expect(input.map(entry => entry.pid)).toEqual([1, 2, 3, 4]);
  });

  it("uses local calendar days across midnight and leaves missing timestamps unknown", () => {
    const now = new Date(2026, 0, 1, 0, 10).getTime();
    expect(exitTimeLabel(new Date(2026, 0, 1, 0, 1).toISOString(), now)).toBe("00:01");
    expect(exitTimeLabel(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe("12-31 23:59");
    expect(exitTimeLabel(undefined, now)).toBe("—");
  });

  it("dismisses each selected record sequentially, continuing past individual failures", async () => {
    let finish!: () => void;
    const dismissBackground = vi.fn(async (id: string) => {
      if (id === "1") await new Promise<void>(resolve => { finish = resolve; });
      if (id === "2") throw new Error("已过期");
    });
    const result = dismissExitedHistory(["1", "2", "3"], { dismissBackground });
    expect(dismissBackground.mock.calls).toEqual([["1", { dismissed: true }]]);
    finish();
    expect(await result).toEqual([{ id: "2", reason: "已过期" }]);
    expect(dismissBackground.mock.calls).toEqual(["1", "2", "3"].map(id => [id, { dismissed: true }]));
  });
});
