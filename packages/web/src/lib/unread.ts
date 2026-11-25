import type { RunSummary } from "@baton/protocol";

const runSeenKey = "baton.runSeen";
type RunActivity = Pick<RunSummary, "id" | "projectId" | "lastActivityAt" | "lastEventAt" | "updatedAt">;
export type RunSeen = ReadonlyMap<string, string>;
export interface UnreadSummary { ids: ReadonlySet<string>; byProject: ReadonlyMap<string, number> }

export function readRunSeen(storage: Pick<Storage, "getItem">): RunSeen | null {
  try {
    const raw: unknown = JSON.parse(storage.getItem(runSeenKey) ?? "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const seen = new Map<string, string>();
    for (const [id, time] of Object.entries(raw)) {
      if (typeof time === "string" && Number.isFinite(Date.parse(time))) seen.set(id, new Date(time).toISOString());
    }
    return seen;
  } catch { return null; }
}

export function saveRunSeen(storage: Pick<Storage, "setItem">, seen: RunSeen): void {
  try { storage.setItem(runSeenKey, JSON.stringify(Object.fromEntries(seen))); } catch {}
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
  if (!seen.has(run.id)) return seen;
  const next = new Map(seen);
  next.delete(run.id);
  return next;
}

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
