import { describe, expect, it } from "vitest";
import { DemoClient } from "../demo/client.js";
import { composerHeight, readRunPanel, reduceRunPanel, runDetailsStorageKey, runMetrics, saveRunPanel, visibleRunPanel } from "./run-layout.js";

describe("Run details panel preference and navigation", () => {
  it("defaults closed, persists the toggle and restores it after reload", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    let state = readRunPanel(storage);
    expect(visibleRunPanel(state)).toBeNull();
    state = reduceRunPanel(state, { type: "toggle_details" }); saveRunPanel(storage, state.detailsOpen);
    expect(values.get(runDetailsStorageKey)).toBe("true");
    expect(visibleRunPanel(readRunPanel(storage))).toBe("details");
    state = reduceRunPanel(state, { type: "toggle_details" }); saveRunPanel(storage, state.detailsOpen);
    expect(visibleRunPanel(readRunPanel(storage))).toBeNull();
  });
  it("shows only one panel and preserves the return to details while inspecting a node", () => {
    let state = { detailsOpen: true, nodeId: null as string | null };
    state = reduceRunPanel(state, { type: "inspect", nodeId: "child" });
    expect(visibleRunPanel(state)).toBe("inspector"); expect(state.detailsOpen).toBe(true);
    state = reduceRunPanel(state, { type: "back_to_details" });
    expect(visibleRunPanel(state)).toBe("details");
    state = reduceRunPanel(state, { type: "inspect", nodeId: "other" });
    state = reduceRunPanel(state, { type: "toggle_details" });
    expect(visibleRunPanel(state)).toBe("details"); expect(state.nodeId).toBeNull();
    expect(visibleRunPanel(reduceRunPanel(state, { type: "close" }))).toBeNull();
  });
  it("tolerates unavailable or malformed localStorage", () => {
    expect(readRunPanel({ getItem: () => { throw new Error("denied"); } })).toEqual({ detailsOpen: false, nodeId: null });
    expect(readRunPanel({ getItem: () => "yes" }).detailsOpen).toBe(false);
    expect(() => saveRunPanel({ setItem: () => { throw new Error("denied"); } }, true)).not.toThrow();
  });
});

describe("compact layout data", () => {
  it("counts all four pending kinds and live nodes without terminal or idle nodes", async () => {
    const client = new DemoClient(() => Date.parse("2026-11-10T07:00:00Z"));
    const run = await client.run("run-local-2"); const other = await client.run("run-demo"); const proposalRun = await client.run("run-local-1");
    const snapshot = { ...run, permissions: other.permissions, run: { ...run.run, team: proposalRun.run.team } };
    const metrics = runMetrics(snapshot);
    expect(metrics.pendingByKind).toEqual({ permission: 1, proposal: 1, question: 1, escalation: 2 });
    expect(metrics.pendingTotal).toBe(5);
    expect(metrics.activeNodes).toBe(snapshot.nodes.filter(node => ["running", "starting", "waiting_permission"].includes(node.status)).length);
    expect(metrics.totalNodes).toBe(snapshot.nodes.length);
    expect(metrics.tokens).toBe(snapshot.run.usage.inputTokens + snapshot.run.usage.outputTokens);
    const withReplaced = runMetrics({ ...run, nodes: run.nodes.map(node => ({ ...node, status: "replaced" })) });
    expect(withReplaced.activeNodes).toBe(0);
    expect(runMetrics({ ...snapshot, run: { ...snapshot.run, status: "paused" } }).activeNodes).toBe(0);
  });
  it("grows the composer from two to eight lines and scrolls overflow", () => {
    expect(composerHeight(0, 20)).toBe(40);
    expect(composerHeight(40, 20)).toBe(40);
    expect(composerHeight(100, 20)).toBe(100);
    expect(composerHeight(600, 20)).toBe(160);
    expect(composerHeight(1000, 20, 8)).toBe(168);
  });
});
