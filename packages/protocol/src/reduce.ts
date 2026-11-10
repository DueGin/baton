/**
 * Pure reducer: apply one event to a snapshot. The web console uses it for live updates; the
 * server's tests use it to check that projections equal the replayed event log.
 * Items (transcript rows) are not part of RunSnapshot and are ignored here.
 */
import type { RunEventEnvelope } from "./events.js";
import type { RunSnapshot } from "./records.js";

function upsert<T extends { id: string }>(list: T[], value: T): T[] {
  const index = list.findIndex((entry) => entry.id === value.id);
  if (index === -1) return [...list, value];
  const next = list.slice();
  next[index] = value;
  return next;
}

function patchById<T extends { id: string }>(list: T[], id: string, patch: Partial<T>): T[] {
  const index = list.findIndex((entry) => entry.id === id);
  if (index === -1) return list;
  const next = list.slice();
  next[index] = { ...next[index]!, ...patch };
  return next;
}

/** Returns a new snapshot (or the same object when the event is older than lastSeq). */
export function applyEvent(snapshot: RunSnapshot, event: RunEventEnvelope): RunSnapshot {
  if (event.seq <= snapshot.lastSeq) return snapshot;
  const next: RunSnapshot = { ...snapshot, lastSeq: event.seq };
  switch (event.type) {
    case "run.created":
      next.run = event.run;
      break;
    case "run.updated":
      next.run = { ...next.run, ...event.patch };
      break;
    case "node.created":
      next.nodes = upsert(next.nodes, event.node);
      break;
    case "node.updated":
      next.nodes = patchById(next.nodes, event.nodeId, event.patch);
      break;
    case "delegation.created":
      next.delegations = upsert(next.delegations, event.delegation);
      break;
    case "delegation.updated":
      next.delegations = patchById(next.delegations, event.delegationId, event.patch);
      break;
    case "turn.started":
      next.turns = upsert(next.turns, event.turn);
      break;
    case "turn.updated":
      next.turns = patchById(next.turns, event.turnId, event.patch);
      break;
    case "tool.span":
      next.toolSpans = upsert(next.toolSpans, event.span);
      break;
    case "team.updated":
      next.run = { ...next.run, team: event.team };
      break;
    case "permission":
      next.permissions = upsert(next.permissions, event.permission);
      break;
    default:
      break;
  }
  return next;
}
