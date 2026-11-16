import type { RunSnapshot } from "@baton/protocol";

export interface TimeViewport { start: number; end: number }
export type Interval = [number, number];
export const gapThreshold = 60_000;
const gapUnits = 1000;
export const timeX = (time: number, view: TimeViewport, width: number): number => (time - view.start) / (view.end - view.start) * width;
export const xTime = (x: number, view: TimeViewport, width: number): number => view.start + x / width * (view.end - view.start);
export function zoomTime(view: TimeViewport, factor: number, anchor: number): TimeViewport {
  const span = Math.min(365 * 86400000, Math.max(1000, (view.end - view.start) * factor));
  const position = Math.max(0, Math.min(1, anchor));
  const center = view.start + (view.end - view.start) * position;
  return { start: center - span * position, end: center + span * (1 - position) };
}
export function panTime(view: TimeViewport, deltaPixels: number, width: number): TimeViewport {
  const delta = deltaPixels / width * (view.end - view.start);
  return { start: view.start - delta, end: view.end - delta };
}
export function niceTicks(view: TimeViewport, width: number): number[] {
  const target = (view.end - view.start) / Math.max(2, width / 110);
  const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000, 10800000, 21600000, 86400000];
  const step = steps.find(value => value >= target) ?? Math.ceil(target / 86400000) * 86400000;
  const ticks: number[] = [];
  for (let value = Math.ceil(view.start / step) * step; value <= view.end; value += step) ticks.push(value);
  return ticks;
}
export function unionIntervals(ranges: Interval[]): Interval[] {
  const sorted = ranges.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).map(range => [...range] as Interval).sort((a, b) => a[0] - b[0]);
  const result: Interval[] = [];
  for (const range of sorted) { const previous = result.at(-1); if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]); else result.push(range); }
  return result;
}
export const intervalDuration = (ranges: Interval[]): number => ranges.reduce((sum, [start, end]) => sum + end - start, 0);
/** All persisted timestamps, plus the latest SSE envelope. Never consult the wall clock. */
export function sessionBounds(snapshot: RunSnapshot, lastEventAt?: number): TimeViewport {
  const values = [Date.parse(snapshot.run.createdAt)];
  const take = (...times: Array<string | undefined>) => { for (const time of times) if (time && Number.isFinite(Date.parse(time))) values.push(Date.parse(time)); };
  take(snapshot.lastEventAt, snapshot.run.updatedAt, snapshot.run.endedAt);
  snapshot.run.pauses?.forEach(pause => take(pause.at, pause.resumedAt));
  snapshot.nodes.forEach(node => take(node.createdAt, node.updatedAt, node.endedAt));
  snapshot.turns.forEach(turn => take(turn.startedAt, turn.endedAt));
  snapshot.toolSpans.forEach(span => take(span.startedAt, span.endedAt));
  snapshot.delegations.forEach(edge => take(edge.createdAt, edge.startedAt, edge.endedAt, edge.deliveredAt));
  snapshot.permissions.forEach(permission => take(permission.requestedAt, permission.resolvedAt));
  snapshot.questions.forEach(question => take(question.askedAt, question.answeredAt));
  snapshot.escalations.forEach(escalation => take(escalation.createdAt, escalation.resolvedAt));
  snapshot.run.team?.changes.forEach(change => take(change.at));
  snapshot.run.team?.proposals.forEach(proposal => take(proposal.proposedAt, proposal.decidedAt));
  if (lastEventAt !== undefined && Number.isFinite(lastEventAt)) values.push(lastEventAt);
  return { start: Math.min(...values), end: Math.max(...values) };
}
export interface TimelineSegment { start: number; end: number; from: number; to: number; collapsed: boolean }
export interface SessionTimeline {
  bounds: TimeViewport; work: Interval[]; gaps: Interval[]; segments: TimelineSegment[]; domain: TimeViewport;
  workMs: number; spanMs: number; averageParallelism: number; nodeWork: Map<string, { duration: number; share: number }>;
}
export function sessionTimeline(snapshot: RunSnapshot, compressed = true, lastEventAt?: number): SessionTimeline {
  const bounds = sessionBounds(snapshot, lastEventAt);
  const byNode = new Map<string, Interval[]>();
  for (const turn of snapshot.turns) {
    const start = Date.parse(turn.startedAt);
    const recordedEnd = turn.status === "running" ? bounds.end : Date.parse(turn.endedAt ?? snapshot.nodes.find(node => node.id === turn.nodeId)?.endedAt ?? new Date(bounds.end).toISOString());
    const end = Math.max(start, Math.min(bounds.end, recordedEnd));
    const ranges = byNode.get(turn.nodeId) ?? []; ranges.push([start, end]); byNode.set(turn.nodeId, ranges);
  }
  for (const [id, ranges] of byNode) byNode.set(id, unionIntervals(ranges));
  const work = unionIntervals([...byNode.values()].flat()); const workMs = intervalDuration(work);
  const gaps: Interval[] = []; let cursor = bounds.start;
  for (const [start, end] of work) { if (start - cursor > gapThreshold) gaps.push([cursor, start]); cursor = Math.max(cursor, end); }
  if (bounds.end - cursor > gapThreshold) gaps.push([cursor, bounds.end]);
  const segments: TimelineSegment[] = []; let from = 0; cursor = bounds.start;
  const append = (start: number, end: number, collapsed: boolean) => { if (end <= start) return; const to = from + (collapsed ? gapUnits : end - start); segments.push({ start, end, from, to, collapsed }); from = to; };
  for (const [start, end] of compressed ? gaps : []) { append(cursor, start, false); append(start, end, true); cursor = end; }
  append(cursor, Math.max(bounds.end, bounds.start + 1), false);
  const nodeWork = new Map([...byNode].map(([id, intervals]) => { const duration = intervalDuration(intervals); return [id, { duration, share: workMs ? duration / workMs : 0 }]; }));
  return { bounds, work, gaps: compressed ? gaps : [], segments, domain: { start: 0, end: Math.max(1, from) }, workMs, spanMs: bounds.end - bounds.start, averageParallelism: workMs ? [...nodeWork.values()].reduce((sum, value) => sum + value.duration, 0) / workMs : 0, nodeWork };
}
function interpolate(value: number, a: number, b: number, c: number, d: number): number { return c + (value - a) / Math.max(1e-9, b - a) * (d - c); }
export function sessionCoordinate(model: SessionTimeline, time: number): number {
  const segment = model.segments.find(part => time <= part.end) ?? model.segments.at(-1)!;
  if (time < model.bounds.start) return time - model.bounds.start;
  if (time > model.bounds.end) return model.domain.end + time - model.bounds.end;
  return interpolate(time, segment.start, segment.end, segment.from, segment.to);
}
export function coordinateTime(model: SessionTimeline, value: number): number {
  const segment = model.segments.find(part => value <= part.to) ?? model.segments.at(-1)!;
  if (value < 0) return model.bounds.start + value;
  if (value > model.domain.end) return model.bounds.end + value - model.domain.end;
  return interpolate(value, segment.from, segment.to, segment.start, segment.end);
}
export function fitSession(model: SessionTimeline): TimeViewport { const pad = Math.max(500, (model.domain.end - model.domain.start) * .035); return { start: -pad, end: model.domain.end + pad }; }
export function followSession(model: SessionTimeline, view: TimeViewport): TimeViewport {
  const span = view.end - view.start; const end = model.domain.end + span * .035;
  return { start: end - span, end };
}
/** Piecewise scale with a 28px broken axis even while zooming/panning. Both domains have inverses. */
export function timelineScale(model: SessionTimeline, view: TimeViewport, width: number) {
  const collapsed = model.segments.filter(part => part.collapsed);
  const visibleGapUnits = collapsed.reduce((sum, part) => sum + Math.max(0, Math.min(view.end, part.to) - Math.max(view.start, part.from)), 0);
  const visibleGaps = visibleGapUnits / gapUnits;
  const gapWidth = Math.min(28, width * .4 / Math.max(1, visibleGaps));
  const normalUnits = view.end - view.start - visibleGapUnits;
  const rate = normalUnits > 0 ? (width - visibleGaps * gapWidth) / normalUnits : width / (view.end - view.start);
  const gapRate = normalUnits > 0 ? gapWidth / gapUnits : rate;
  const primitive = (value: number) => value * rate + collapsed.reduce((sum, part) => sum + Math.max(0, Math.min(value, part.to) - part.from) * (gapRate - rate), 0);
  const origin = primitive(view.start);
  const coordinateX = (value: number) => primitive(value) - origin;
  const xCoordinate = (pixel: number) => {
    // Monotone piecewise inverse. Binary search is stable at gap boundaries and outside the view.
    let low = Math.min(view.start, model.domain.start) - Math.abs(pixel) / rate - 1;
    let high = Math.max(view.end, model.domain.end) + Math.abs(pixel) / rate + 1;
    for (let i = 0; i < 55; i++) { const mid = (low + high) / 2; if (coordinateX(mid) < pixel) low = mid; else high = mid; }
    return (low + high) / 2;
  };
  return { x: (time: number) => coordinateX(sessionCoordinate(model, time)), invert: (pixel: number) => coordinateTime(model, xCoordinate(pixel)), coordinateX, xCoordinate, gapWidth };
}
/** Keep the point beneath the pointer fixed even when a broken axis enters/leaves the viewport. */
function anchoredViewport(model: SessionTimeline, span: number, width: number, coordinate: number, pixel: number): TimeViewport {
  const position = (start: number) => timelineScale(model, { start, end: start + span }, width).coordinateX(coordinate);
  let distance = span * Math.max(1, Math.abs(pixel) / width + 1);
  let low = coordinate - distance; let high = coordinate + distance;
  while (position(low) < pixel || position(high) > pixel) { distance *= 2; low = coordinate - distance; high = coordinate + distance; }
  for (let i = 0; i < 48; i++) { const mid = (low + high) / 2; if (position(mid) > pixel) low = mid; else high = mid; }
  const start = (low + high) / 2; return { start, end: start + span };
}
export function zoomSession(model: SessionTimeline, view: TimeViewport, width: number, factor: number, pixel: number): TimeViewport {
  const coordinate = timelineScale(model, view, width).xCoordinate(pixel);
  const zoomed = zoomTime(view, factor, .5); const span = zoomed.end - zoomed.start;
  return anchoredViewport(model, span, width, coordinate, pixel);
}
export function panSession(model: SessionTimeline, view: TimeViewport, width: number, originPixel: number, deltaPixels: number): TimeViewport {
  const coordinate = timelineScale(model, view, width).xCoordinate(originPixel);
  return anchoredViewport(model, view.end - view.start, width, coordinate, originPixel + deltaPixels);
}
export function splitAcrossGaps(model: SessionTimeline, start: number, end: number): Interval[] {
  const result: Interval[] = []; let cursor = Math.max(model.bounds.start, start); const last = Math.min(model.bounds.end, end);
  for (const [gapStart, gapEnd] of model.gaps) { if (gapEnd <= cursor) continue; if (gapStart >= last) break; if (gapStart > cursor) result.push([cursor, Math.min(gapStart, last)]); cursor = Math.max(cursor, gapEnd); }
  if (last > cursor) result.push([cursor, last]); return result;
}
/** Pause bands include collapsed-axis segments: a paused gap still has a visible hatched marker. */
export function pauseBands(snapshot: RunSnapshot, model: SessionTimeline): Array<{ start: number; end: number; collapsed: boolean }> {
  return (snapshot.run.pauses ?? []).flatMap(pause => {
    const start = Date.parse(pause.at); const end = Date.parse(pause.resumedAt ?? new Date(model.bounds.end).toISOString());
    return model.segments.flatMap(segment => { const a = Math.max(start, segment.start); const b = Math.min(end, segment.end); return b > a ? [{ start: a, end: b, collapsed: segment.collapsed }] : []; });
  });
}
export function workTimeAt(model: SessionTimeline, time: number): number { return model.work.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(time, end) - start), 0); }
export function wallTimeAtWork(model: SessionTimeline, workTime: number): number {
  let elapsed = 0; for (const [start, end] of model.work) { if (workTime <= elapsed + end - start) return start + workTime - elapsed; elapsed += end - start; } return model.bounds.end;
}
export function workClock(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
export function workTicks(model: SessionTimeline, view: TimeViewport, width: number): Array<{ time: number; work: number; label: string }> {
  const start = workTimeAt(model, coordinateTime(model, view.start)); const end = workTimeAt(model, coordinateTime(model, view.end));
  return niceTicks({ start, end }, width).map(work => ({ time: wallTimeAtWork(model, work), work, label: workClock(work) }));
}
/** Compatibility helper: now is deliberately ignored; callers should use sessionTimeline for rendering. */
export function fitTime(snapshot: RunSnapshot, _now?: number): TimeViewport { const bounds = sessionBounds(snapshot); const pad = Math.max(1500, (bounds.end - bounds.start) * .04); return { start: bounds.start - pad, end: Math.max(bounds.start + 10000, bounds.end) + pad }; }
export function waitingIntervals(snapshot: RunSnapshot, nodeId: string, end: number): Interval[] {
  return unionIntervals(snapshot.delegations.filter(edge => edge.fromNodeId === nodeId).map(edge => [Date.parse(edge.createdAt), Math.min(end, Date.parse(edge.deliveredAt ?? edge.endedAt ?? new Date(end).toISOString()))]));
}
