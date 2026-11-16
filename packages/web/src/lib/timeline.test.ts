import { describe, expect, it } from "vitest";
import { createScenario, replay } from "../demo/scenario.js";
import { displayRunStatus, displayStatus, summarize, treeOrder } from "./derive.js";
import { fitTime, niceTicks, panTime, timeX, waitingIntervals, xTime, zoomTime } from "./timeline.js";
import { graphEdges, graphPositions } from "../components/Topology.js";
import { DemoClient } from "../demo/client.js";

const base = Date.parse("2026-11-10T07:00:00Z");
const snapshot = replay(createScenario(base), base + 86000);

describe("timeline scale and layout", () => {
  it("maps time reversibly and zooms around the pointer", () => {
    const view = { start: base, end: base + 60000 };
    const anchor = xTime(300, view, 1000);
    expect(xTime(timeX(base + 13500, view, 1000), view, 1000)).toBe(base + 13500);
    const zoomed = zoomTime(view, 0.5, .3);
    expect(zoomed.end - zoomed.start).toBe(30000);
    expect(xTime(300, zoomed, 1000)).toBe(anchor);
    expect(panTime(view, 100, 1000)).toEqual({ start: base - 6000, end: base + 54000 });
    expect(zoomTime(view, 0, 0).end - zoomTime(view, 0, 0).start).toBe(1000);
  });
  it("returns readable ticks inside the visible range and fits lifetimes", () => {
    const view = fitTime(snapshot, base + 86000);
    expect(view.start).toBeLessThan(base);
    expect(view.end).toBeGreaterThan(base + 86000);
    const ticks = niceTicks(view, 1000);
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThanOrEqual(12);
    expect(ticks.every(tick => tick >= view.start && tick <= view.end)).toBe(true);
    expect(ticks[1]! - ticks[0]!).toBe(ticks[2]! - ticks[1]!);
  });
  it("merges overlapping child waits and derives waiting_children", () => {
    expect(waitingIntervals(snapshot, snapshot.run.rootNodeId, base + 86000)).toEqual([[base + 8000, base + 86000]]);
    expect(displayStatus(snapshot.nodes[0]!, snapshot)).toBe("waiting_children");
    expect(displayStatus(snapshot.nodes.find(node => node.status === "waiting_permission")!, snapshot)).toBe("waiting_permission");
  });
  it("shows an idle Run as active while any descendant is executing or waiting for permission", () => {
    const idle = { ...snapshot, run: { ...snapshot.run, status: "idle" as const }, nodes: snapshot.nodes.map(node => ({ ...node, status: "idle" as const })) };
    expect(displayRunStatus(idle)).toBe("idle");
    for (const status of ["starting", "running", "waiting_permission"] as const) {
      const executing = { ...idle, nodes: idle.nodes.map((node, index) => index === 1 ? { ...node, status } : node) };
      expect(displayRunStatus(executing)).toBe("active");
      expect(summarize(executing).status).toBe("active");
      expect(displayRunStatus({ ...executing, run: { ...executing.run, status: "canceled" } })).toBe("canceled");
    }
  });
  it("uses depth-first tree order even when input is shuffled; cycles cannot loop", () => {
    expect(treeOrder([...snapshot.nodes].reverse()).map(node => node.id.split(":").at(-1))).toEqual(["root", "api", "index", "ui", "review", "regression", "regression-v2"]);
    const cyclic = snapshot.nodes.map((node, index) => ({ ...node, parentNodeId: snapshot.nodes[(index + 1) % snapshot.nodes.length]!.id }));
    expect(treeOrder(cyclic)).toHaveLength(snapshot.nodes.length);
  });
  it("lays out parents above descendants deterministically without node collisions", () => {
    const positions = graphPositions(snapshot);
    expect(graphPositions(snapshot)).toEqual(positions);
    for (const edge of snapshot.delegations) expect(positions.get(edge.toNodeId)!.y).toBeGreaterThan(positions.get(edge.fromNodeId)!.y);
    const points = [...positions.values()];
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) expect(Math.abs(points[i]!.x - points[j]!.x) >= 286 || Math.abs(points[i]!.y - points[j]!.y) >= 210).toBe(true);
  });
  it("keeps reserved proposal node IDs out of graph endpoints until approval", async () => {
    const client = new DemoClient(() => base);
    const queued = await client.run("run-local-1");
    expect(graphPositions(queued).size).toBe(1);
    expect(graphEdges(queued)).toEqual([]);
    await client.approveTeam(queued.run.id, queued.run.team!.proposals[0]!.id, {});
    const running = await client.run(queued.run.id);
    expect(graphPositions(running).size).toBe(3);
    expect(graphEdges(running)).toHaveLength(2);
    const edges = graphEdges(snapshot);
    expect(edges.some(edge => edge.id.startsWith("replacement-") && edge.style?.strokeDasharray)).toBe(true);
    expect(edges.every(edge => snapshot.nodes.some(node => node.id === edge.source) && snapshot.nodes.some(node => node.id === edge.target))).toBe(true);
    expect(graphEdges({ ...running, run: { ...running.run, status: "paused" } }).every(edge => !edge.animated)).toBe(true);
  });
});
