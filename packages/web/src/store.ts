import { applyEvent, type ItemRecord, type RunEventEnvelope, type RunSnapshot } from "@baton/protocol";
import { reconcileOutgoing, type OutgoingMessage } from "./lib/conversation.js";
import type { BatonClient } from "./api.js";

export type ConnectionState = "loading" | "live" | "reconnecting" | "offline";
export interface ConsoleState {
  snapshot: RunSnapshot | null;
  items: Record<string, ItemRecord[]>;
  itemStatus: Record<string, "loading" | "ready" | "error">;
  outgoing: OutgoingMessage[];
  lastEventAt: Record<string, number>;
  connection: ConnectionState;
  error: string | null;
}
const initial = (): ConsoleState => ({ snapshot: null, items: {}, itemStatus: {}, outgoing: [], lastEventAt: {}, connection: "loading", error: null });

export function mergeItems(existing: ItemRecord[], incoming: ItemRecord[]): ItemRecord[] {
  const bySeq = new Map(existing.map(item => [item.seq, item]));
  for (const item of incoming) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export class RunStore {
  private state = initial();
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private generation = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly client: BatonClient) {}
  getSnapshot = (): ConsoleState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<ConsoleState>): void { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }

  async open(id: string): Promise<void> {
    this.close();
    const generation = this.generation;
    this.update(initial());
    try {
      const snapshot = await this.client.run(id);
      if (generation !== this.generation) return;
      this.update({ snapshot });
      this.connect(id, generation, 0);
    } catch (error) {
      if (generation === this.generation) this.update({ connection: "offline", error: errorText(error) });
    }
  }

  close(): void { this.generation++; this.controller?.abort(); clearTimeout(this.retry); }
  apply = (event: RunEventEnvelope): void => {
    const snapshot = this.state.snapshot;
    if (!snapshot || snapshot.run.id !== event.runId || event.seq <= snapshot.lastSeq) return;
    const patch: Partial<ConsoleState> = { snapshot: applyEvent(snapshot, event), connection: "live", error: null };
    const nodeId = event.type === "item" || event.type === "node.updated" ? event.nodeId
      : event.type === "tool.span" ? event.span.nodeId
      : event.type === "turn.started" ? event.turn.nodeId
      : event.type === "turn.updated" ? snapshot.turns.find(turn => turn.id === event.turnId)?.nodeId
      : event.type === "permission" ? event.permission.nodeId
      : event.type === "question" ? event.question.nodeId
      : event.type === "escalation" ? event.escalation.nodeId : undefined;
    if (nodeId) patch.lastEventAt = { ...this.state.lastEventAt, [nodeId]: Date.parse(event.ts) };
    if (event.type === "item") patch.outgoing = reconcileOutgoing(this.state.outgoing, { seq: event.itemSeq, nodeId: event.nodeId, ts: event.ts, item: event.item });
    if (event.type === "item" && this.state.itemStatus[event.nodeId]) {
      const row: ItemRecord = { seq: event.itemSeq, nodeId: event.nodeId, turnId: event.turnId, ts: event.ts, item: event.item };
      patch.items = { ...this.state.items, [event.nodeId]: mergeItems(this.state.items[event.nodeId] ?? [], [row]) };
    }
    this.update(patch);
  };

  async loadItems(nodeId: string, force = false): Promise<void> {
    if (!force && this.state.itemStatus[nodeId]) return;
    const generation = this.generation;
    this.update({ itemStatus: { ...this.state.itemStatus, [nodeId]: "loading" } });
    try {
      const result = await this.client.items(nodeId);
      if (generation !== this.generation) return;
      // Live events received during fetch win over rows in the response.
      const rows = mergeItems(result.items, this.state.items[nodeId] ?? []);
      this.update({ outgoing: rows.reduce(reconcileOutgoing, this.state.outgoing), items: { ...this.state.items, [nodeId]: rows }, itemStatus: { ...this.state.itemStatus, [nodeId]: "ready" } });
    } catch (error) {
      if (generation === this.generation) this.update({ itemStatus: { ...this.state.itemStatus, [nodeId]: "error" }, error: errorText(error) });
    }
  }

  async sendMessage(nodeId: string, text: string, retryId?: string): Promise<void> {
    const generation = this.generation;
    const clientId = retryId ?? crypto.randomUUID();
    const existing = this.state.outgoing.find(message => message.clientId === clientId);
    const message: OutgoingMessage = { ...existing, clientId, nodeId, text, ts: existing?.ts ?? new Date().toISOString(), state: "sending", error: undefined };
    this.update({ outgoing: [...this.state.outgoing.filter(row => row.clientId !== clientId), message] });
    try {
      const response = await this.client.send(nodeId, text, clientId);
      if (generation !== this.generation) return;
      this.update({ outgoing: this.state.outgoing.map(row => row.clientId === clientId ? { ...row, state: "accepted", itemSeq: response.itemSeq, delivery: row.delivery === "turn" ? "turn" : response.delivery, wasQueued: row.wasQueued || response.delivery === "queued" } : row) });
    } catch (error) {
      if (generation !== this.generation) return;
      // An SSE acknowledgement is authoritative even if the HTTP response was lost.
      this.update({ outgoing: this.state.outgoing.map(row => row.clientId === clientId && row.state !== "accepted" ? { ...row, state: "failed", error: errorText(error) } : row) });
    }
  }

  private connect(id: string, generation: number, attempt: number): void {
    if (generation !== this.generation) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.update({ connection: attempt ? "reconnecting" : "live" });
    void this.client.events(id, this.state.snapshot?.lastSeq ?? 0, this.apply, signal).then(() => {
      if (!signal.aborted) throw new Error("事件连接已断开，正在重连");
    }).catch((error: unknown) => {
      if (signal.aborted || generation !== this.generation) return;
      this.update({ connection: "reconnecting", error: errorText(error) });
      this.retry = setTimeout(() => this.connect(id, generation, attempt + 1), Math.min(1000 * 2 ** attempt, 15000));
    });
  }
}

export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
