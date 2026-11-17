/** Demo rollback (DESIGN §4.13): checkpoints derived from the demo transcript, fake file changes. */
import type { CheckpointChangesResponse, CheckpointRecord, ItemRecord, RunEventEnvelope, RunSnapshot } from "@baton/protocol";

/** Latest row per item seq of a node, from a demo run's event log. */
export function demoRows(log: RunEventEnvelope[], nodeId: string): ItemRecord[] {
  const rows = new Map<number, ItemRecord>();
  for (const event of log) if (event.type === "item" && event.nodeId === nodeId) rows.set(event.itemSeq, { seq: event.itemSeq, nodeId, ts: event.itemTs, item: event.item, turnId: event.turnId, ...(event.rolledBack ? { rolledBack: true } : {}) });
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}
const PREFIX = "cp-demo:";
/** One checkpoint per human message that opened a turn (one per batch) plus the first prompt; pi replays. */
export function demoCheckpoints(snapshot: RunSnapshot, rows: ItemRecord[], nodeId: string): CheckpointRecord[] {
  const node = snapshot.nodes.find(entry => entry.id === nodeId);
  if (!node) return [];
  const first = rows.find(row => row.item.type === "user_message"), turns = new Set<string>(), list: CheckpointRecord[] = [];
  for (const row of rows) {
    if (row.item.type !== "user_message") continue;
    const opens = row.item.delivery === "turn" || (row === first && row.item.delivery === undefined && !row.item.text.trimStart().startsWith("<baton-"));
    if (!opens || (row.turnId && turns.has(row.turnId))) continue;
    if (row.turnId) turns.add(row.turnId);
    list.push({ id: `${PREFIX}${row.seq}:${nodeId}`, runId: snapshot.run.id, nodeId, itemSeq: row.seq, createdAt: row.ts, files: { cwd: node.cwd, ref: `demo${row.seq}` }, conversation: node.agentId === "pi" ? "replay" : "native" });
  }
  return list.reverse();
}
export function demoCheckpointNode(id: string): string | undefined {
  if (!id.startsWith(PREFIX)) return undefined;
  const rest = id.slice(PREFIX.length), colon = rest.indexOf(":");
  return colon > 0 ? rest.slice(colon + 1) : undefined;
}
const FILES: CheckpointChangesResponse["files"] = [
  { path: "src/components/Transcript.tsx", status: "modified" },
  { path: "src/lib/rollback.ts", status: "added" },
  { path: "docs/conversation-notes.md", status: "deleted" },
  { path: "src/styles.css", status: "modified" },
  { path: "src/lib/rollback.test.ts", status: "added" },
];
/** A deterministic list: later messages undo fewer files. */
export function demoChanges(checkpoint: CheckpointRecord): CheckpointChangesResponse {
  return { files: FILES.slice(0, 1 + (checkpoint.itemSeq % FILES.length)) };
}
