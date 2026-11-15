import { applyEvent, type ItemRecord, type RunEventEnvelope, type RunSnapshot } from "@baton/protocol";
import { messageActionKey, reconcileOutgoing, type MessageAction, type MessageActionState, type OutgoingMessage } from "./lib/conversation.js";
import { HttpError, type BatonClient } from "./api.js";

export type ConnectionState = "loading" | "live" | "reconnecting" | "offline";
export interface ConsoleState {
  snapshot: RunSnapshot | null;
  items: Record<string, ItemRecord[]>;
  itemStatus: Record<string, "loading" | "ready" | "error">;
  outgoing: OutgoingMessage[];
  messageActions: Record<string, MessageActionState>;
  lastEventAt: Record<string, number>;
  connection: ConnectionState;
  error: string | null;
}
const initial = (): ConsoleState => ({ snapshot: null, items: {}, itemStatus: {}, outgoing: [], messageActions: {}, lastEventAt: {}, connection: "loading", error: null });

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
    if (event.type === "item") {
      patch.outgoing = reconcileOutgoing(this.state.outgoing, { seq: event.itemSeq, nodeId: event.nodeId, ts: event.ts, item: event.item });
      const key = messageActionKey(event.nodeId, event.itemSeq);
      if (event.item.type === "user_message" && this.state.messageActions[key]) patch.messageActions = { ...this.state.messageActions, [key]: { ...this.state.messageActions[key], error: undefined, ...(event.item.delivery !== "queued" ? { steerUnsupported: false } : {}) } };
    }
    if (event.type === "item" && this.state.itemStatus[event.nodeId]) {
      const row: ItemRecord = { seq: event.itemSeq, nodeId: event.nodeId, turnId: event.turnId, ts: event.ts, item: event.item };
      patch.items = { ...this.state.items, [event.nodeId]: mergeItems(this.state.items[event.nodeId] ?? [], [row]) };
    }
    this.update(patch);
  };

  async loadItems(nodeId: string, force = false): Promise<void> {
    if (!force && this.state.itemStatus[nodeId]) return;
    const generation = this.generation;
    const before = new Map((this.state.items[nodeId] ?? []).map(row => [row.seq, row]));
    this.update({ itemStatus: { ...this.state.itemStatus, [nodeId]: "loading" } });
    try {
      const result = await this.client.items(nodeId);
      if (generation !== this.generation) return;
      // Live events received during fetch win over rows in the response.
      const streamed = (this.state.items[nodeId] ?? []).filter(row => before.get(row.seq) !== row);
      const rows = mergeItems(mergeItems(this.state.items[nodeId] ?? [], result.items), streamed);
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
      const response = await this.client.send(nodeId, text, clientId, "queue");
      if (generation !== this.generation) return;
      this.update({ outgoing: this.state.outgoing.map(row => row.clientId === clientId ? { ...row, state: "accepted", itemSeq: response.itemSeq, delivery: row.delivery && row.delivery !== "queued" ? row.delivery : response.delivery } : row) });
    } catch (error) {
      if (generation !== this.generation) return;
      // An SSE acknowledgement is authoritative even if the HTTP response was lost.
      this.update({ outgoing: this.state.outgoing.map(row => row.clientId === clientId && row.state !== "accepted" ? { ...row, state: "failed", error: errorText(error) } : row) });
    }
  }

  async actOnMessage(nodeId: string, itemSeq: number, action: MessageAction): Promise<void> {
    const key = messageActionKey(nodeId, itemSeq);
    if (this.state.messageActions[key]?.pending || itemSeq <= 0) return;
    const generation = this.generation;
    const previous = this.state.messageActions[key];
    const before = this.state.items[nodeId]?.find(row => row.seq === itemSeq);
    const outgoingBefore = this.state.outgoing.find(row => row.nodeId === nodeId && row.itemSeq === itemSeq);
    const interruptsTurn = action === "interrupt" && this.state.snapshot?.turns.some(turn => turn.nodeId === nodeId && turn.status === "running") === true;
    const setAction = (patch: MessageActionState) => this.update({ messageActions: { ...this.state.messageActions, [key]: patch } });
    setAction({ ...previous, pending: action, error: undefined });
    try {
      const response = action === "retract" ? await this.client.retract(nodeId, itemSeq).then(() => undefined) : await this.client.deliver(nodeId, itemSeq, { mode: action });
      if (generation !== this.generation) return;
      const delivery = response ? response.delivery : "retracted";
      const current = this.state.items[nodeId]?.find(row => row.seq === itemSeq);
      // SSE replacements are authoritative; provide an immediate fallback when HTTP arrives first.
      if (current && current === before && current.item.type === "user_message") {
        const row: ItemRecord = { ...current, item: { ...current.item, delivery, ...(interruptsTurn && delivery === "turn" ? { interrupted: true } : {}), ...(action === "steer" && delivery === "steered" ? { escalated: true } : {}) } };
        this.update({ items: { ...this.state.items, [nodeId]: mergeItems(this.state.items[nodeId] ?? [], [row]) }, outgoing: reconcileOutgoing(this.state.outgoing, row) });
      } else if (!current && outgoingBefore) {
        this.update({ outgoing: this.state.outgoing.map(row => row === outgoingBefore ? { ...row, delivery, interrupted: interruptsTurn && delivery === "turn" } : row) });
      }
      const latestDelivery = this.state.items[nodeId]?.find(row => row.seq === itemSeq)?.item;
      setAction({ steerUnsupported: response?.steerUnsupported === true && (!latestDelivery || latestDelivery.type === "user_message" && latestDelivery.delivery === "queued") });
    } catch (error) {
      if (generation !== this.generation) return;
      const latest = this.state.items[nodeId]?.find(row => row.seq === itemSeq)?.item;
      const delivery = latest?.type === "user_message" ? latest.delivery : this.state.outgoing.find(row => row.nodeId === nodeId && row.itemSeq === itemSeq)?.delivery;
      if (action === "retract" && delivery === "retracted" || action === "steer" && delivery === "steered" || action === "interrupt" && delivery === "turn") {
        setAction({}); return; // SSE acknowledgement wins even if the HTTP response was lost.
      }
      const conflict = error instanceof HttpError && error.status === 409;
      if (conflict) await this.loadItems(nodeId, true);
      if (generation !== this.generation) return;
      setAction({ ...previous, error: conflict ? this.state.itemStatus[nodeId] === "error" ? "消息状态已变化，刷新失败，请重试加载会话。" : "消息状态已变化，已刷新。" : errorText(error) });
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
