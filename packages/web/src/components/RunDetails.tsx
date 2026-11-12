import type { InboxItem, RunSnapshot } from "@baton/protocol";
import type { ConnectionState } from "../store.js";
import { cost, displayRunStatus, duration, terminal, tokens } from "../lib/derive.js";
import { runMetrics } from "../lib/run-layout.js";
import { collaborationLabels } from "../lib/teams.js";
import { inboxLabels } from "../lib/inbox.js";
import { AgentMark, Icon, Status, Toggle } from "./common.js";
import { CopyButton } from "./CopyButton.js";

export function RunDetails({ snapshot, now, connection, busy, close, autoApprove, cancel, openTeam, openPending }: {
  snapshot: RunSnapshot; now: number; connection: ConnectionState; busy: boolean;
  close: () => void; autoApprove: (value: boolean) => void; cancel: () => void; openTeam: () => void;
  openPending: (kind: InboxItem["kind"]) => void;
}) {
  const { run } = snapshot; const metrics = runMetrics(snapshot); const { policy } = run;
  const root = snapshot.nodes.find(node => node.id === run.rootNodeId);
  return <aside id="run-details" className="run-details" aria-label="Run 详情">
    <div className="right-panel-heading"><strong>Run 详情</strong><button className="icon-button" aria-label="关闭 Run 详情" onClick={close}><Icon name="close" size={16} /></button></div>
    <div className="run-details-scroll">
      <section className="run-detail-section run-details-intro"><h2>{run.title}</h2><div className="run-detail-status"><Status status={displayRunStatus(snapshot)} /><span className={`connection-indicator ${connection}`}>{connection === "live" ? "● Live" : connection === "reconnecting" ? "◌ 重连中" : connection === "loading" ? "◌ 连接中" : "○ 离线"}</span></div>{root && <div className="detail-lead"><AgentMark agent={root.agentId} small /><span>Lead · {root.agentId}</span><code>{root.model ?? "默认模型"}</code></div>}<div className="detail-section-label">工作目录 <CopyButton text={run.cwd} label="复制路径" /></div><code className="detail-workspace-path">{run.cwd}</code></section>
      <section className="run-detail-section"><h3>运行统计</h3><dl className="run-detail-metrics"><div><dt>活跃 / 总节点</dt><dd>{metrics.activeNodes} <span>/ {metrics.totalNodes}</span></dd></div><div><dt>累计费用</dt><dd>{cost(run.usage.costUsd)}</dd></div><div><dt>Tokens</dt><dd>{tokens(metrics.tokens)}</dd></div><div><dt>Cached tokens</dt><dd>{tokens(run.usage.cachedInputTokens)}</dd></div><div><dt>运行时间</dt><dd>{duration(run.createdAt, run.endedAt ?? now)}</dd></div><div><dt>委派 / 回合</dt><dd>{snapshot.delegations.length} <span>/ {snapshot.turns.length}</span></dd></div></dl><div className="token-breakdown">Input {tokens(run.usage.inputTokens)} · Output {tokens(run.usage.outputTokens)}</div></section>
      <section className="run-detail-section"><h3>待处理 <span className="pending-mini-badge">{metrics.pendingTotal}</span></h3><div className="detail-pending-list">{(Object.keys(inboxLabels) as InboxItem["kind"][]).map(kind => <button key={kind} disabled={!metrics.pendingByKind[kind]} onClick={() => openPending(kind)}><span>{inboxLabels[kind]}</span><strong>{metrics.pendingByKind[kind]}</strong><Icon name="chevron" size={12} /></button>)}</div></section>
      <section className="run-detail-section"><h3>协作与策略</h3><dl className="detail-policy"><dt>协作方式</dt><dd>{collaborationLabels[policy.mode ?? "dynamic"]}</dd><dt>名单确认</dt><dd>{policy.teamApproval === false ? "关闭" : "需要我确认"}</dd><dt>委派深度</dt><dd>最多 {policy.maxDepth} 层</dd><dt>并行子委派</dt><dd>每节点最多 {policy.maxActiveChildren}</dd><dt>团队人数</dt><dd>最多 {policy.maxTeamSize ?? 5} 人</dd><dt>停滞提醒</dt><dd>{policy.stallMinutes ?? 10} 分钟</dd><dt>委派轮次</dt><dd>最多 {policy.maxRoundsPerDelegation ?? 3} 轮</dd>{policy.budget?.maxCostUsd !== undefined && <><dt>费用预算</dt><dd>${policy.budget.maxCostUsd}</dd></>}{policy.budget?.maxTokens !== undefined && <><dt>Token 预算</dt><dd>{tokens(policy.budget.maxTokens)}</dd></>}{policy.budget?.maxWallMinutes !== undefined && <><dt>时间预算</dt><dd>{policy.budget.maxWallMinutes} 分钟</dd></>}</dl><div className="detail-auto-approve"><Toggle label="autoApprove" checked={policy.autoApprove} disabled={busy} onChange={autoApprove} /></div></section>
      <section className="run-detail-section"><h3>团队 <button className="text-button" onClick={openTeam}>查看团队 ↗</button></h3>{metrics.activeMembers.length ? <div className="detail-team-list">{metrics.activeMembers.map(member => <div key={member.id}><AgentMark agent={member.agentId} small /><strong>{member.role}</strong><span>{member.agentId}</span></div>)}</div> : <p className="muted">{policy.mode === "solo" ? "由 Lead 单独完成" : "尚未组建团队"}</p>}{run.team?.presetName && <p className="muted">预设 · {run.team.presetName}</p>}</section>
      <section className="run-detail-section detail-run-actions"><code>{run.id}</code><button className="button danger" disabled={busy || terminal(run.status)} onClick={cancel}><Icon name="stop" size={13} />取消 Run</button></section>
    </div>
  </aside>;
}
