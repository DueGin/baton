import { useId, useRef, useState } from "react";
import { queueEditError, queueEditKey } from "../lib/queue-editor.js";
import { Icon } from "./common.js";
import { Modal } from "./TeamForms.js";

export function QueueMessageEditor({ text, busy, error, save, cancel, remove }: {
  text: string; busy: boolean; error?: string;
  save: (text: string) => Promise<boolean>; cancel: () => void; remove: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(text); const [validation, setValidation] = useState<string>();
  const [saving, setSaving] = useState(false); const [confirm, setConfirm] = useState(false);
  const sending = useRef(false); const id = useId();
  const disabled = busy || saving;
  const submit = async () => {
    if (disabled || sending.current) return;
    const issue = queueEditError(draft); setValidation(issue); if (issue) return;
    sending.current = true; setSaving(true);
    try { if (await save(draft)) cancel(); }
    finally { sending.current = false; setSaving(false); }
  };
  return <div className="queue-message-editor" aria-busy={disabled}>
    <textarea autoFocus aria-label="编辑排队消息" aria-describedby={id} aria-invalid={Boolean(validation)} rows={3} value={draft} disabled={disabled} onChange={event => { setDraft(event.target.value); setValidation(undefined); }} onKeyDown={event => {
      const action = queueEditKey(event.key, event.shiftKey, event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229);
      if (action === "cancel" && !disabled) { event.preventDefault(); event.stopPropagation(); cancel(); }
      if (action === "save") { event.preventDefault(); void submit(); }
    }} />
    <div className="queue-editor-toolbar"><span id={id} className="queue-editor-hint">Enter 保存 · Shift+Enter 换行 · Esc 取消</span><div className="queue-editor-actions">
      <button type="button" className="icon-button queue-delete" title="删除这条" aria-label="删除这条" disabled={disabled} onClick={() => setConfirm(true)}><Icon name="trash" size={15} /></button>
      <button type="button" className="icon-button" title="取消编辑 · Esc" aria-label="取消编辑" disabled={disabled} onClick={cancel}><Icon name="close" size={15} /></button>
      <button type="button" className="icon-button queue-save" title="保存 · Enter" aria-label="保存" disabled={disabled || !draft.trim()} onClick={() => { void submit(); }}><span className={disabled ? "message-action-spinner" : undefined}><Icon name={disabled ? "refresh" : "check"} size={15} /></span></button>
    </div></div>
    {(validation || error) && <div className="error-text queue-edit-error" role="alert">{validation ?? error}</div>}
    {confirm && <DeleteQueuedMessage busy={disabled} error={error} close={() => { if (!disabled) setConfirm(false); }} remove={async () => { if (sending.current || disabled) return; sending.current = true; setSaving(true); try { await remove(); setConfirm(false); } finally { sending.current = false; setSaving(false); } }} />}
  </div>;
}

export function DeleteQueuedMessage({ busy, error, close, remove }: { busy: boolean; error?: string; close: () => void; remove: () => Promise<void> }) {
  return <Modal title="删除这条排队消息？" close={close}><p>删除后，这条消息不会送达 agent。</p>{error && <div className="error-panel" role="alert">{error}</div>}<div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={close}>保留</button><button type="button" className="button danger" aria-label="确认删除" disabled={busy} onClick={() => { void remove(); }}>{busy ? "删除中…" : "确认删除"}</button></div></Modal>;
}
