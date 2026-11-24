import { representedQuestion } from "./questions.js";
import type { ItemRecord, NodeRecord, RunSnapshot, Usage } from "@baton/protocol";

export type Delivery = "turn" | "steered" | "queued" | "retracted";
export type MessageAction = "steer" | "interrupt" | "retract";
export type MessageControl = "steer" | "interrupt" | "edit";
export interface MessageActionState { pending?: MessageAction | "edit"; steerUnsupported?: boolean; error?: string }
export function messageActionKey(nodeId: string, itemSeq: number): string { return `${nodeId}:${itemSeq}`; }
/** Sending follows a ladder: queued → try steering → interrupt. */
export function messageActions(delivery: Delivery | undefined, state?: MessageActionState): MessageControl[] {
  if (delivery === "queued") return [state?.steerUnsupported ? "interrupt" : "steer", "edit"];
  return delivery === "steered" ? ["interrupt"] : [];
}
export interface OutgoingMessage {
  clientId: string; nodeId: string; text: string; ts: string;
  state: "sending" | "accepted" | "failed"; delivery?: Delivery; itemSeq?: number; interrupted?: boolean; error?: string;
  turnId?: string; queuePosition?: number; deliveryOrder?: number; editedAt?: string; steeredAfterSeq?: number;
  acknowledged?: boolean;
}
const outgoingMaxAge = 120_000;
export function outgoingMatches(message: OutgoingMessage, row: ItemRecord): boolean {
  if (row.nodeId !== message.nodeId || row.item.type !== "user_message") return false;
  if (row.item.clientId === message.clientId || row.seq === message.itemSeq) return true;
  if (row.item.clientId || message.itemSeq !== undefined) return false;
  return row.item.text === message.text && Math.abs(Date.parse(row.ts) - Date.parse(message.ts)) <= outgoingMaxAge;
}
export function reconcileOutgoing(messages: OutgoingMessage[], row: ItemRecord): OutgoingMessage[] {
  const item = row.item;
  if (item.type !== "user_message") return messages;
  const exact = messages.findIndex(message => message.nodeId === row.nodeId && (item.clientId === message.clientId || row.seq === message.itemSeq));
  const index = exact >= 0 ? exact : messages.findIndex(message => !message.acknowledged && outgoingMatches(message, row));
  return messages.map((message, i) => i === index
    ? { ...message, state: "accepted", acknowledged: true, text: item.text, ts: row.ts, itemSeq: row.seq, delivery: item.delivery ?? message.delivery, interrupted: item.interrupted, turnId: row.turnId ?? message.turnId, queuePosition: item.queuePosition, deliveryOrder: item.deliveryOrder, editedAt: item.editedAt, steeredAfterSeq: item.steeredAfterSeq, error: undefined } : message);
}
/** Persisted rows replace optimistic entries; stale in-flight entries must not keep a run alive. */
export function pruneOutgoing(messages: OutgoingMessage[], rows: ItemRecord[], now: number): OutgoingMessage[] {
  const reconciled = rows.reduce(reconcileOutgoing, messages);
  return reconciled.filter(message => !(message.acknowledged && rows.some(row => outgoingMatches(message, row))) && now - Date.parse(message.ts) <= outgoingMaxAge);
}
export function inFlightMessage(messages: OutgoingMessage[], rows: ItemRecord[], nodeId: string, now: number): OutgoingMessage | undefined {
  return rows.reduce(reconcileOutgoing, messages).findLast(message => message.nodeId === nodeId && message.state === "sending" && !message.acknowledged && now >= Date.parse(message.ts) && now - Date.parse(message.ts) < 30_000);
}
export function deliveryLabel(delivery?: Delivery, interrupted = false): string {
  return delivery === "queued" ? "排队中" : delivery === "steered" ? "已插入当前回合" : delivery === "retracted" ? "已撤回" : delivery === "turn" ? interrupted ? "已中断并立即发送" : "已送达" : "";
}
export interface ConversationEntry { row: ItemRecord; outgoing?: OutgoingMessage }
export function messageRows(rows: ItemRecord[], outgoing: OutgoingMessage[], nodeId: string): ConversationEntry[] {
  const messages = rows.reduce(reconcileOutgoing, outgoing).filter(message => message.nodeId === nodeId);
  const result = rows.filter(row => row.nodeId === nodeId).map(row => ({ row, outgoing: messages.find(message => row.item.type === "user_message" && (row.item.clientId === message.clientId || row.seq === message.itemSeq)) }));
  for (const [index, message] of messages.entries()) if (!result.some(entry => entry.outgoing?.clientId === message.clientId)) result.push({ row: { seq: message.itemSeq ?? -(index + 1), nodeId, turnId: message.turnId, ts: message.ts, item: { type: "user_message", text: message.text, clientId: message.clientId, delivery: message.delivery, interrupted: message.interrupted, queuePosition: message.queuePosition, deliveryOrder: message.deliveryOrder, editedAt: message.editedAt, steeredAfterSeq: message.steeredAfterSeq } }, outgoing: message });
  return result;
}

export function conversationRows(rows: ItemRecord[], outgoing: OutgoingMessage[], nodeId: string): ConversationEntry[] {
  const anchored: Array<{ entry: ConversationEntry; after: number }> = [];
  const visible = messageRows(rows, outgoing, nodeId).filter(entry => {
    const item = entry.row.item;
    if (item.type !== "user_message") return true;
    if (item.delivery === "steered" && item.steeredAfterSeq !== undefined) { anchored.push({ entry, after: item.steeredAfterSeq }); return false; }
    return item.delivery !== "queued" && item.delivery !== "retracted";
  });
  const startsTurn = ({ row }: ConversationEntry) => row.item.type === "user_message" && row.item.delivery === "turn" && row.turnId !== undefined;
  const isSteered = ({ row }: ConversationEntry) => row.item.type === "user_message" && row.item.delivery === "steered" && row.turnId !== undefined;
  const starting = new Map<string, ConversationEntry[]>();
  const steered = new Map<string, ConversationEntry[]>();
  for (const entry of visible) if (startsTurn(entry)) {
    const group = starting.get(entry.row.turnId!) ?? []; group.push(entry); starting.set(entry.row.turnId!, group);
  } else if (isSteered(entry)) {
    const group = steered.get(entry.row.turnId!) ?? []; group.push(entry); steered.set(entry.row.turnId!, group);
  }
  const deliveryOrder = (row: ItemRecord) => row.item.type === "user_message" ? row.item.deliveryOrder ?? row.seq : row.seq;
  for (const group of starting.values()) group.sort((a, b) => deliveryOrder(a.row) - deliveryOrder(b.row) || a.row.seq - b.row.seq);
  // A replaced message keeps its original itemSeq, which may precede the old turn's final output.
  const result: ConversationEntry[] = []; const emitted = new Set<string>();
  const rest = visible.filter(entry => !startsTurn(entry) && !isSteered(entry));
  const first = new Set<string>(); const last = new Map<string, number>();
  rest.forEach((entry, index) => { if (entry.row.turnId) last.set(entry.row.turnId, index); });
  for (const [index, entry] of rest.entries()) {
    if (entry.row.turnId && !first.has(entry.row.turnId)) {
      const group = starting.get(entry.row.turnId);
      if (group) { result.push(...group); emitted.add(entry.row.turnId); }
      first.add(entry.row.turnId);
    }
    result.push(entry);
    if (entry.row.turnId && last.get(entry.row.turnId) === index) { result.push(...steered.get(entry.row.turnId) ?? []); steered.delete(entry.row.turnId); }
    // A newly started turn may not have any output yet. Place it after older persisted rows.
    if (index === rest.length - 1) for (const [id, group] of starting) if (!emitted.has(id) && !last.has(id)) { result.push(...group); emitted.add(id); }
  }
  for (const [id, group] of starting) if (!emitted.has(id)) result.push(...group);
  for (const group of steered.values()) result.push(...group);
  const provisional = (entry: ConversationEntry) => entry.outgoing !== undefined && !entry.outgoing.acknowledged && !entry.row.turnId;
  return [...placeSteered(result.filter(entry => !provisional(entry)), anchored), ...result.filter(provisional)];
}

function placeSteered(base: ConversationEntry[], anchored: Array<{ entry: ConversationEntry; after: number }>): ConversationEntry[] {
  if (!anchored.length) return base;
  const positions = new Map(base.map(({ row }, index) => [row.seq, index]));
  const bySeq = new Set(anchored.map(record => record.entry.row.seq));
  const gaps = new Map<number, ConversationEntry[]>(), followers = new Map<number, ConversationEntry[]>();
  for (const { entry, after } of anchored.sort((left, right) => left.entry.row.seq - right.entry.row.seq)) {
    const chained = bySeq.has(after) && after !== entry.row.seq;
    const groups = chained ? followers : gaps;
    const exact = positions.get(after);
    const gap = chained ? after : exact !== undefined ? exact + 1 : base.findIndex(({ row }) => row.seq > after);
    const key = gap < 0 ? base.length : gap;
    const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group);
  }
  const rendered = new Set<number>(), result: ConversationEntry[] = [];
  const append = (entry: ConversationEntry) => {
    if (rendered.has(entry.row.seq)) return;
    rendered.add(entry.row.seq); result.push(entry); followers.get(entry.row.seq)?.forEach(append);
  };
  base.forEach((entry, index) => { gaps.get(index)?.forEach(append); append(entry); });
  gaps.get(base.length)?.forEach(append);
  for (const { entry, after } of anchored) {
    if (rendered.has(entry.row.seq)) continue;
    const slot = result.findIndex(({ row }) => row.seq > Math.max(entry.row.seq, after));
    const start = result.length; append(entry);
    if (slot >= 0) result.splice(slot, 0, ...result.splice(start));
  }
  return result;
}

function queuePosition(row: ItemRecord): number { return row.item.type === "user_message" ? row.item.queuePosition ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER; }
export function queuedRows(rows: ItemRecord[], outgoing: OutgoingMessage[], nodeId: string, order?: number[]): ConversationEntry[] {
  const rank = new Map(order?.map((seq, index) => [seq, index]));
  return messageRows(rows, outgoing, nodeId).filter(({ row }) => row.item.type === "user_message" && row.item.delivery === "queued")
    .sort((a, b) => (rank.get(a.row.seq) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.row.seq) ?? Number.MAX_SAFE_INTEGER) || queuePosition(a.row) - queuePosition(b.row) || Date.parse(a.row.ts) - Date.parse(b.row.ts) || (a.row.seq > 0 && b.row.seq > 0 ? a.row.seq - b.row.seq : 0));
}

/** Move to a slot in the original list (0 = before first, length = after last). */
export function queueDropOrder(order: number[], itemSeq: number, slot: number): number[] {
  const from = order.indexOf(itemSeq); if (from < 0) return order;
  const target = Math.max(0, Math.min(order.length, slot));
  const next = order.filter(seq => seq !== itemSeq); next.splice(target > from ? target - 1 : target, 0, itemSeq); return next;
}
export function queueMoveOrder(order: number[], itemSeq: number, offset: -1 | 1): number[] {
  const from = order.indexOf(itemSeq); if (from < 0 || from + offset < 0 || from + offset >= order.length) return order;
  return queueDropOrder(order, itemSeq, offset === 1 ? from + 2 : from - 1);
}
export function queueDropSlot(y: number, bounds: { top: number; height: number }[]): number {
  const index = bounds.findIndex(rect => y < rect.top + rect.height / 2); return index < 0 ? bounds.length : index;
}
export function activeTurn(snapshot: RunSnapshot, nodeId: string) { return snapshot.turns.filter(turn => turn.nodeId === nodeId && turn.status === "running").at(-1); }
export function nodeIsLive(snapshot: RunSnapshot, node: NodeRecord): boolean {
  return snapshot.run.status !== "paused" && Boolean(activeTurn(snapshot, node.id));
}
export function quietSeconds(now: number, lastEventAt: number): number { return Math.max(0, Math.floor((now - lastEventAt) / 1000)); }
interface TimedConversationPhase {
  kind: "waiting" | "reasoning" | "tool" | "reply" | "permission" | "question" | "children" | "interrupted";
  label: string; since: string; toolSince?: string; reasoning?: string; related: string[]; quiet: number; tokens?: number;
}
export type ConversationPhase = TimedConversationPhase | { kind: "idle_children"; label: string; related: string[] };
export function usageTokens(usage?: Usage): number | undefined {
  return usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined) ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : undefined;
}
export function conversationPhase(snapshot: RunSnapshot, node: NodeRecord, rows: ItemRecord[], now: number, lastEventAt?: number, sending?: OutgoingMessage): ConversationPhase | null {
  if (snapshot.run.status === "paused") return null;
  const turn = activeTurn(snapshot, node.id);
  const children = snapshot.delegations.filter(edge => edge.fromNodeId === node.id && ["queued", "running", "waiting_permission", "waiting_children"].includes(edge.status));
  const permissions = snapshot.permissions.filter(permission => permission.nodeId === node.id && permission.status === "pending" && !representedQuestion(permission, snapshot.questions));
  const questions = snapshot.questions.filter(question => question.nodeId === node.id && question.status === "pending");
  const inFlight = sending && inFlightMessage([sending], rows, node.id, now);
  if (!turn && !children.length && !inFlight && !questions.length && !permissions.length) return null;
  const relatedChildren = () => children.map(edge => edge.toNodeId).filter(id => snapshot.nodes.some(entry => entry.id === id));
  if (!turn && children.length && !inFlight && !questions.length && !permissions.length) {
    return { kind: "idle_children", label: `空闲 · 等待 ${children.length} 个子任务，结果送达后自动继续`, related: relatedChildren() };
  }
  const since = turn?.startedAt ?? inFlight?.ts ?? questions[0]?.askedAt ?? permissions[0]?.requestedAt ?? children[0]?.createdAt ?? node.updatedAt;
  const lastOutputAt = lastEventAt ?? rows.reduce((latest, row) => Math.max(latest, Date.parse(row.ts)), Date.parse(since));
  const turnRows = rows.filter(row => (row.item.type !== "user_message" || !["queued", "retracted"].includes(row.item.delivery ?? "")) && (turn ? row.turnId === turn.id || (!row.turnId && Date.parse(row.ts) >= Date.parse(turn.startedAt)) : Date.parse(row.ts) >= Date.parse(since)));
  const latest = turnRows.at(-1);
  const phase: ConversationPhase = { kind: "waiting", label: "已发送，等待响应…", since, related: [], quiet: quietSeconds(now, lastOutputAt), tokens: usageTokens(turn?.usage) };
  const interrupted = snapshot.turns.findLast(entry => entry.nodeId === node.id && entry.status === "canceled" && entry.error === "interrupted by human message");
  const interruptedAt = Date.parse(interrupted?.endedAt ?? "");
  if (interrupted && now >= interruptedAt && now - interruptedAt < 5000) return { ...phase, kind: "interrupted", label: "已中断，正在处理你的新消息" };
  if (permissions.length) return { ...phase, kind: "permission", label: "等待授权", related: [node.id] };
  if (questions.length) return { ...phase, kind: "question", label: "等你回答", related: questions.map(question => question.id) };
  if (!turn) return phase;
  const tool = snapshot.toolSpans.filter(span => span.nodeId === node.id && span.status === "running" && (span.turnId === turn.id || !span.turnId && Date.parse(span.startedAt) >= Date.parse(turn.startedAt))).at(-1);
  if (tool) {
    const toolRow = rows.findLast(row => row.item.type === "tool_call" && row.item.callId === tool.callId);
    const detail = toolRow?.item.type === "tool_call" ? toolRow.item.detail : undefined;
    const summary = tool.summary ?? (detail?.type === "shell" ? detail.command : tool.name);
    return { ...phase, kind: "tool", label: `正在执行 ${tool.kind}: ${summary}`, toolSince: tool.startedAt };
  }
  if (latest?.item.type === "tool_call" && latest.item.status === "running") return { ...phase, kind: "tool", label: `正在执行 ${latest.item.detail.type}: ${latest.item.name}`, toolSince: latest.ts };
  if (latest?.item.type === "reasoning") return { ...phase, kind: "reasoning", label: "思考中", reasoning: latest.item.text };
  if (latest?.item.type === "assistant_message") return { ...phase, kind: "reply", label: "正在回复…" };
  if (children.length) return { ...phase, kind: "children", label: `等待 ${children.length} 个子任务`, related: relatedChildren() };
  return phase;
}

export function phaseTimerLabel(phase: Pick<ConversationPhase, "kind">): string {
  return phase.kind === "children" ? "等待" : "本轮";
}
