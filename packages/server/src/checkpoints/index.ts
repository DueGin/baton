/**
 * Rollback checkpoints (DESIGN §4.13): persistence, file snapshots and the replay transcript.
 *
 * A CheckpointRecord is stored with two kernel-internal fields: the turn the checkpoint opened (so a
 * rollback finds every row of that turn and later) and the driver's rewind point (an opaque marker
 * returned by DriverSession.rewindPoint, used for native conversation rewind).
 */
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { parse } from "node:path";
import type { CheckpointChangesResponse, CheckpointRecord, ItemRecord, JsonValue } from "@baton/protocol";
import type { Store } from "../store/index.js";
import { ShadowGit, type FileChange, type SnapshotResult } from "./shadow-git.js";

export interface CheckpointEntry { record: CheckpointRecord; turnId?: string; point?: JsonValue | null }
export class CheckpointError extends Error { readonly status = 409; }

/** Directories that are never snapshotted (a snapshot of them is never what the human means). */
async function broadDirectory(cwd: string): Promise<boolean> {
  const real = await realpath(cwd).catch(() => undefined);
  if (!real) return true;
  const broad = await Promise.all([homedir(), tmpdir()].map((dir) => realpath(dir).catch(() => dir)));
  return real === parse(real).root || broad.includes(real);
}

export class Checkpoints {
  constructor(readonly store: Store, readonly shadow?: ShadowGit) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL, turn_id TEXT, point TEXT);
      CREATE INDEX IF NOT EXISTS checkpoints_node ON checkpoints(node_id);
      CREATE TABLE IF NOT EXISTS node_preambles (node_id TEXT PRIMARY KEY, text TEXT NOT NULL);`);
  }
  /** Snapshot a cwd for a checkpoint; never rejects. */
  async snapshot(cwd: string): Promise<SnapshotResult> {
    if (!this.shadow) return { skipped: "file checkpoints are disabled" };
    if (await broadDirectory(cwd)) return { skipped: "the working directory is the home, temp or root directory" };
    return this.shadow.snapshot(cwd);
  }
  create(input: Omit<CheckpointRecord, "id">, turnId: string): CheckpointRecord {
    const record: CheckpointRecord = { id: `cp_${randomUUID()}`, ...input };
    this.store.db.prepare("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, NULL)").run(record.id, record.nodeId, record.runId, JSON.stringify(record), turnId);
    return record;
  }
  /** Record the driver's rewind point once the turn started; no point means native rewind is impossible. */
  setPoint(id: string, point: JsonValue | null): void {
    const entry = this.get(id);
    const record = entry.record.conversation === "native" && point === null ? { ...entry.record, conversation: "replay" as const } : entry.record;
    this.store.db.prepare("UPDATE checkpoints SET data=?, point=? WHERE id=?").run(JSON.stringify(record), point === null ? null : JSON.stringify(point), id);
  }
  get(id: string): CheckpointEntry {
    const row = this.store.db.prepare("SELECT data, turn_id, point FROM checkpoints WHERE id=?").get(id);
    if (!row) throw new Error("Checkpoint not found");
    return { record: JSON.parse(String(row.data)) as CheckpointRecord, ...(row.turn_id ? { turnId: String(row.turn_id) } : {}), point: row.point === null || row.point === undefined ? null : JSON.parse(String(row.point)) as JsonValue };
  }
  /** Newest first. */
  list(nodeId: string): CheckpointRecord[] {
    return this.store.db.prepare("SELECT data FROM checkpoints WHERE node_id=? ORDER BY rowid DESC").all(nodeId).map((row) => JSON.parse(String(row.data)) as CheckpointRecord);
  }
  async changes(id: string): Promise<CheckpointChangesResponse> {
    const { record } = this.get(id);
    if (!record.files || !this.shadow) throw new CheckpointError("这个检查点没有文件快照");
    return { files: await this.shadow.changes(record.files.cwd, record.files.ref) };
  }
  async restore(record: CheckpointRecord): Promise<FileChange[]> {
    if (!record.files || !this.shadow) throw new CheckpointError("这个检查点没有文件快照");
    return this.shadow.restore(record.files.cwd, record.files.ref);
  }
  /** Text prepended to the node's next prompt (replayed transcript, file-restore notice). */
  addPreamble(nodeId: string, text: string): void {
    const current = this.preamble(nodeId);
    this.store.db.prepare("INSERT INTO node_preambles VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET text=excluded.text").run(nodeId, current ? `${current}\n\n${text}` : text);
  }
  setPreamble(nodeId: string, text: string): void {
    this.store.db.prepare("INSERT INTO node_preambles VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET text=excluded.text").run(nodeId, text);
  }
  preamble(nodeId: string): string | undefined {
    const row = this.store.db.prepare("SELECT text FROM node_preambles WHERE node_id=?").get(nodeId);
    return row ? String(row.text) : undefined;
  }
  clearPreamble(nodeId: string): void { this.store.db.prepare("DELETE FROM node_preambles WHERE node_id=?").run(nodeId); }
}

const REPLAY_BUDGET = 24_000;
const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}…[${text.length - max} more characters]` : text;
/**
 * A compact transcript of a node's conversation for an agent without native rewind: a fresh provider
 * session gets it ahead of the human's next message, so the conversation continues from the
 * checkpoint. Long histories keep the first exchange and the most recent part.
 */
export function replayPrompt(rows: ItemRecord[]): string | undefined {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.rolledBack) continue;
    const item = row.item;
    if (item.type === "user_message") {
      if (item.delivery === "queued" || item.delivery === "retracted") continue;
      lines.push(`[${item.delivery ? "human" : "baton"}] ${clip(item.text, 4000)}`);
    } else if (item.type === "assistant_message") lines.push(`[you] ${clip(item.text, 4000)}`);
    else if (item.type === "tool_call") lines.push(`[tool ${item.status}] ${item.name}${item.detail.type === "shell" ? `: ${clip(item.detail.command, 300)}` : "filePath" in item.detail ? `: ${item.detail.filePath}` : ""}`);
    else if (item.type === "error") lines.push(`[error] ${clip(item.message, 500)}`);
  }
  if (!lines.length) return undefined;
  let body = lines.join("\n");
  if (body.length > REPLAY_BUDGET) {
    const head = lines.slice(0, 2).join("\n").slice(0, 4000), tail: string[] = [];
    let size = head.length;
    for (const line of [...lines.slice(2)].reverse()) { if (size + line.length + 1 > REPLAY_BUDGET) break; tail.unshift(line); size += line.length + 1; }
    body = `${head}\n[… ${lines.length - 2 - tail.length} earlier entries omitted …]\n${tail.join("\n")}`;
  }
  return `<baton-replay>\nThe human rolled this conversation back to an earlier point, so it continues in a new session. This is the conversation so far (your earlier replies are marked [you]). Continue from it; do not repeat work it already describes.\n${body}\n</baton-replay>`;
}
