import { useEffect, useId, useRef, useState } from "react";
import type { BackgroundProcess, CancelRunRequest, RunSnapshot } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { attributionDescriptions, backgroundPorts, backgroundStatusLabels, backgroundSummary } from "../lib/background.js";
import { clock, duration } from "../lib/derive.js";
import { errorText } from "../store.js";
import { AgentMark, Icon, Toggle } from "./common.js";
import { CopyButton } from "./CopyButton.js";
import { Modal } from "./TeamForms.js";
import { useDismiss } from "../lib/dismiss.js";

function Ports({ ports }: { ports: number[] }) { return <>{backgroundPorts(ports).map(port => <a className="background-port" key={port} href={`http://localhost:${port}`} target="_blank" rel="noopener noreferrer">:{port} ↗</a>)}</>; }
export function BackgroundPill({ snapshot, open, controls, onClick }: { snapshot: RunSnapshot; open: boolean; controls: string; onClick: () => void }) {
  const summary = backgroundSummary(snapshot);
  return summary.count ? <button type="button" className={`background-pill${summary.hasPorts ? " has-ports" : ""}`} aria-expanded={open} aria-controls={controls} aria-haspopup="dialog" title={summary.hasPorts ? "本会话有服务正在监听端口" : "查看本会话的后台进程"} onClick={onClick}><Icon name="server" size={13} />后台 {summary.count}</button> : null;
}
export function BackgroundList({ snapshot, now, client, compact = false, projectName }: { snapshot: RunSnapshot; now: number; client?: BatonClient; compact?: boolean; projectName?: string }) {
  const { active, exited } = backgroundSummary(snapshot);
  const [confirm, setConfirm] = useState<BackgroundProcess | null>(null); const [stopping, setStopping] = useState<Set<string>>(new Set()); const [dismissing, setDismissing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>(); const [requesting, setRequesting] = useState(false);
  useEffect(() => { setStopping(current => { const next = new Set([...current].filter(id => snapshot.backgroundProcesses?.some(process => process.id === id && process.status !== "exited"))); return next.size === current.size ? current : next; }); }, [snapshot.backgroundProcesses]);
  const stop = async () => {
    if (!confirm || !client) return; const id = confirm.id; setRequesting(true); setError(undefined); setStopping(current => new Set([...current, id]));
    try { await client.stopBackground(id); setConfirm(null); } catch (cause) { setStopping(current => { const next = new Set(current); next.delete(id); return next; }); setError(errorText(cause)); } finally { setRequesting(false); }
  };
  const dismiss = async (id: string) => {
    if (!client) return; setError(undefined); setDismissing(current => new Set([...current, id]));
    try { await client.dismissBackground(id, { dismissed: true }); } catch (cause) { setError(errorText(cause)); } finally { setDismissing(current => { const next = new Set(current); next.delete(id); return next; }); }
  };
  const row = (process: BackgroundProcess) => {
    const node = snapshot.nodes.find(node => node.id === process.nodeId); const status = stopping.has(process.id) && process.status !== "exited" ? "stopping" : process.status;
    return <article key={process.id} className={`background-entry background-${status}`}><div className="background-command-row"><i className={`background-dot ${status}`} title={backgroundStatusLabels[status]} /><code title={process.command}>{process.command}</code><span className="background-state">{backgroundStatusLabels[status]}</span></div>
      {process.ports.length > 0 && <div className="background-ports"><Ports ports={process.ports} /></div>}
      <div className="background-owner" title={attributionDescriptions[process.attribution]}>{node ? <><AgentMark agent={node.agentId} small /><span title={node.title}>{node.title}</span><small>{node.role ?? (node.parentNodeId ? node.agentId : "Lead")}</small></> : <span>启动节点未知</span>}{process.attribution === "inferred" && <span className="attribution-badge">推断</span>}<span className="attribution-help" aria-label={attributionDescriptions[process.attribution]} tabIndex={0}>ⓘ</span></div>
      <div className="background-meta"><span>{process.status === "exited" ? "存活" : "已运行"} {duration(process.startedAt, process.exitedAt ?? now)}</span><span>pid {process.pid}</span>{process.status === "exited" && <span title={process.exitedAt ? new Date(process.exitedAt).toLocaleString("zh-CN") : "退出时间未知"}>退出 {process.exitedAt ? clock(process.exitedAt) : "—"}{process.stoppedBy === "human" ? " · 由你停止" : " · 自行退出"}</span>}</div>
      {process.cwd && <div className="background-cwd"><code title={process.cwd}>{process.cwd}</code><CopyButton text={process.cwd} label="复制 cwd" /></div>}
      {process.children.length > 0 && <details className="background-children"><summary>子进程 {process.children.length} 个</summary>{process.children.map(child => <div key={child.pid}><code title={child.command}>{child.command}</code><small>pid {child.pid}</small><Ports ports={child.ports} /></div>)}</details>}
      <div className="background-actions">{process.status !== "exited" && <button type="button" className="text-button danger-text" disabled={!client || status === "stopping"} onClick={() => { setError(undefined); setConfirm(process); }}>{status === "stopping" ? "停止中…" : "停止"}</button>}<CopyButton text={process.command} label="复制命令" /><button type="button" className="text-button" disabled={!client || dismissing.has(process.id)} onClick={() => { void dismiss(process.id); }}>{dismissing.has(process.id) ? "隐藏中…" : "不是本会话启动的"}</button></div>
    </article>;
  };
  return <div className={`background-list${compact ? " is-compact" : ""}`}><div className="background-run-context">{projectName && <strong>{projectName} / </strong>}{snapshot.run.title}</div>{active.map(row)}{!active.length && <p className="muted background-empty">没有运行中的后台进程</p>}
    {exited.length > 0 && <details className="background-exited"><summary>已退出 {exited.length} 个</summary>{exited.map(row)}</details>}
    {error && !confirm && <div className="error-panel" role="alert">{error}</div>}
    {confirm && <Modal title="停止后台进程" close={() => { if (!requesting) setConfirm(null); }}><p>停止这个进程及其折叠的子进程？</p><code className="background-confirm-command">{confirm.command}</code><p className="muted">pid {confirm.pid}{confirm.ports.length > 0 ? ` · 端口 ${confirm.ports.join(", ")}` : ""} · 先尝试正常退出，5 秒后仍在运行则强制停止。</p>{error && <div className="error-panel" role="alert">{error}</div>}<div className="dialog-footer"><button type="button" className="button" disabled={requesting} onClick={() => setConfirm(null)}>返回</button><button type="button" className="button danger" disabled={requesting} onClick={() => { void stop(); }}>{requesting ? "停止中…" : "确认停止"}</button></div></Modal>}
  </div>;
}
export function BackgroundPopover({ snapshot, now, client, projectName }: { snapshot: RunSnapshot; now: number; client: BatonClient; projectName?: string }) {
  const [open, setOpen] = useState(false); const id = useId(); const container = useRef<HTMLDivElement>(null); const panel = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); container.current?.querySelector<HTMLButtonElement>(".background-pill")?.focus(); };
  useEffect(() => { if (open) panel.current?.focus(); }, [open]);
  useDismiss(open, container, reason => { if (reason === "escape") close(); else setOpen(false); }, () => Boolean(document.querySelector("dialog[open]")));
  return <div ref={container} className="background-popover-anchor" onKeyDown={event => { if (event.key === "Escape" && !document.querySelector("dialog[open]")) { event.stopPropagation(); event.preventDefault(); close(); } }}><BackgroundPill snapshot={snapshot} open={open} controls={id} onClick={() => setOpen(value => !value)} />{open && <div ref={panel} id={id} role="dialog" aria-label="本会话的后台进程" tabIndex={-1} className="background-popover"><header><strong>后台进程</strong><small>本 Run 的所有 agent</small><button type="button" className="icon-button" aria-label="关闭后台进程" onClick={close}><Icon name="close" size={14} /></button></header><BackgroundList projectName={projectName} snapshot={snapshot} now={now} client={client} /></div>}</div>;
}
export function CancelRunDialog({ snapshot, busy, close, submit, error }: { snapshot: RunSnapshot; busy: boolean; close: () => void; submit: (request: CancelRunRequest) => void; error?: string | null }) {
  const [stopBackground, setStopBackground] = useState(false); const count = backgroundSummary(snapshot).count;
  return <Modal title="取消 Run" close={close}><p>取消「{snapshot.run.title}」以及尚未完成的子任务？</p>{count > 0 && <Toggle label={`同时停止 ${count} 个后台进程`} checked={stopBackground} onChange={setStopBackground} disabled={busy} />}{error && <div className="error-panel" role="alert">{error}</div>}<div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={close}>返回</button><button type="button" className="button danger" disabled={busy} onClick={() => submit({ stopBackground })}>{busy ? "取消中…" : "确认取消 Run"}</button></div></Modal>;
}
