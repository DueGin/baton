import { applyEvent, type ItemRecord, type NodeRecord, type RunEventEnvelope, type RunSnapshot, type UpdateNodeConfigRequest } from "@baton/protocol";
import { conversationRows, messageActionKey, pruneOutgoing, queuedRows, reconcileOutgoing, type MessageAction, type MessageActionState, type OutgoingMessage } from "./lib/conversation.js";
import { HttpError, type BatonClient } from "./api.js";
import { queueEditError } from "./lib/queue-editor.js";

export type ConnectionState = "loading" | "live" | "reconnecting" | "offline";
export interface ConsoleState {
  snapshot: RunSnapshot | null;
  items: Record<string, ItemRecord[]>;
  itemStatus: Record<string, "loading" | "ready" | "error">;
  outgoing: OutgoingMessage[];
  messageActions: Record<string, MessageActionState>;
  queues: Record<string, { pending: boolean; order?: number[]; error?: string }>;
  lastEventAt: Record<string, number>;
  connection: ConnectionState;
  error: string | null;
}
const initial = (): ConsoleState => ({ snapshot: null, items: {}, itemStatus: {}, outgoing: [], messageActions: {}, queues: {}, lastEventAt: {}, connection: "loading", error: null });

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
  private acknowledged = new Set<string>();
  constructor(readonly client: BatonClient) {}
  getSnapshot = (): ConsoleState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<ConsoleState>): void { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }

  async open(id: string): Promise<void> {
    this.close();
    const generation = this.generation;
    this.update(initial());
    this.acknowledged.clear();
    try {
      const snapshot = await this.client.run(id);
      if (generation !== this.generation) return;
      this.update({ snapshot, outgoing: pruneOutgoing(this.state.outgoing, Object.values(this.state.items).flat(), Date.now()) });
      this.connect(id, generation, 0);
    } catch (error) {
      if (generation === this.generation) this.update({ connection: "offline", error: errorText(error) });
    }
  }

  close(): void { this.generation++; this.controller?.abort(); clearTimeout(this.retry); }
  updateNodeConfig = async (nodeId: string, request: UpdateNodeConfigRequest) => {
    const generation = this.generation, before = this.state.snapshot?.nodes.find(node => node.id === nodeId);
    const response = await this.client.updateNodeConfig(nodeId, request);
    const snapshot = this.state.snapshot, current = snapshot?.nodes.find(node => node.id === nodeId);
    if (generation === this.generation && snapshot && before && current) {
      const patch: Partial<NodeRecord> = {};
      for (const key of ["model", "modeId", "thinking"] as const) {
        if (current[key] === before[key] && current[key] !== response.node[key]) patch[key] = response.node[key];
      }
      if (Object.keys(patch).length) this.update({ snapshot: { ...snapshot, nodes: snapshot.nodes.map(node => node.id === nodeId ? { ...node, ...patch } : node) } });
    }
    return response;
  };
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
      patch.outgoing = reconcileOutgoing(this.state.outgoing, { seq: event.itemSeq, nodeId: event.nodeId, turnId: event.turnId, ts: event.itemTs, item: event.item });
      this.rememberAcknowledgements(patch.outgoing);
      const key = messageActionKey(event.nodeId, event.itemSeq);
      if (event.item.type === "user_message" && this.state.messageActions[key]) patch.messageActions = { ...this.state.messageActions, [key]: { ...this.state.messageActions[key], error: undefined, ...(event.item.delivery !== "queued" ? { steerUnsupported: false } : {}) } };
    }
    if (event.type === "item" && this.state.itemStatus[event.nodeId]) {
      const row: ItemRecord = { seq: event.itemSeq, nodeId: event.nodeId, turnId: event.turnId, ts: event.itemTs, item: event.item, ...(event.rolledBack ? { rolledBack: true } : {}) };
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
      const allRows = [...Object.entries(this.state.items).flatMap(([id, items]) => id === nodeId ? [] : items), ...rows];
      this.rememberAcknowledgements(allRows.reduce(reconcileOutgoing, this.state.outgoing));
      this.update({ outgoing: pruneOutgoing(this.state.outgoing, allRows, Date.now()), items: { ...this.state.items, [nodeId]: rows }, itemStatus: { ...this.state.itemStatus, [nodeId]: "ready" } });
    } catch (error) {
      if (generation === this.generation) this.update({ itemStatus: { ...this.state.itemStatus, [nodeId]: "error" }, error: errorText(error) });
    }
  }

  async reorderQueue(nodeId: string, order: number[]): Promise<void> {
    if (this.state.queues[nodeId]?.pending) return;
    const generation = this.generation;
    const before = new Map((this.state.items[nodeId] ?? []).map(row => [row.seq, row]));
    this.update({ queues: { ...this.state.queues, [nodeId]: { pending: true, order } } });
    try {
      const response = await this.client.reorderQueue(nodeId, { order });
      if (generation !== this.generation) return;
      const current = queuedRows(this.state.items[nodeId] ?? [], this.state.outgoing, nodeId).map(entry => entry.row.seq);
      if (current.length === response.order.length && current.every(seq => response.order.includes(seq))) {
        const positions = new Map(response.order.map((seq, index) => [seq, index + 1]));
        const rows = (this.state.items[nodeId] ?? []).map(row => row === before.get(row.seq) && row.item.type === "user_message" && row.item.delivery === "queued" && positions.has(row.seq) ? { ...row, item: { ...row.item, queuePosition: positions.get(row.seq)! } } : row);
        this.update({ items: { ...this.state.items, [nodeId]: rows }, outgoing: rows.reduce(reconcileOutgoing, this.state.outgoing.map(message => message.nodeId === nodeId && message.delivery === "queued" && message.itemSeq !== undefined && !rows.some(row => row.seq === message.itemSeq) && positions.has(message.itemSeq) ? { ...message, queuePosition: positions.get(message.itemSeq)! } : message)) });
      }
      this.update({ queues: { ...this.state.queues, [nodeId]: { pending: false } } });
    } catch (error) {
      if (generation !== this.generation) return;
      const conflict = error instanceof HttpError && error.status === 409;
      this.update({ queues: { ...this.state.queues, [nodeId]: { pending: conflict, error: conflict ? "队列已变化，正在刷新…" : errorText(error) } } });
      if (conflict) await this.loadItems(nodeId, true);
      if (generation !== this.generation) return;
      this.update({ queues: { ...this.state.queues, [nodeId]: { pending: false, error: conflict ? this.state.itemStatus[nodeId] === "error" ? "队列已变化，刷新失败，请重试。" : "队列已变化，已刷新，请重新排序。" : errorText(error) } } });
    }
  }

  async sendMessage(nodeId: string, text: string, retryId?: string): Promise<void> {
    const generation = this.generation;
    const clientId = retryId ?? crypto.randomUUID();
    const existing = this.state.outgoing.find(message => message.clientId === clientId);
    const message: OutgoingMessage = { ...existing, clientId, nodeId, text, ts: new Date().toISOString(), state: "sending", acknowledged: false, error: undefined };
    this.update({ outgoing: [...this.state.outgoing.filter(row => row.clientId !== clientId), message] });
    try {
      const response = await this.client.send(nodeId, text, clientId, "queue");
      if (generation !== this.generation) return;
      const accepted = this.state.outgoing.map(row => row.clientId === clientId ? { ...row, state: "accepted" as const, itemSeq: response.itemSeq, delivery: row.delivery && row.delivery !== "queued" ? row.delivery : response.delivery } : row);
      const reconciled = (this.state.items[nodeId] ?? []).reduce(reconcileOutgoing, accepted);
      this.rememberAcknowledgements(reconciled);
      this.update({ outgoing: reconciled });
    } catch (error) {
      if (generation !== this.generation) return;
      // An SSE acknowledgement is authoritative even if the HTTP response was lost.
      this.update({ outgoing: this.state.outgoing.map(row => row.clientId === clientId && row.state !== "accepted" && !this.acknowledged.has(clientId) ? { ...row, state: "failed", error: errorText(error) } : row) });
    }
  }
  private rememberAcknowledgements(messages: OutgoingMessage[]): void {
    messages.filter(message => message.acknowledged).forEach(message => this.acknowledged.add(message.clientId));
  }

  async editMessage(nodeId: string, itemSeq: number, text: string): Promise<boolean> {
    const key = messageActionKey(nodeId, itemSeq);
    if (this.state.messageActions[key]?.pending || itemSeq <= 0) return false;
    const previous = this.state.messageActions[key];
    const setAction = (patch: MessageActionState) => this.update({ messageActions: { ...this.state.messageActions, [key]: patch } });
    const validation = queueEditError(text);
    if (validation) { setAction({ ...previous, error: validation }); return false; }
    const generation = this.generation;
    const before = this.state.items[nodeId]?.find(row => row.seq === itemSeq);
    const outgoingBefore = this.state.outgoing.find(row => row.nodeId === nodeId && row.itemSeq === itemSeq);
    setAction({ ...previous, pending: "edit", error: undefined });
    try {
      await this.client.edit(nodeId, itemSeq, { text });
      if (generation !== this.generation) return false;
      const current = this.state.items[nodeId]?.find(row => row.seq === itemSeq);
      if (current && current === before && current.item.type === "user_message" && current.item.delivery === "queued") {
        const row: ItemRecord = { ...current, item: { ...current.item, text, editedAt: new Date().toISOString() } };
        this.update({ items: { ...this.state.items, [nodeId]: mergeItems(this.state.items[nodeId] ?? [], [row]) }, outgoing: reconcileOutgoing(this.state.outgoing, row) });
      } else if (!current && outgoingBefore) {
        this.update({ outgoing: this.state.outgoing.map(row => row === outgoingBefore ? { ...row, text, editedAt: new Date().toISOString() } : row) });
      }
      setAction({ ...previous, error: undefined }); return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      const latest = this.state.items[nodeId]?.find(row => row.seq === itemSeq)?.item;
      if (latest?.type === "user_message" && latest.text === text && latest.editedAt && (before?.item.type !== "user_message" || before.item.editedAt !== latest.editedAt)) {
        setAction({ ...previous, error: undefined }); return true; // Durable SSE acknowledgement wins over a lost HTTP response.
      }
      const conflict = error instanceof HttpError && error.status === 409;
      if (conflict) await this.loadItems(nodeId, true);
      if (generation !== this.generation) return false;
      const message = conflict ? "已送达，无法修改" : errorText(error);
      setAction({ ...previous, error: message });
      // The row can leave the dock during this request; keep the conflict visible at the dock level.
      if (conflict) this.update({ queues: { ...this.state.queues, [nodeId]: { ...this.state.queues[nodeId], pending: this.state.queues[nodeId]?.pending ?? false, error: message } } });
      return false;
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
    const anchor = action === "steer" ? conversationRows(this.state.items[nodeId] ?? [], this.state.outgoing, nodeId).findLast(({ row }) => row.seq > 0 && !row.rolledBack)?.row.seq ?? 0 : undefined;
    const setAction = (patch: MessageActionState) => this.update({ messageActions: { ...this.state.messageActions, [key]: patch } });
    setAction({ ...previous, pending: action, error: undefined });
    try {
      const response = action === "retract" ? await this.client.retract(nodeId, itemSeq).then(() => undefined) : await this.client.deliver(nodeId, itemSeq, { mode: action });
      if (generation !== this.generation) return;
      const delivery = response ? response.delivery : "retracted";
      const current = this.state.items[nodeId]?.find(row => row.seq === itemSeq);
      // SSE replacements are authoritative; provide an immediate fallback when HTTP arrives first.
      if (current && current === before && current.item.type === "user_message") {
        const row: ItemRecord = { ...current, item: { ...current.item, delivery, queuePosition: delivery === "queued" ? current.item.queuePosition : undefined, ...(interruptsTurn && delivery === "turn" ? { interrupted: true } : {}), ...(action === "steer" && delivery === "steered" ? { escalated: true, steeredAfterSeq: anchor } : {}) } };
        this.update({ items: { ...this.state.items, [nodeId]: mergeItems(this.state.items[nodeId] ?? [], [row]) }, outgoing: reconcileOutgoing(this.state.outgoing, row) });
      } else if (!current && outgoingBefore) {
        this.update({ outgoing: this.state.outgoing.map(row => row === outgoingBefore ? { ...row, delivery, steeredAfterSeq: delivery === "steered" ? anchor : undefined, interrupted: interruptsTurn && delivery === "turn" } : row) });
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
