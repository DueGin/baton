/** 回退 on a human message (DESIGN §4.13): 回退会话 / 回退文件 / 回退会话和文件, with a file preview and a confirmation. */
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { CheckpointRecord, ItemRecord, RollbackMode, RollbackResponse } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { checkpointFor, confirmText, fileStatusLabels, rollbackChoices, rollbackLabels, type ChangesState, type RollbackChoice } from "../lib/rollback.js";
import { Icon } from "./common.js";
import "./rollback.css";

export interface RollbackProps {
  client: BatonClient; nodeId: string;
  /** The node's transcript rows (maps batched messages to their turn's checkpoint). */
  rows: ItemRecord[];
  rollback: (checkpointId: string, mode: RollbackMode) => Promise<RollbackResponse>;
  done: (response: RollbackResponse) => void;
}
/** The server's message without the HTTP status and JSON wrapper. */
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message.replace(/^\d{3} · /, "") : String(error);
  try { const parsed: unknown = JSON.parse(text); if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") return parsed.message; } catch { /* plain text */ }
  return text;
}

export function RollbackAction({ row, ...props }: RollbackProps & { row: ItemRecord }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = (focus = true) => { setOpen(false); if (focus) container.current?.querySelector<HTMLButtonElement>(".message-action-rollback")?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div ref={container} className="rollback-anchor" onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); event.preventDefault(); close(); } }}>
    <button type="button" className={`icon-button message-action-rollback${open ? " is-open" : ""}`} aria-label="回退" title="回退到这条消息之前" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}><Icon name="undo" size={15} /></button>
    {open && <RollbackPanel row={row} {...props} close={close} />}
  </div>;
}

function RollbackPanel({ row, client, nodeId, rows, rollback, done, close }: RollbackProps & { row: ItemRecord; close: (focus?: boolean) => void }) {
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[] | { error: string }>();
  const [changes, setChanges] = useState<ChangesState>();
  const [confirm, setConfirm] = useState<RollbackMode>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    client.checkpoints(nodeId).then(response => { if (live) setCheckpoints(response.checkpoints); }, (reason: unknown) => { if (live) setCheckpoints({ error: errorText(reason) }); });
    return () => { live = false; };
  }, [client, nodeId]);
  const checkpoint = Array.isArray(checkpoints) ? checkpointFor(row, rows, checkpoints) : undefined;
  const snapshotId = checkpoint?.files ? checkpoint.id : undefined;
  useEffect(() => {
    if (!snapshotId) return;
    let live = true; setChanges({ status: "loading" });
    client.checkpointChanges(snapshotId).then(response => { if (live) setChanges({ status: "ready", files: response.files }); }, (reason: unknown) => { if (live) setChanges({ status: "error", message: errorText(reason) }); });
    return () => { live = false; };
  }, [client, snapshotId]);
  // Open upwards when the transcript has no room below for the menu and its file list (the last messages).
  useLayoutEffect(() => {
    const element = panel.current, anchor = element?.parentElement, scroll = element?.closest(".transcript-scroll");
    if (!element || !anchor || !scroll) return;
    const box = anchor.getBoundingClientRect(), bounds = scroll.getBoundingClientRect(), below = bounds.bottom - box.bottom, above = box.top - bounds.top;
    if (below < 340 && above > below) element.classList.add("opens-up");
    element.focus({ preventScroll: true });
  }, []);
  const run = async () => {
    if (!checkpoint || !confirm) return;
    setBusy(true); setError(undefined);
    try { const response = await rollback(checkpoint.id, confirm); close(false); done(response); }
    catch (reason) { setError(errorText(reason)); setBusy(false); }
  };
  return <RollbackMenuView panel={panel} loading={!checkpoints} loadError={checkpoints && !Array.isArray(checkpoints) ? checkpoints.error : undefined}
    choices={rollbackChoices(row, checkpoint, changes)} changes={changes} confirm={confirm} busy={busy} error={error}
    choose={mode => { setError(undefined); setConfirm(mode); }} back={() => { setError(undefined); setConfirm(undefined); }} run={() => { void run(); }} close={() => close()} />;
}

const choiceIcons = { conversation: "chat", files: "folder", both: "undo" } as const;
export function RollbackMenuView({ panel, loading, loadError, choices, changes, confirm, busy = false, error, choose, back, run, close }: {
  panel?: Ref<HTMLDivElement>; loading: boolean; loadError?: string; choices: RollbackChoice[]; changes?: ChangesState; confirm?: RollbackMode; busy?: boolean; error?: string;
  choose: (mode: RollbackMode) => void; back: () => void; run: () => void; close: () => void;
}) {
  const files = changes?.status === "ready" ? changes.files : [];
  return <div ref={panel} className="rollback-menu" role="dialog" aria-label="回退到这条消息之前" tabIndex={-1}>
    <header><strong>{confirm ? rollbackLabels[confirm] : "回退到这条消息之前"}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={close}><Icon name="close" size={13} /></button></header>
    {loading ? <p className="rollback-note">正在读取检查点…</p>
      : loadError ? <p className="rollback-note error-text" role="alert">{loadError}</p>
      : confirm ? <div className="rollback-confirm">
        <p>{confirmText(confirm, changes)}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="rollback-confirm-actions"><button type="button" className="button small subtle" disabled={busy} onClick={back}>返回</button><button type="button" className="button small danger rollback-run" disabled={busy} onClick={run}>{busy ? "回退中…" : `确认${rollbackLabels[confirm]}`}</button></div>
      </div>
      : <>
        <div className="rollback-choices" role="menu">{choices.map(choice => <button key={choice.mode} type="button" role="menuitem" className={`rollback-choice rollback-choice-${choice.mode}`} disabled={Boolean(choice.disabled)} aria-disabled={Boolean(choice.disabled)} title={choice.disabled ?? choice.detail} onClick={() => choose(choice.mode)}>
          <Icon name={choiceIcons[choice.mode]} size={14} /><span><strong>{choice.label}</strong>{(choice.disabled ?? choice.detail) && <small>{choice.disabled ?? choice.detail}</small>}</span>
        </button>)}</div>
        {files.length > 0 && <details className="rollback-files"><summary>查看会改变的文件（{files.length}）</summary><ul>{files.map(file => <li key={file.path}><span className={`rollback-file-status is-${file.status}`}>{fileStatusLabels[file.status]}</span><code title={file.path}>{file.path}</code></li>)}</ul></details>}
      </>}
  </div>;
}

/** Slim bar standing in for a run of rolled-back rows; reveals them greyed out. */
export function RolledBackToggle({ count, open, toggle }: { count: number; open: boolean; toggle: () => void }) {
  return <button type="button" className={`rolled-back-toggle${open ? " is-open" : ""}`} aria-expanded={open} onClick={toggle}><Icon name="undo" size={12} /><span>已回退 {count} 条消息</span><span className="rolled-back-toggle-action">· {open ? "隐藏" : "显示"}</span></button>;
}
