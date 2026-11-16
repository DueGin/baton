import { describe, expect, it } from "vitest";
import { idleScenario } from "../demo/idle.js";
import { coordinateTime, fitSession, followSession, intervalDuration, panSession, pauseBands, sessionBounds, sessionCoordinate, sessionTimeline, splitAcrossGaps, timelineScale, unionIntervals, wallTimeAtWork, workClock, workTicks, workTimeAt, zoomSession } from "./timeline.js";
const base = Date.parse("2026-11-10T07:00:00Z"); const snapshot = idleScenario(base);
describe("session work intervals", () => {
  it("unions overlap and ignores empty or invalid intervals", () => {
    expect(unionIntervals([[20, 30], [0, 10], [9, 21], [40, 40], [50, 45], [NaN, 70]])).toEqual([[0, 30]]);
    expect(intervalDuration([[0, 10], [20, 30]])).toBe(20);
  });
  it("collapses only gaps longer than sixty seconds and computes work-weighted concurrency", () => {
    const model = sessionTimeline(snapshot);
    expect(model.work.map(([a, b]) => [a - base, b - base])).toEqual([[0, 120000], [7320000, 7500000], [8400000, 8580000]]);
    expect(model.gaps.map(([a, b]) => b - a)).toEqual([7200000, 900000]);
    expect(model.workMs).toBe(480000); expect(model.spanMs).toBe(8580000);
    expect(model.averageParallelism).toBeCloseTo((480000 + 345000) / 480000);
    expect(model.nodeWork.get(snapshot.nodes[1]!.id)).toEqual({ duration: 345000, share: 345 / 480 });
    const boundary = { ...snapshot, turns: snapshot.turns.slice(0, 1).map(turn => ({ ...turn, endedAt: new Date(base + 60_000).toISOString() })), run: { ...snapshot.run, updatedAt: new Date(base + 120_000).toISOString(), endedAt: new Date(base + 120_000).toISOString() }, nodes: [] ,toolSpans: [], delegations: [] };
    expect(sessionTimeline(boundary).gaps).toEqual([]);
  });
  it("uses latest persisted or received event time, never the system clock", () => {
    const live = { ...snapshot, run: { ...snapshot.run, endedAt: undefined }, turns: snapshot.turns.map((turn, i) => i === 4 ? { ...turn, status: "running" as const, endedAt: undefined } : turn) };
    expect(sessionBounds(live).end).toBe(base + 8580000);
    expect(sessionTimeline(live, true, base + 8590000).workMs).toBe(490000);
    expect(sessionTimeline(live).workMs).toBe(480000);
    const reloaded = { ...live, lastEventAt: new Date(base + 8590000).toISOString() };
    expect(sessionBounds(reloaded).end).toBe(base + 8590000);
    expect(sessionTimeline(reloaded).workMs).toBe(490000);
  });
});
describe("piecewise session scale", () => {
  const model = sessionTimeline(snapshot); const view = fitSession(model); const scale = timelineScale(model, view, 900);
  it("round-trips wall/session/pixel coordinates including collapsed gaps and out-of-view positions", () => {
    for (const offset of [-1000, 0, 30_000, 120_000, 1_000_000, 7_320_000, 7_400_000, 8_100_000, 8_580_000, 9_000_000]) {
      const time = base + offset; expect(coordinateTime(model, sessionCoordinate(model, time))).toBeCloseTo(time, 3); expect(scale.invert(scale.x(time))).toBeCloseTo(time, 2);
    }
    for (const [start, end] of model.gaps) expect(scale.x(end) - scale.x(start)).toBeCloseTo(28, 5);
    const zoom = { start: 0, end: model.domain.end / 2 }; const zoomScale = timelineScale(model, zoom, 900);
    expect(zoomScale.invert(zoomScale.x(base + 1_000_000))).toBeCloseTo(base + 1_000_000, 2);
  });
  it("splits lifetime/wait/tool bands at idle gaps and leaves wall-clock mode intact", () => {
    expect(splitAcrossGaps(model, base + 50_000, base + 8_500_000).map(([a, b]) => [a - base, b - base])).toEqual([[50000,120000], [7320000,7500000], [8400000,8500000]]);
    expect(splitAcrossGaps(model, base + 200_000, base + 300_000)).toEqual([]);
    const real = sessionTimeline(snapshot, false); expect(real.gaps).toEqual([]); expect(splitAcrossGaps(real, base, base + 8_500_000)).toEqual([[base, base + 8_500_000]]);
  });
  it("splits paused intervals across normal and compressed segments while leaving a visible broken-axis band", () => {
    const paused = { ...snapshot, run: { ...snapshot.run, pauses: [{ at: new Date(base + 60000).toISOString(), resumedAt: new Date(base + 7380000).toISOString(), by: "human" as const }] } };
    expect(pauseBands(paused, sessionTimeline(paused)).map(band => ({ start: band.start - base, end: band.end - base, collapsed: band.collapsed }))).toEqual([
      { start: 60000, end: 120000, collapsed: false }, { start: 120000, end: 7320000, collapsed: true }, { start: 7320000, end: 7380000, collapsed: false },
    ]);
    expect(pauseBands(paused, sessionTimeline(paused, false))).toEqual([{ start: base + 60000, end: base + 7380000, collapsed: false }]);
    const open = { ...snapshot, run: { ...snapshot.run, status: "paused" as const, pauses: [{ at: new Date(base + 7500000).toISOString(), by: "human" as const }] } };
    expect(pauseBands(open, sessionTimeline(open)).at(-1)?.end).toBe(sessionBounds(open).end);
  });
  it("anchors zoom and pan to the pointer across broken axes", () => {
    for (const pixel of [0, 150, scale.x(base + 1_000_000), 500, 900]) {
      const coordinate = scale.xCoordinate(pixel);
      for (const factor of [.2, .7, 1.5, 5]) {
        const next = zoomSession(model, view, 900, factor, pixel);
        expect(timelineScale(model, next, 900).coordinateX(coordinate)).toBeCloseTo(pixel, 5);
      }
      for (const delta of [-250, 200]) {
        const next = panSession(model, view, 900, pixel, delta);
        expect(next.end - next.start).toBeCloseTo(view.end - view.start, 5);
        expect(timelineScale(model, next, 900).coordinateX(coordinate)).toBeCloseTo(pixel + delta, 5);
      }
    }
  });
  it("follows the latest activity immediately while retaining the zoom span", () => {
    const view = { start: 0, end: 60000 }; const latest = followSession(model, view);
    expect(latest.end - latest.start).toBe(60000);
    expect(latest.start).toBeLessThan(model.domain.end); expect(latest.end).toBeGreaterThan(model.domain.end);
    expect(latest.end - model.domain.end).toBe(2100);
  });
  it("ticks in cumulative working time and maps back to real intervals", () => {
    expect(workClock(3_750_000)).toBe("1:02:30"); expect(workClock(300_000)).toBe("5:00");
    expect(workTimeAt(model, base + 4_000_000)).toBe(120000);
    expect(wallTimeAtWork(model, 180000)).toBe(base + 7_380_000);
    const ticks = workTicks(model, view, 900); expect(ticks[0]!.label).toBe("0:00"); expect(ticks.some(tick => tick.label === "5:00")).toBe(true);
    for (const tick of ticks) expect(workTimeAt(model, tick.time)).toBe(tick.work);
  });
});
