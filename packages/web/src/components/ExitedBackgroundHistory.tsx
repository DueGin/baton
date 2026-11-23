import { useEffect, useId, useMemo, useState } from "react";
import type { BackgroundProcess, NodeRecord } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { attributionDescriptions, backgroundPorts, dismissExitedHistory, exitTimeLabel, groupExitedProcesses } from "../lib/background.js";
import { duration } from "../lib/derive.js";
import { AgentIcon } from "./AgentIcon.js";
import { Icon } from "./common.js";
import { CopyButton, CopyableId } from "./CopyButton.js";
import { Modal } from "./TeamForms.js";

const initialLimit = 20;
const lifetime = (process: BackgroundProcess) => process.exitedAt ? duration(process.startedAt, process.exitedAt) : "—";
const exitKind = (process: BackgroundProcess) => process.stoppedBy === "human" ? "已停止 · 人工" : "自行退出";

function ExitTime({ process, now }: { process: BackgroundProcess; now: number }) {
  return <time dateTime={process.exitedAt} title={process.exitedAt ? `退出于 ${new Date(process.exitedAt).toLocaleString("zh-CN")}` : "退出时间未知"}>{exitTimeLabel(process.exitedAt, now)}</time>;
}

function HistoricalPorts({ ports }: { ports: number[] }) {
  const label = backgroundPorts(ports).map(port => `:${port}`).join(" ");
  return label ? <span className="exited-ports" title={`曾监听 ${label}（已退出）`}>{label}</span> : null;
}

function CommandCopy({ command }: { command: string }) {
  const [feedback, setFeedback] = useState<"copied" | "failed">();
  useEffect(() => {
    if (!feedback) return;
    const timeout = setTimeout(() => setFeedback(undefined), 1500);
    return () => clearTimeout(timeout);
  }, [feedback]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setFeedback("copied"); }
    catch { setFeedback("failed"); }
  };
  const label = feedback === "copied" ? "已复制命令" : feedback === "failed" ? "复制失败，重试" : "复制命令";
  return <button type="button" className="icon-button exited-copy" title={label} aria-label={label} onClick={() => { void copy(); }}><Icon name={feedback === "copied" ? "check" : feedback === "failed" ? "warning" : "copy"} size={13} /></button>;
}

type RecordActions = { now: number; canDismiss: boolean; dismiss: (id: string) => void };

function ExitRecord({ process, now, canDismiss, dismiss }: RecordActions & { process: BackgroundProcess }) {
  return <li className="exited-record">
    <div className="exited-facts"><span>退出 <ExitTime process={process} now={now} /></span><span>存活 {lifetime(process)}</span><span>PID <CopyableId id={String(process.pid)} label=" PID" /></span><span className="exited-kind">{exitKind(process)}</span><HistoricalPorts ports={process.ports} /></div>
    {process.cwd && <div className="exited-cwd"><span>cwd</span><code>{process.cwd}</code><CopyButton text={process.cwd} label="复制 cwd" /></div>}
    {process.children.length > 0 && <details className="background-children"><summary>子进程 {process.children.length} 个</summary>{process.children.map(child => <div key={child.pid}><code title={child.command}>{child.command}</code><small>pid {child.pid}</small><HistoricalPorts ports={child.ports} /></div>)}</details>}
    <div className="exited-record-actions"><span title={attributionDescriptions[process.attribution]}>{({ tree: "进程树归属", group: "进程组归属", inferred: "推断归属" } as const)[process.attribution]}</span><button type="button" className="text-button" disabled={!canDismiss} title={`隐藏 PID ${process.pid} 的记录`} onClick={() => dismiss(process.id)}>不是本会话启动的</button></div>
  </li>;
}

type GroupProps = RecordActions & {
  records: [BackgroundProcess, ...BackgroundProcess[]]; node?: NodeRecord; inspect?: (id: string) => void;
};
const roleOf = (node?: NodeRecord) => node?.role ?? (node ? (node.parentNodeId ? node.agentId : "Lead") : "未知");

export function ExitedGroupDetails({ records, node, inspect, ...actions }: GroupProps) {
  return <>
    <code className="exited-full-command">{records[0].command}</code>
    <div className="exited-source">启动节点{node ? <><AgentIcon agent={node.agentId} size={14} />{inspect ? <button type="button" className="text-button" onClick={() => inspect(node.id)}>{node.title} ↗</button> : <span>{node.title}</span>}<span>{roleOf(node)}</span></> : <span>未知</span>}</div>
    <ol className="exited-records">{records.map(process => <ExitRecord key={process.id} process={process} {...actions} />)}</ol>
  </>;
}

function ExitGroup(props: GroupProps) {
  const { records, node, now } = props;
  const latest = records[0]; const [open, setOpen] = useState(false); const id = useId();
  const role = roleOf(node);
  return <article className="exited-group">
    <div className="exited-row">
      <button type="button" className="exited-toggle" aria-controls={id} aria-expanded={open} onClick={() => setOpen(!open)}>
        <i className="background-dot" aria-hidden="true" /><code title={latest.command}>{latest.command}</code>
        {records.length > 1 && <span className="exited-count" title={`共 ${records.length} 次，显示最近一次`}>×{records.length}</span>}
        <HistoricalPorts ports={latest.ports} />
        <span className="exited-role" title={node ? `${node.title} · ${role}` : "启动节点未知"}>{node && <AgentIcon agent={node.agentId} size={13} />}<span>{role}</span></span>
        <span className="exited-lifetime" title={`存活 ${lifetime(latest)}`}>{lifetime(latest)}</span><ExitTime process={latest} now={now} />
        <span className="exited-kind">{exitKind(latest)}</span><Icon name="chevron" size={11} />
      </button>
      <CommandCopy command={latest.command} />
    </div>
    <div className="exited-detail" id={id} hidden={!open}>{open && <ExitedGroupDetails {...props} />}</div>
  </article>;
}

export function ExitedBackgroundHistory({ exited, nodes, now, client, inspect }: {
  exited: BackgroundProcess[]; nodes: NodeRecord[]; now: number; client?: BatonClient; inspect?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false); const [showAll, setShowAll] = useState(false); const id = useId();
  const [selection, setSelection] = useState<string[]>(); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const groups = useMemo(() => groupExitedProcesses(exited), [exited]);
  const hide = async (ids: string[]) => {
    if (!client || busy) return;
    setBusy(true); setError(undefined);
    const failures = await dismissExitedHistory(ids, client);
    if (failures.length) setError(`${failures.length} 条记录隐藏失败：${failures[0]!.reason}`);
    setBusy(false); setSelection(undefined);
  };
  return <section aria-label="已退出的后台进程" className="background-exited">
    <header className="exited-header"><button type="button" className="text-button exited-heading" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><Icon name="chevron" size={12} />已退出 {exited.length} 个</button>
      <button type="button" className="text-button" disabled={!client || busy} onClick={() => setSelection(exited.map(process => process.id))}>全部隐藏</button></header>
    {error && <div className="error-panel" role="alert">{error}</div>}
    <div id={id} hidden={!open}>{(showAll ? groups : groups.slice(0, initialLimit)).map(group => <ExitGroup key={group.key} records={group.records} node={nodes.find(node => node.id === group.records[0].nodeId)} now={now} inspect={inspect} canDismiss={Boolean(client) && !busy} dismiss={recordId => { void hide([recordId]); }} />)}
      {groups.length > initialLimit && <button type="button" className="text-button exited-show-all" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? `仅显示最近 ${initialLimit} 条` : `显示全部 ${groups.length} 条`}</button>}
    </div>
    {selection && <Modal title="隐藏已退出的后台进程" close={() => { if (!busy) setSelection(undefined); }}><p>从本会话隐藏这 {selection.length} 条退出记录？运行中的进程不受影响。</p><div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={() => setSelection(undefined)}>返回</button><button type="button" className="button primary" disabled={busy} onClick={() => { void hide(selection); }}>{busy ? "隐藏中…" : "确认隐藏"}</button></div></Modal>}
  </section>;
}
