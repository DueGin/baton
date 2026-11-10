import type { RunSnapshot } from "@baton/protocol";

export interface TimeViewport { start: number; end: number }
export const timeX = (time: number, view: TimeViewport, width: number): number => (time - view.start) / (view.end - view.start) * width;
export const xTime = (x: number, view: TimeViewport, width: number): number => view.start + x / width * (view.end - view.start);
export function zoomTime(view: TimeViewport, factor: number, anchor: number): TimeViewport {
  const span = Math.min(86400000, Math.max(1000, (view.end - view.start) * factor));
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
  const step = steps.find(value => value >= target) ?? 86400000;
  const ticks: number[] = [];
  for (let value = Math.ceil(view.start / step) * step; value <= view.end; value += step) ticks.push(value);
  return ticks;
}
/** Latest timestamp anything happened in the run (used to fit idle runs without stretching to now). */
function lastActivity(snapshot: RunSnapshot, fallback: number): number {
  let latest = fallback;
  const take = (value: string | undefined): void => { if (value) latest = Math.max(latest, Date.parse(value)); };
  for (const turn of snapshot.turns) { take(turn.startedAt); take(turn.endedAt); }
  for (const span of snapshot.toolSpans) { take(span.startedAt); take(span.endedAt); }
  for (const edge of snapshot.delegations) { take(edge.endedAt); take(edge.deliveredAt); }
  for (const node of snapshot.nodes) take(node.endedAt);
  for (const question of snapshot.questions ?? []) { take(question.askedAt); take(question.answeredAt); }
  for (const escalation of snapshot.escalations ?? []) { take(escalation.createdAt); take(escalation.resolvedAt); }
  for (const change of snapshot.run.team?.changes ?? []) take(change.at);
  return latest;
}
export function fitTime(snapshot: RunSnapshot, now: number): TimeViewport {
  const start = Date.parse(snapshot.run.createdAt);
  const live = snapshot.nodes.some((node) => node.status === "starting" || node.status === "running" || node.status === "waiting_permission") || (snapshot.questions ?? []).some(question => question.status === "pending");
  const end = snapshot.run.endedAt ? Date.parse(snapshot.run.endedAt) : live ? now : lastActivity(snapshot, start);
  const pad = Math.max(1500, (end - start) * 0.04);
  return { start: start - pad, end: Math.max(start + 10000, end) + pad };
}
export function waitingIntervals(snapshot: RunSnapshot, nodeId: string, now: number): Array<[number, number]> {
  const ranges = snapshot.delegations.filter(edge => edge.fromNodeId === nodeId).map(edge => [Date.parse(edge.createdAt), edge.deliveredAt ? Date.parse(edge.deliveredAt) : edge.endedAt ? Date.parse(edge.endedAt) : now] as [number, number]).sort((a, b) => a[0] - b[0]);
  const result: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = result.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else result.push([...range]);
  }
  return result;
}
