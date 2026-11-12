import type { RunSnapshot } from "@baton/protocol";
import { cost, displayRunStatus } from "../lib/derive.js";
import { runMetrics, type RunTab } from "../lib/run-layout.js";
import { Icon, Status } from "./common.js";

export function RunBar({ snapshot, tab, setTab, detailsOpen, toggleDetails }: {
  snapshot: RunSnapshot; tab: RunTab; setTab: (tab: RunTab) => void; detailsOpen: boolean; toggleDetails: () => void;
}) {
  const metrics = runMetrics(snapshot);
  return <header className="run-bar">
    <h1 className="compact-run-title" title={snapshot.run.title}>{snapshot.run.title}</h1>
    <span className="compact-run-status"><Status status={displayRunStatus(snapshot)} /></span>
    <div className="run-mini-metrics"><span className="mini-node-count" title="活跃 / 总节点">{metrics.activeNodes}/{metrics.totalNodes} <span>节点</span></span><button className={`pending-mini-badge${metrics.pendingTotal ? " has-pending" : ""}`} title={`${metrics.pendingTotal} 项待处理，打开详情`} onClick={() => { if (!detailsOpen) toggleDetails(); }}>{metrics.pendingTotal} <span>待处理</span></button><span className="mini-run-cost" title="累计费用">{cost(snapshot.run.usage.costUsd)}</span></div>
    <div className="run-bar-tabs" role="tablist" aria-label="Run 视图">{([{ id: "topology", label: "拓扑图", icon: "graph" }, { id: "timeline", label: "时间线", icon: "timeline" }, { id: "transcript", label: "会话", icon: "chat" }, { id: "team", label: "团队", icon: "agents" }] as const).map(entry => <button key={entry.id} id={`run-tab-${entry.id}`} role="tab" aria-selected={tab === entry.id} aria-controls="run-view" className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}><Icon name={entry.icon} size={14} /><span>{entry.label}</span>{entry.id === "team" && metrics.pendingByKind.proposal > 0 && <span className="team-tab-badge">{metrics.pendingByKind.proposal}</span>}</button>)}</div>
    <button className={`run-details-toggle${detailsOpen ? " active" : ""}`} aria-label="Run 详情" title="Run 详情" aria-expanded={detailsOpen} aria-controls="run-details" onClick={toggleDetails}><Icon name="panel" size={16} /><span>详情</span></button>
  </header>;
}
