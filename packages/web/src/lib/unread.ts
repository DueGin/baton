import type { RunSummary } from "@baton/protocol";

export const runSeenKey = "baton.runSeen";
type RunActivity = Pick<RunSummary, "id" | "projectId" | "lastActivityAt" | "lastEventAt" | "updatedAt">;
export type RunSeen = ReadonlyMap<string, string>;
export interface UnreadSummary { ids: ReadonlySet<string>; byProject: ReadonlyMap<string, number> }

function parseRunSeenRecord(value: string | null): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(value ?? "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch { return null; }
}

function runSeenFromRecord(record: Record<string, unknown>): RunSeen {
  const seen = new Map<string, string>();
  for (const [id, time] of Object.entries(record)) {
    if (typeof time === "string" && Number.isFinite(Date.parse(time))) seen.set(id, new Date(time).toISOString());
  }
  return seen;
}

export function readRunSeen(storage: Pick<Storage, "getItem">): RunSeen | null {
  try {
    const record = parseRunSeenRecord(storage.getItem(runSeenKey));
    return record && runSeenFromRecord(record);
  } catch { return null; }
}

export function mergeRunSeen(seen: RunSeen, incoming: RunSeen): RunSeen {
  let next: Map<string, string> | undefined;
  for (const [id, time] of incoming) {
    const previous = seen.get(id);
    if (previous === undefined || Date.parse(time) > Date.parse(previous)) (next ??= new Map(seen)).set(id, time);
  }
  return next ?? seen;
}

export function mergeRunSeenStorage(seen: RunSeen | null, event: Pick<StorageEvent, "key" | "oldValue" | "newValue">): RunSeen | null {
  if (event.key !== runSeenKey) return seen;
  const record = parseRunSeenRecord(event.newValue);
  if (!record) return seen;
  const incoming = runSeenFromRecord(record);
  if (!seen) return incoming;
  let next = mergeRunSeen(seen, incoming);
  const previous = parseRunSeenRecord(event.oldValue);
  for (const [id, time] of Object.entries(record)) {
    if (time !== null) continue;
    const local = next.get(id);
    const replaced = previous?.[id];
    if (local !== undefined && typeof replaced === "string" && Date.parse(local) <= Date.parse(replaced)) next = forgetRunSeen(next, id);
  }
  return next;
}

export function saveRunSeen(storage: Pick<Storage, "getItem" | "setItem">, seen: RunSeen, { runs, markUnread }: { runs?: readonly RunActivity[]; markUnread?: RunActivity } = {}): RunSeen {
  let previous = null;
  try { previous = storage.getItem(runSeenKey); } catch {}
  const record = parseRunSeenRecord(previous);
  let next = record ? mergeRunSeen(seen, runSeenFromRecord(record)) : seen;
  if (runs) next = reconcileRunSeen(next, runs, false);
  if (markUnread) next = setRunRead(next, markUnread, false);
  const value = JSON.stringify({ ...Object.fromEntries(next), ...(markUnread && { [markUnread.id]: null }) });
  try { if (value !== previous) storage.setItem(runSeenKey, value); } catch {}
  return next;
}

export function runActivityAt(run: RunActivity): string { return run.lastActivityAt ?? run.lastEventAt ?? run.updatedAt; }

export function isUnread(run: RunActivity, seen: RunSeen | null): boolean {
  if (!seen) return false;
  const time = seen.get(run.id);
  return time === undefined || Date.parse(runActivityAt(run)) > Date.parse(time);
}

export function markRunSeen(seen: RunSeen, id: string, activityAt: string): RunSeen {
  const previous = seen.get(id);
  if (previous !== undefined && Date.parse(activityAt) <= Date.parse(previous)) return seen;
  return new Map(seen).set(id, activityAt);
}

export function setRunRead(seen: RunSeen, run: RunActivity, read: boolean): RunSeen {
  if (read) return markRunSeen(seen, run.id, runActivityAt(run));
  return forgetRunSeen(seen, run.id);
}

function forgetRunSeen(seen: RunSeen, id: string): RunSeen {
  if (!seen.has(id)) return seen;
  const next = new Map(seen);
  next.delete(id);
  return next;
}

export function reconcileRunSeen(seen: RunSeen | null, runs: readonly RunActivity[], loading: false): RunSeen;
export function reconcileRunSeen(seen: RunSeen | null, runs: readonly RunActivity[], loading: boolean): RunSeen | null;
export function reconcileRunSeen(seen: RunSeen | null, runs: readonly RunActivity[], loading: boolean): RunSeen | null {
  if (loading) return seen;
  if (!seen) return new Map(runs.map(run => [run.id, runActivityAt(run)]));
  const ids = new Set(runs.map(run => run.id));
  const kept = [...seen].filter(([id]) => ids.has(id));
  return kept.length === seen.size ? seen : new Map(kept);
}

export function summarizeUnread(runs: readonly RunActivity[], seen: RunSeen | null): UnreadSummary {
  const ids = new Set<string>();
  const byProject = new Map<string, number>();
  for (const run of runs) if (isUnread(run, seen)) {
    ids.add(run.id);
    if (run.projectId) byProject.set(run.projectId, (byProject.get(run.projectId) ?? 0) + 1);
  }
  return { ids, byProject };
}

export function filterUnreadRuns<Run extends Pick<RunActivity, "id">>(runs: readonly Run[], unreadIds: ReadonlySet<string>, selectedId: string | null): Run[] {
  return runs.filter(run => run.id === selectedId || unreadIds.has(run.id));
}
