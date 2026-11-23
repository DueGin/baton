import { useEffect, useState } from "react";
import { deliveryLabel, messageActions, type Delivery, type MessageControl, type MessageActionState } from "../lib/conversation.js";
import { Icon } from "./common.js";

export function DeliveryIcon({ delivery, interrupted, state }: { delivery?: Delivery; interrupted?: boolean; state?: "sending" | "accepted" | "failed" }) {
  const label = state === "sending" ? "发送中" : state === "failed" ? "发送失败" : deliveryLabel(delivery, interrupted);
  if (!label) return null;
  const name = state === "sending" ? "refresh" : state === "failed" ? "warning" : delivery === "queued" ? "clock" : delivery === "steered" ? "steer" : delivery === "retracted" ? "undo" : interrupted ? "lightning" : "check";
  return <span className={`delivery-icon delivery-${delivery ?? state}${state === "sending" ? " is-spinning" : ""}`} title={delivery === "queued" ? "排队中 · 当前回合结束后送达" : label} role="img" aria-label={label}><Icon name={name} size={13} /></span>;
}

function DeleteQueuedButton({ disabled, remove }: { disabled: boolean; remove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const timeout = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(timeout);
  }, [confirm]);
  return <button type="button" className={confirm ? "queue-confirm-delete" : "icon-button message-action-retract"}
    aria-label={confirm ? "确认删除？" : "删除排队消息"} title={confirm ? "再次点击确认删除，Esc 取消" : "删除这条排队消息"} disabled={disabled}
    onBlur={() => setConfirm(false)} onKeyDown={event => { if (confirm && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setConfirm(false); } }}
    onClick={event => { if (confirm) { setConfirm(false); remove(); } else { event.currentTarget.focus(); setConfirm(true); } }}>{confirm ? "确认删除？" : <Icon name="trash" size={15} />}</button>;
}

export function MessageActionIcons({ delivery, state, disabled = false, act, retract }: { delivery?: Delivery; state?: MessageActionState; disabled?: boolean; act: (action: MessageControl) => void; retract?: () => void }) {
  const labels = { steer: "引导发送", interrupt: "立即发送", edit: "编辑" };
  const icons = { steer: "steer", interrupt: "lightning", edit: "edit" } as const;
  return <div className="message-action-icons" aria-busy={Boolean(state?.pending)}>{messageActions(delivery, state).map(action => <button type="button" className={`icon-button message-action-${action}`} key={action} aria-label={labels[action]} disabled={disabled || Boolean(state?.pending)} onClick={() => act(action)} title={action === "interrupt" ? "立即发送 · 中断当前回合，立即以这条消息开始新一轮" : action === "steer" ? "引导发送 · 将这条消息插入当前回合" : "编辑这条排队消息"}><span className={state?.pending === action ? "message-action-spinner" : undefined}><Icon name={state?.pending === action ? "refresh" : icons[action]} size={15} /></span></button>)}{delivery === "queued" && retract && <DeleteQueuedButton disabled={disabled || Boolean(state?.pending)} remove={retract} />}</div>;
}

export function EditedMarker({ at }: { at?: string }) {
  return at ? <span className="message-edited" title={`已编辑 · ${new Date(at).toLocaleString("zh-CN")}`}><Icon name="edit" size={10} />已编辑</span> : null;
}
