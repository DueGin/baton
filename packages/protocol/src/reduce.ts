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

/** run.updated patch keys that only edit how a run is shown or governed, not what it did. */
const COSMETIC_RUN_KEYS = new Set(["title", "titleSource", "archived", "archivedAt", "policy", "updatedAt"]);

/**
 * Event types that only refresh bookkeeping the daemon polls on its own: background-process
 * registrations (re-emitted every 60 s with a new lastSeenAt while a process runs) and pull-request
 * status (re-emitted on every status poll / 5-minute heartbeat). They say nothing new about the
 * conversation, so they must not reorder the sidebar or mark a run unread.
 */
const BOOKKEEPING_EVENTS = new Set<string>(["background", "pr"]);

/**
 * Whether the event counts as conversation activity (drives `lastActivityAt`, sidebar order and
 * unread state). Not activity: BOOKKEEPING_EVENTS, and run.updated whose patch only touches
 * COSMETIC_RUN_KEYS (rename, title regeneration, archive / unarchive, policy toggles). Everything
 * else — items, turns, nodes, delegations, questions, permissions, status / usage / pauses — is.
 */
export function isActivityEvent(event: Pick<RunEventEnvelope, "type"> & { patch?: object }): boolean {
  if (BOOKKEEPING_EVENTS.has(event.type)) return false;
  if (event.type !== "run.updated" || !event.patch) return true;
  return Object.keys(event.patch).some((key) => !COSMETIC_RUN_KEYS.has(key));
}

/** Returns a new snapshot (or the same object when the event is older than lastSeq). */
export function applyEvent(snapshot: RunSnapshot, event: RunEventEnvelope): RunSnapshot {
  if (event.seq <= snapshot.lastSeq) return snapshot;
  const next: RunSnapshot = { ...snapshot, lastSeq: event.seq, lastEventAt: event.ts, ...(isActivityEvent(event) ? { lastActivityAt: event.ts } : {}) };
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
    case "question":
      next.questions = upsert(next.questions ?? [], event.question);
      break;
    case "escalation":
      next.escalations = upsert(next.escalations ?? [], event.escalation);
      break;
    case "pr":
      next.pullRequests = upsert(next.pullRequests ?? [], event.pr);
      break;
    case "background":
      next.backgroundProcesses = upsert(next.backgroundProcesses ?? [], event.process);
      break;
    case "permission":
      next.permissions = upsert(next.permissions, event.permission);
      break;
    default:
      break;
  }
  return next;
}
