import type { ItemRecord, NodeRecord, RunSnapshot } from "@baton/protocol";

export type Delivery = "turn" | "steered" | "queued" | "retracted";
export type MessageAction = "steer" | "interrupt" | "retract";
export interface MessageActionState { pending?: MessageAction; steerUnsupported?: boolean; error?: string }
export function messageActionKey(nodeId: string, itemSeq: number): string { return `${nodeId}:${itemSeq}`; }
/** Sending follows a ladder: queued → try steering → interrupt. */
export function messageActions(delivery: Delivery | undefined, state?: MessageActionState): MessageAction[] {
  if (delivery === "queued") return [state?.steerUnsupported ? "interrupt" : "steer", "retract"];
  return delivery === "steered" ? ["interrupt"] : [];
}
export interface OutgoingMessage {
  clientId: string; nodeId: string; text: string; ts: string;
  state: "sending" | "accepted" | "failed"; delivery?: Delivery; itemSeq?: number; interrupted?: boolean; error?: string;
}
export function reconcileOutgoing(messages: OutgoingMessage[], row: ItemRecord): OutgoingMessage[] {
  const item = row.item;
  if (item.type !== "user_message") return messages;
  return messages.map(message => message.nodeId === row.nodeId && (item.clientId === message.clientId || row.seq === message.itemSeq)
    ? { ...message, state: "accepted", itemSeq: row.seq, delivery: item.delivery ?? message.delivery, interrupted: item.interrupted, error: undefined } : message);
}
export function deliveryLabel(delivery?: Delivery, interrupted = false): string {
  return delivery === "queued" ? "排队中" : delivery === "steered" ? "已插入当前回合" : delivery === "retracted" ? "已撤回" : delivery === "turn" ? interrupted ? "已中断并立即发送" : "已送达" : "";
}
export function conversationRows(rows: ItemRecord[], outgoing: OutgoingMessage[], nodeId: string): { row: ItemRecord; outgoing?: OutgoingMessage }[] {
  const messages = outgoing.filter(message => message.nodeId === nodeId);
  const result = rows.map(row => ({ row, outgoing: messages.find(message => row.item.type === "user_message" && (row.item.clientId === message.clientId || row.seq === message.itemSeq)) }));
  for (const [index, message] of messages.entries()) if (!result.some(entry => entry.outgoing?.clientId === message.clientId)) result.push({ row: { seq: message.itemSeq ?? -(index + 1), nodeId, ts: message.ts, item: { type: "user_message", text: message.text, clientId: message.clientId, delivery: message.delivery, interrupted: message.interrupted } }, outgoing: message });
  return result;
}
export function activeTurn(snapshot: RunSnapshot, nodeId: string) { return snapshot.turns.filter(turn => turn.nodeId === nodeId && turn.status === "running").at(-1); }
export function nodeIsLive(snapshot: RunSnapshot, node: NodeRecord): boolean {
  return !["canceled", "completed", "failed", "replaced"].includes(node.status) && (Boolean(activeTurn(snapshot, node.id)) || ["starting", "running", "waiting_permission"].includes(node.status));
}
export function quietSeconds(now: number, lastEventAt: number): number { return Math.max(0, Math.floor((now - lastEventAt) / 1000)); }
export interface ConversationPhase {
  kind: "waiting" | "reasoning" | "tool" | "reply" | "permission" | "question" | "children" | "interrupted";
  label: string; since: string; toolSince?: string; reasoning?: string; related: string[]; quiet: number; tokens: number;
}
export function conversationPhase(snapshot: RunSnapshot, node: NodeRecord, rows: ItemRecord[], now: number, lastEventAt?: number, sendingAt?: string): ConversationPhase | null {
  if (["canceled", "replaced", "failed", "completed"].includes(node.status) && !sendingAt) return null;
  const turn = activeTurn(snapshot, node.id);
  const children = snapshot.delegations.filter(edge => edge.fromNodeId === node.id && ["queued", "running", "waiting_permission", "waiting_children"].includes(edge.status));
  if (!nodeIsLive(snapshot, node) && !children.length && !sendingAt && !snapshot.questions.some(question => question.nodeId === node.id && question.status === "pending" && question.blocking)) return null;
  const since = turn?.startedAt ?? sendingAt ?? node.updatedAt;
  const lastOutputAt = lastEventAt ?? rows.reduce((latest, row) => Math.max(latest, Date.parse(row.ts)), Date.parse(since));
  const turnRows = rows.filter(row => turn ? row.turnId === turn.id || (!row.turnId && Date.parse(row.ts) >= Date.parse(turn.startedAt)) : Date.parse(row.ts) >= Date.parse(since));
  const latest = turnRows.at(-1);
  const phase: ConversationPhase = { kind: "waiting", label: "已发送，等待响应…", since, related: [], quiet: quietSeconds(now, lastOutputAt), tokens: node.usage.inputTokens + node.usage.outputTokens };
  const interrupted = snapshot.turns.findLast(entry => entry.nodeId === node.id && entry.status === "canceled" && entry.error === "interrupted by human message");
  const interruptedAt = Date.parse(interrupted?.endedAt ?? "");
  if (interrupted && now >= interruptedAt && now - interruptedAt < 5000) return { ...phase, kind: "interrupted", label: "已中断，正在处理你的新消息" };
  if (snapshot.permissions.some(permission => permission.nodeId === node.id && permission.status === "pending")) return { ...phase, kind: "permission", label: "等待授权", related: [node.id] };
  if (snapshot.questions.some(question => question.nodeId === node.id && question.status === "pending" && question.blocking)) return { ...phase, kind: "question", label: "等你回答", related: [node.id] };
  const tool = snapshot.toolSpans.filter(span => span.nodeId === node.id && span.status === "running").at(-1);
  if (tool) {
    const toolRow = rows.findLast(row => row.item.type === "tool_call" && row.item.callId === tool.callId);
    const detail = toolRow?.item.type === "tool_call" ? toolRow.item.detail : undefined;
    const summary = tool.summary ?? (detail?.type === "shell" ? detail.command : tool.name);
    return { ...phase, kind: "tool", label: `正在执行 ${tool.kind}: ${summary}`, toolSince: tool.startedAt };
  }
  if (latest?.item.type === "tool_call" && latest.item.status === "running") return { ...phase, kind: "tool", label: `正在执行 ${latest.item.detail.type}: ${latest.item.name}`, toolSince: latest.ts };
  if (!turn && children.length) return { ...phase, kind: "children", label: `等待 ${children.length} 个子任务`, related: children.map(edge => edge.toNodeId).filter(id => snapshot.nodes.some(entry => entry.id === id)) };
  if (latest?.item.type === "reasoning") return { ...phase, kind: "reasoning", label: "思考中", reasoning: latest.item.text };
  if (latest?.item.type === "assistant_message") return { ...phase, kind: "reply", label: "正在回复…" };
  if (children.length) return { ...phase, kind: "children", label: `等待 ${children.length} 个子任务`, related: children.map(edge => edge.toNodeId).filter(id => snapshot.nodes.some(entry => entry.id === id)) };
  return phase;
}

export function phaseTimerLabel(phase: Pick<ConversationPhase, "kind">): string {
  return phase.kind === "children" ? "等待" : "本轮";
}
