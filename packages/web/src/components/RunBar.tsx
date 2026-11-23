import { useEffect, useState } from "react";
import type { ProjectSummary, RunSnapshot } from "@baton/protocol";
import { cost, displayRunStatus } from "../lib/derive.js";
import { runMetrics, type RunTab } from "../lib/run-layout.js";
import { ProjectLink } from "./Projects.js";
import { Icon, Status } from "./common.js";

export function RunBar({ snapshot, tab, setTab, detailsOpen, toggleDetails, rename, regenerate, project, openProject, pause, resume, busy = false }: {
  project?: ProjectSummary; openProject?: () => void; snapshot: RunSnapshot; tab: RunTab; setTab: (tab: RunTab) => void; detailsOpen: boolean; toggleDetails: () => void;
  rename?: (title: string) => Promise<boolean>; regenerate?: () => Promise<boolean>;
  pause?: () => void; resume?: () => void; busy?: boolean;
}) {
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(snapshot.run.title); const [working, setWorking] = useState<"rename" | "generate" | null>(null);
  useEffect(() => { setEditing(false); setDraft(snapshot.run.title); }, [snapshot.run.id]);
  const save = async () => { if (!draft.trim() || working) return; setWorking("rename"); try { if (await rename?.(draft.trim())) setEditing(false); } finally { setWorking(null); } };
  const generate = async () => { setWorking("generate"); try { await regenerate?.(); } finally { setWorking(null); } };
  const metrics = runMetrics(snapshot);
  return <header className="run-bar">
    {project && <ProjectLink project={project} open={() => openProject?.()} />}
    <div className="run-title-control">{editing ? <form onSubmit={event => { event.preventDefault(); void save(); }}><input aria-label="Run 标题" autoFocus value={draft} disabled={working === "rename"} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); } }} /><button className="icon-button" disabled={!draft.trim() || Boolean(working)} title="保存标题"><Icon name="check" size={13} /></button></form> : <><button className="run-title-edit" title={snapshot.run.title} aria-label={`重命名：${snapshot.run.title}`} disabled={!rename} onClick={() => { setDraft(snapshot.run.title); setEditing(true); }}><h1 className="compact-run-title">{snapshot.run.title}</h1>{snapshot.run.titleSource === "generated" && <span className="generated-title-mark" title="由标题模型命名">✦</span>}<Icon name="edit" size={12} /></button><button className={`icon-button title-regenerate${working === "generate" ? " spinning" : ""}`} title="重新生成标题" aria-label="重新生成标题" disabled={!regenerate || Boolean(working)} onClick={() => { void generate(); }}><Icon name="refresh" size={13} /></button></>}</div>
    <span className="compact-run-status"><Status status={displayRunStatus(snapshot)} /></span>
    {["active", "idle", "paused"].includes(snapshot.run.status) && <button type="button" className={`icon-button run-pause-toggle${snapshot.run.status === "paused" ? " is-paused" : ""}`} aria-label={snapshot.run.status === "paused" ? "继续会话" : "暂停会话"} title={snapshot.run.status === "paused" ? "继续会话" : "暂停整个会话，后台进程继续运行"} disabled={busy || !(snapshot.run.status === "paused" ? resume : pause)} onClick={snapshot.run.status === "paused" ? resume : pause}><Icon name={snapshot.run.status === "paused" ? "play" : "pause"} size={14} /></button>}
    <div className="run-mini-metrics"><span className="mini-node-count" title="活跃 / 总节点">{metrics.activeNodes}/{metrics.totalNodes} <span>节点</span></span><button className={`pending-mini-badge${metrics.pendingTotal ? " has-pending" : ""}`} title={`${metrics.pendingTotal} 项待处理，打开详情`} onClick={() => { if (!detailsOpen) toggleDetails(); }}>{metrics.pendingTotal} <span>待处理</span></button><span className="mini-run-cost" title="累计费用">{cost(snapshot.run.usage.costUsd)}</span></div>
    <div className="run-bar-tabs" role="tablist" aria-label="Run 视图">{([{ id: "transcript", label: "会话", icon: "chat" }, { id: "topology", label: "拓扑图", icon: "graph" }, { id: "timeline", label: "时间线", icon: "timeline" }, { id: "team", label: "团队", icon: "agents" }] as const).map(entry => <button key={entry.id} id={`run-tab-${entry.id}`} role="tab" aria-selected={tab === entry.id} aria-controls="run-view" className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}><Icon name={entry.icon} size={14} /><span>{entry.label}</span>{entry.id === "team" && metrics.pendingByKind.proposal > 0 && <span className="team-tab-badge">{metrics.pendingByKind.proposal}</span>}</button>)}</div>
    <button className={`run-details-toggle${detailsOpen ? " active" : ""}`} aria-label="Run 详情" title="Run 详情" aria-expanded={detailsOpen} aria-controls="run-details" onClick={toggleDetails}><Icon name="panel" size={16} /><span>详情</span></button>
  </header>;
}
