import { useEffect, useId, useRef, useState } from "react";
import type { PullRequestRecord, RunSnapshot } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { linkedPullRequests, prMergeLabels, prReviewLabels, prStateLabels, prSummary, prTone, safePrUrl } from "../lib/pull-requests.js";
import { clock } from "../lib/derive.js";
import { errorText } from "../store.js";
import { AgentMark, Icon } from "./common.js";
import { ForgeIcon } from "./ForgeIcon.js";

export function PrChecks({ pr }: { pr: PullRequestRecord }) {
  return <span className={`pr-checks pr-tone-${prTone([pr])}`} title={`检查：${pr.checks.total} 项，${pr.checks.passed} 通过，${pr.checks.failed} 失败，${pr.checks.pending} 进行中`} aria-label={`检查 ${pr.checks.passed} 通过 ${pr.checks.failed} 失败 ${pr.checks.pending} 进行中`}>✓{pr.checks.passed} ✗{pr.checks.failed} ⏳{pr.checks.pending}</span>;
}
export function PrState({ pr }: { pr: PullRequestRecord }) { return <span className={`pr-state pr-state-${pr.state}`}>{prStateLabels[pr.state]}</span>; }
export function PrDetails({ pr, snapshot, inspect }: { pr: PullRequestRecord; snapshot: RunSnapshot; inspect?: (id: string) => void }) {
  const node = snapshot.nodes.find(node => node.id === pr.nodeId);
  const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
  return <div className="pr-details">
    <div className="pr-branches"><code>{pr.headRef ?? "未知分支"}</code><span>→</span><code>{pr.baseRef ?? "未知分支"}</code>{pr.author && <span>by {pr.author}</span>}</div>
    <div className="pr-detail-line"><PrChecks pr={pr} /><span>{pr.reviewDecision ? prReviewLabels[pr.reviewDecision] : "暂无评审结论"}</span><span className={pr.mergeable === "conflicting" ? "error-text" : ""}>{pr.mergeable ? prMergeLabels[pr.mergeable] : "合并状态未知"}</span></div>
    {pr.checks.failedChecks.length > 0 && <ul className="pr-failed-checks">{pr.checks.failedChecks.map((check, index) => <li key={`${check.name}-${index}`}>✗ {safePrUrl(check.url) ? <a href={safePrUrl(check.url)} target="_blank" rel="noopener noreferrer">{check.name} ↗</a> : check.name}</li>)}</ul>}
    <div className="pr-detail-line"><span className="green-text">+{pr.additions ?? "—"}</span><span className="error-text">−{pr.deletions ?? "—"}</span><span>{pr.changedFiles ?? "—"} files</span><span>{pr.commentCount ?? 0} 条评论</span></div>
    {node && <button type="button" className="pr-creator" disabled={!inspect} onClick={() => inspect?.(node.id)} title={`查看 ${node.title}`}><AgentMark agent={node.agentId} small /><strong>{node.role ?? (node.parentNodeId ? node.agentId : "Lead")}</strong><span>{node.model ?? node.agentId}</span><span>↗</span></button>}
    <div className="pr-times">{pr.remoteUpdatedAt && <span>更新 {date(pr.remoteUpdatedAt)}</span>}{pr.lastCheckedAt && <span>检查 {date(pr.lastCheckedAt)}</span>}{pr.lastFeedbackAt && <span>已反馈 {date(pr.lastFeedbackAt)}</span>}{pr.mergedAt && <span>合并 {date(pr.mergedAt)}</span>}{pr.closedAt && <span>关闭 {date(pr.closedAt)}</span>}</div>
    {pr.source === "mentioned" && <small className="muted">来自消息中提及的链接</small>}{pr.error && <div className="error-panel" role="alert">{pr.error}</div>}
  </div>;
}
export function PullRequestEntry({ pr, snapshot, client, inspect }: { pr: PullRequestRecord; snapshot: RunSnapshot; client?: BatonClient; inspect?: (id: string) => void }) {
  const [busy, setBusy] = useState<string>(); const [error, setError] = useState<string>(); const [message, setMessage] = useState<string>(); const [note, setNote] = useState(""); const [feedback, setFeedback] = useState<"checks" | "reviews">(); const [unlink, setUnlink] = useState(false);
  const run = async (kind: string, action: () => Promise<void>) => { setBusy(kind); setError(undefined); setMessage(undefined); try { await action(); setFeedback(undefined); setUnlink(false); setMessage(kind === "refresh" ? "状态已刷新" : kind === "unlink" ? "已取消关联" : "反馈已排队发送给 agent"); } catch (cause) { setError(errorText(cause)); } finally { setBusy(undefined); } };
  return <article className={`pr-entry${pr.source === "mentioned" ? " pr-mentioned" : ""}`}>
    <div className="pr-entry-heading"><ForgeIcon forge={pr.forge} /><strong>{pr.repo}#{pr.number}</strong><PrState pr={pr} /></div><div className="pr-entry-title">{pr.title ?? "等待获取标题"}</div>
    <PrDetails pr={pr} snapshot={snapshot} inspect={inspect} />
    <div className="pr-actions">{safePrUrl(pr.url) && <a className="text-button" href={safePrUrl(pr.url)} target="_blank" rel="noopener noreferrer">打开 ↗</a>}<button type="button" className="text-button" disabled={!client || Boolean(busy)} onClick={() => { if (client) void run("refresh", () => client.refreshPullRequest(pr.id)); }}>{busy === "refresh" ? "刷新中…" : "刷新"}</button><button type="button" className="text-button" disabled={!client || Boolean(busy)} onClick={() => setFeedback("checks")}>发 CI 失败给 agent</button><button type="button" className="text-button" disabled={!client || Boolean(busy)} onClick={() => setFeedback("reviews")}>发评审意见给 agent</button><button type="button" className="text-button muted" disabled={!client || Boolean(busy)} onClick={() => setUnlink(true)}>取消关联</button></div>
    {feedback && <form className="pr-feedback-form" onSubmit={event => { event.preventDefault(); if (client) void run("feedback", () => client.feedbackPullRequest(pr.id, { include: [feedback], ...(note.trim() ? { note: note.trim() } : {}) })); }}><label className="form-field">{feedback === "checks" ? "CI 失败" : "评审意见"} · 附加说明（可选）<textarea rows={2} value={note} onChange={event => setNote(event.target.value)} aria-label="PR 反馈附加说明" placeholder="给 agent 的额外指示" /></label><div className="pr-actions"><button className="button small primary" disabled={Boolean(busy)}>{busy === "feedback" ? "发送中…" : "排队发送"}</button><button type="button" className="button small" disabled={Boolean(busy)} onClick={() => setFeedback(undefined)}>返回</button></div></form>}
    {unlink && <div className="pr-unlink-confirm"><span>取消关联此 PR？</span><button className="button small danger" disabled={Boolean(busy)} onClick={() => { if (client) void run("unlink", () => client.unlinkPullRequest(pr.id)); }}>确认取消关联</button><button className="button small" disabled={Boolean(busy)} onClick={() => setUnlink(false)}>返回</button></div>}
    {message && <small className="green-text" role="status">{message}</small>}{error && <div className="error-panel" role="alert">{error}</div>}
  </article>;
}
export function PullRequestList({ snapshot, client, inspect, compact = false }: { snapshot: RunSnapshot; client?: BatonClient; inspect?: (id: string) => void; compact?: boolean }) {
  const prs = linkedPullRequests(snapshot); const [url, setUrl] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  return <div className={`pr-list${compact ? " is-compact" : ""}`}>{prs.map(pr => <PullRequestEntry key={pr.id} pr={pr} snapshot={snapshot} client={client} inspect={inspect} />)}{!prs.length && <p className="muted">尚未关联 PR</p>}
    {client && <form className="pr-link-form" onSubmit={event => { event.preventDefault(); if (!safePrUrl(url)) { setError("请输入 http 或 https PR URL"); return; } setBusy(true); setError(undefined); void client.linkPullRequest(snapshot.run.id, { url: url.trim() }).then(() => setUrl("")).catch((cause: unknown) => setError(errorText(cause))).finally(() => setBusy(false)); }}><label className="form-field">关联 PR<input aria-label="关联 PR URL" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" /></label><button className="button small" disabled={busy || !url.trim()}>{busy ? "关联中…" : "关联 PR"}</button>{error && <div className="error-panel" role="alert">{error}</div>}</form>}
  </div>;
}
export function PullRequestPill({ snapshot, open, controls, onClick }: { snapshot: RunSnapshot; open: boolean; controls: string; onClick: () => void }) {
  const summary = prSummary(snapshot);
  return summary.count ? <button type="button" className={`background-pill pr-pill pr-tone-${summary.tone}`} aria-expanded={open} aria-controls={controls} aria-haspopup="dialog" onClick={onClick} title="查看本会话的 Pull Requests"><ForgeIcon forge="other" size={13} />PR {summary.count}</button> : null;
}
export function PullRequestPopover({ snapshot, client, inspect }: { snapshot: RunSnapshot; client: BatonClient; inspect: (id: string) => void }) {
  const [open, setOpen] = useState(false); const id = useId(); const container = useRef<HTMLDivElement>(null); const panel = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); container.current?.querySelector<HTMLButtonElement>(".pr-pill")?.focus(); };
  useEffect(() => { if (!open) return; panel.current?.focus(); const outside = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false); }; document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside); }, [open]);
  return <div className="pr-popover-anchor" ref={container} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}><PullRequestPill snapshot={snapshot} open={open} controls={id} onClick={() => setOpen(value => !value)} />{open && <div ref={panel} id={id} role="dialog" aria-label="本会话的 Pull Requests" tabIndex={-1} className="background-popover pr-popover"><header><strong>Pull Requests</strong><small>全部关联 PR</small><button type="button" className="icon-button" aria-label="关闭 Pull Requests" onClick={close}><Icon name="close" size={14} /></button></header><PullRequestList snapshot={snapshot} client={client} inspect={id => { close(); inspect(id); }} /></div>}</div>;
}
/** Shares the compact AgentMessageCard row language; body stays safe React content. */
export function InlinePullRequest({ pr, snapshot, client, inspect }: { pr: PullRequestRecord; snapshot: RunSnapshot; client?: BatonClient; inspect?: (id: string) => void }) {
  const [open, setOpen] = useState(false); const heading = useId(); const body = useId();
  return <article className={`agent-message-card inline-pr-card${open ? " is-open" : ""}`} data-pr-id={pr.id}><div className="agent-card-row"><button type="button" className="agent-card-toggle" aria-labelledby={heading} aria-expanded={open} aria-controls={body} onClick={() => setOpen(value => !value)} /><ForgeIcon forge={pr.forge} /><span className="agent-card-direction">创建了 PR</span><strong className="agent-card-title" id={heading} title={pr.title}>#{pr.number} {pr.title ?? pr.repo}</strong><PrState pr={pr} /><PrChecks pr={pr} /><time className="agent-card-time" dateTime={pr.createdAt}>{clock(pr.createdAt)}</time><Icon name="chevron" size={12} /></div><div id={body} className="agent-card-body" hidden={!open}>{open && <PullRequestEntry pr={pr} snapshot={snapshot} client={client} inspect={inspect} />}</div></article>;
}
