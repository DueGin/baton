import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { clock } from "../lib/derive.js";
import { messageActionKey, queueDropOrder, queueDropSlot, queueMoveOrder, type ConversationEntry, type MessageAction, type MessageActionState } from "../lib/conversation.js";
import { QueueMessageEditor } from "./QueueMessageEditor.js";
import { Icon } from "./common.js";
import { DeliveryIcon, EditedMarker, MessageActionIcons } from "./MessageActions.js";

interface Props {
  entries: ConversationEntry[];
  actions: Record<string, MessageActionState>;
  pending?: boolean;
  error?: string;
  reorder: (order: number[]) => void;
  act: (itemSeq: number, action: MessageAction) => Promise<void> | void;
  edit: (itemSeq: number, text: string) => Promise<boolean>;
}
interface Drag { seq: number; pointer: number; y: number; slot: number; moved: boolean }
export function QueueDock({ entries, actions, pending = false, error, reorder, act, edit }: Props) {
  const [open, setOpen] = useState(true); const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null); const dragging = useRef<Drag | null>(null);
  const list = useRef<HTMLDivElement>(null); const id = useId();
  useEffect(() => { if (editing !== null && !entries.some(({ row }) => row.seq === editing)) setEditing(null); }, [entries, editing]);
  const order = entries.map(entry => entry.row.seq);
  const locked = editing !== null || pending || entries.some(({ row, outgoing }) => row.seq <= 0 || outgoing?.state === "sending" || Boolean(actions[messageActionKey(row.nodeId, row.seq)]?.pending));
  const change = (next: number[]) => { if (!locked && next.some((seq, index) => order[index] !== seq)) reorder(next); };
  const endDrag = (event: PointerEvent<HTMLButtonElement>, canceled = false) => {
    const value = dragging.current;
    if (!value || value.pointer !== event.pointerId) return;
    dragging.current = null; setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!canceled && value.moved) change(queueDropOrder(order, value.seq, value.slot));
  };
  if (!entries.length && !error) return null;
  return <section className={`queue-dock${drag?.moved ? " queue-dragging" : ""}`} aria-label="排队消息" aria-busy={pending}>
    <div className="queue-dock-heading"><button type="button" className="queue-dock-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><span className={`queue-chevron${open ? " expanded" : ""}`}><Icon name="chevron" size={12} /></span><Icon name="clock" size={13} /><span>当前回合结束后，这 {entries.length} 条消息会按顺序合并发送</span></button>{pending && <span className="queue-saving" role="status"><Icon name="refresh" size={12} />排序中</span>}</div>
    {error && <div className="queue-error error-text" role="alert">{error}</div>}
    {open && <div className="queue-dock-list" id={id} ref={list} role="list" aria-label="待发送顺序">{entries.map(({ row, outgoing }, index) => {
      if (row.item.type !== "user_message") return null;
      const action = actions[messageActionKey(row.nodeId, row.seq)]; const isExpanded = expanded.has(row.seq);
      return <div key={outgoing?.clientId ?? row.seq} data-queue-seq={row.seq} role="listitem" className={`queue-card${drag?.seq === row.seq && drag.moved ? " is-dragging" : ""}${drag?.moved && drag.slot === index ? " drop-before" : ""}${drag?.moved && drag.slot === entries.length && index === entries.length - 1 ? " drop-after" : ""}`}>
        <div className="queue-reorder-controls"><button type="button" className="icon-button queue-drag-handle" aria-label={`拖动第 ${index + 1} 条排队消息`} title="拖动排序；也可用上移/下移按钮或方向键" disabled={locked} onKeyDown={event => { if (event.key === "Escape") { dragging.current = null; setDrag(null); } else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); change(queueMoveOrder(order, row.seq, event.key === "ArrowUp" ? -1 : 1)); } }} onPointerDown={event => {
          if (locked || event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
          const value = { seq: row.seq, pointer: event.pointerId, y: event.clientY, slot: index, moved: false }; dragging.current = value; setDrag(value);
        }} onPointerMove={event => {
          const current = dragging.current; if (!current || current.pointer !== event.pointerId) return;
          const container = list.current; if (!container) return;
          const rect = container.getBoundingClientRect();
          if (event.clientY < rect.top + 24) container.scrollTop -= 10; else if (event.clientY > rect.bottom - 24) container.scrollTop += 10;
          const bounds = [...container.querySelectorAll<HTMLElement>("[data-queue-seq]")].map(card => card.getBoundingClientRect());
          const value = { ...current, moved: current.moved || Math.abs(event.clientY - current.y) > 4, slot: queueDropSlot(event.clientY, bounds) }; dragging.current = value; setDrag(value);
        }} onPointerUp={event => endDrag(event)} onPointerCancel={event => endDrag(event, true)} onLostPointerCapture={() => { dragging.current = null; setDrag(null); }}><Icon name="grip" size={15} /></button><div className="queue-step-controls"><button type="button" className="icon-button" aria-label={`上移第 ${index + 1} 条排队消息`} title="上移" disabled={locked || index === 0} onClick={() => change(queueMoveOrder(order, row.seq, -1))}><Icon name="up" size={12} /></button><button type="button" className="icon-button" aria-label={`下移第 ${index + 1} 条排队消息`} title="下移" disabled={locked || index === entries.length - 1} onClick={() => change(queueMoveOrder(order, row.seq, 1))}><Icon name="down" size={12} /></button></div></div>
        <div className="queue-card-main">{editing === row.seq ? <QueueMessageEditor text={row.item.text} busy={Boolean(action?.pending)} error={action?.error} save={text => edit(row.seq, text)} cancel={() => setEditing(null)} remove={async () => { await act(row.seq, "retract"); }} /> : <button type="button" className={`queue-card-text${isExpanded ? " expanded" : ""}`} aria-label={isExpanded ? "收起消息全文" : "展开消息全文"} aria-expanded={isExpanded} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(row.seq)) next.delete(row.seq); else next.add(row.seq); return next; })}>{row.item.text}</button>}<div className="queue-card-meta"><span className="queue-position">{index + 1}</span><DeliveryIcon delivery="queued" state={outgoing?.state} /><time dateTime={row.ts}>{clock(row.ts)}</time><EditedMarker at={row.item.editedAt} />{action?.steerUnsupported && <span className="queue-unsupported" role="status">该 agent 不支持引导</span>}{action?.error && editing !== row.seq && <span className="error-text" role="alert">{action.error}</span>}</div></div>
        {editing !== row.seq && <MessageActionIcons delivery="queued" state={action} disabled={editing !== null || pending || Boolean(drag?.moved) || row.seq <= 0 || outgoing?.state === "sending"} act={value => { if (value === "edit") setEditing(row.seq); else void act(row.seq, value); }} retract={() => { void act(row.seq, "retract"); }} />}

      </div>;
    })}</div>}
  </section>;
}
