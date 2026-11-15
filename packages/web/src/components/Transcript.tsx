import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ItemRecord, NodeRecord, RunSnapshot, ToolCallDetail } from "@baton/protocol";
import { activeTurn, conversationPhase, conversationRows, messageActionKey, queuedRows, nodeIsLive, phaseTimerLabel, type ConversationPhase, type OutgoingMessage, type MessageActionState, type MessageAction } from "../lib/conversation.js";
import { composerHeight } from "../lib/run-layout.js";
import { clock, duration, tokens, treeOrder } from "../lib/derive.js";
import { AgentMark, Empty, Icon, Status } from "./common.js";
import type { RunStore } from "../store.js";
import { parseBatonMessage, type BatonMessagePart } from "../lib/baton-messages.js";

import { Markdown } from "./Markdown.js";
import { reasoningBlockId, reasoningOpen, reasoningPreferences } from "../lib/reasoning.js";
import { BackgroundPopover } from "./BackgroundProcesses.js";
import { QueueDock } from "./QueueDock.js";
import { DeliveryIcon, MessageActionIcons } from "./MessageActions.js";
import { ReasoningControls } from "./ReasoningControls.js";
export { Markdown } from "./Markdown.js";

export function ToolDetail({ detail }: { detail: ToolCallDetail }) {
  switch (detail.type) {
    case "shell": return <><div className="tool-command">$ {detail.command}</div>{detail.cwd && <div className="detail-path">{detail.cwd}</div>}{detail.output && <pre>{detail.output}</pre>}{detail.exitCode !== undefined && <div className={`tool-exit ${detail.exitCode ? "error-text" : ""}`}>exit {detail.exitCode ?? "…"}</div>}</>;
    case "edit": return <><div className="detail-path">{detail.filePath}</div><div className="diff">{(detail.unifiedDiff ?? `--- before\n${detail.oldString ?? ""}\n+++ after\n${detail.newString ?? ""}`).split("\n").map((line, index) => <div key={index} className={line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : ""}>{line || " "}</div>)}</div></>;
    case "read": case "write": return <><div className="detail-path">{detail.filePath}{detail.type === "read" && detail.offset !== undefined ? ` · line ${detail.offset}` : ""}</div>{detail.content && <pre>{detail.content}</pre>}</>;
    case "search": return <><div className="tool-command">{detail.toolName ?? "search"}: {detail.query}</div>{detail.content && <pre>{detail.content}</pre>}{detail.filePaths && <pre>{detail.filePaths.join("\n")}</pre>}{detail.numMatches !== undefined && <div className="muted">{detail.numMatches} matches · {detail.numFiles ?? 0} files</div>}</>;
    case "fetch": return <><div className="detail-path">{detail.url} {detail.code && <span>· {detail.code}</span>}</div>{detail.prompt && <Markdown text={detail.prompt} />}{detail.result && <pre>{detail.result}</pre>}</>;
    case "baton": return <><div className="detail-path">baton.{detail.tool}{detail.delegationId && ` · ${detail.delegationId}`}</div>{detail.input !== undefined && <pre>{JSON.stringify(detail.input, null, 2)}</pre>}{detail.output !== undefined && <pre>{JSON.stringify(detail.output, null, 2)}</pre>}</>;
    case "sub_agent": return <><Markdown text={detail.description ?? detail.subAgentType ?? "Sub-agent"} />{detail.childSessionId && <code>{detail.childSessionId}</code>}{detail.actions?.map(action => <div key={action.index}>{action.toolName} · {action.summary}</div>)}</>;
    case "plan": return <Markdown text={detail.text} />;
    case "plain_text": return <><div className="detail-path">{detail.label}</div><pre>{detail.text}</pre></>;
    case "unknown": return <pre>{JSON.stringify({ input: detail.input, output: detail.output }, null, 2)}</pre>;
  }
}

function toolSummary(detail: ToolCallDetail): string {
  if (detail.type === "shell") return detail.command;
  if ("filePath" in detail) return detail.filePath;
  if (detail.type === "search") return detail.query;
  if (detail.type === "fetch") return detail.url;
  if (detail.type === "baton") return detail.tool;
  return detail.type;
}
function BatonMessage({ parts, snapshot, inspect }: { parts: BatonMessagePart[]; snapshot?: RunSnapshot; inspect?: (id: string) => void }) {
  const openNode = (delegationId: string): string | undefined => {
    const nodeId = snapshot?.delegations.find(edge => edge.id === delegationId)?.toNodeId;
    return snapshot?.nodes.some(node => node.id === nodeId) ? nodeId : undefined;
  };
  return <div className="baton-message">{parts.map((part, index) => {
    if (part.type === "answer") return <article key={index} className="protocol-card baton-answer-card"><div className="protocol-card-type">✓ 你的回答 <code>{part.questionId}</code></div><div className="protocol-card-body"><Markdown text={part.text} /></div></article>;
    if (part.type === "notice") return <article key={index} className="protocol-card baton-notice-card"><div className="protocol-card-type">↪ 团队通知</div><div className="protocol-card-body"><Markdown text={part.text} /></div></article>;
    if (part.type === "text") return <Markdown text={part.text} key={index} />;
    if (part.type === "assignment") {
      const nodeId = openNode(part.delegationId);
      return <article key={index} className="protocol-card assignment-card"><div className="protocol-card-type"><span>↗ 任务书</span>{part.role && <span className="role-badge">{part.role}</span>}{part.readonly && <span className="tag">只读委派</span>}</div><button className="protocol-card-heading" disabled={!nodeId || !inspect} onClick={() => { if (nodeId) inspect?.(nodeId); }} title={nodeId ? "查看委派节点" : "委派节点不可用"}><strong>{part.title}</strong><span>↗</span></button><div className="protocol-card-body"><h4>任务</h4><Markdown text={part.task} />{part.context && <><h4>Context</h4><Markdown text={part.context} /></>}{part.acceptance.length > 0 && <><h4>验收标准</h4><ul>{part.acceptance.map((criterion, i) => <li key={i}><Markdown text={criterion} /></li>)}</ul></>}</div></article>;
    }
    return <Fragment key={index}>{part.results.map((result, i) => {
      const nodeId = openNode(result.delegationId);
      const badge = { success: "✓ 完成", partial: "◐ 部分完成", failed: "✗ 失败" }[result.outcome];
      return <article key={`${result.delegationId}:${i}`} className={`protocol-card delivered-card outcome-${result.outcome}`}><div className="protocol-card-type"><span>↙ 结果送达</span><span className="result-outcome">{badge}</span></div><button className="protocol-card-heading" disabled={!nodeId || !inspect} onClick={() => { if (nodeId) inspect?.(nodeId); }} title={nodeId ? "查看子节点" : "委派节点不可用"}><strong>{result.title}</strong><span>↗</span></button><div className="protocol-card-body"><Markdown text={result.summary} />{result.resultText !== undefined && <details className="detail-disclosure"><summary>Result JSON</summary><pre>{result.resultText}</pre></details>}{result.artifactsText && <details className="detail-disclosure"><summary>Artifacts</summary><pre>{result.artifactsText}</pre></details>}{result.note && <Markdown text={result.note} />}</div></article>;
    })}</Fragment>;
  })}</div>;
}

function ReasoningRow({ id, text, streaming }: { id: string; text: string; streaming: boolean }) {
  const state = useSyncExternalStore(reasoningPreferences.subscribe, reasoningPreferences.getSnapshot, reasoningPreferences.getSnapshot);
  const open = reasoningOpen(state.preference, streaming, state.overrides.get(id));
  return <details className={`reasoning-row${streaming ? " reasoning-live" : ""}`} open={open}><summary onClick={event => { event.preventDefault(); reasoningPreferences.setBlocks([id], !open); }}>{streaming && <span className="live-dot" />}思考过程 <span>{text.length} 字{streaming ? " · 生成中" : ""}</span></summary><Markdown text={text} streaming={streaming} /></details>;
}
export function TranscriptRow({ row, node, snapshot, inspect, streaming = false, outgoing, retry, actionState, act }: { row: ItemRecord; node: NodeRecord; snapshot?: RunSnapshot; inspect?: (id: string) => void; streaming?: boolean; outgoing?: OutgoingMessage; retry?: () => void; actionState?: MessageActionState; act?: (action: MessageAction) => void }) {
  const item = row.item;
  if (item.type === "user_message" && ["queued", "retracted"].includes(item.delivery ?? "")) return null;
  if (item.type === "user_message") {
    const parts = parseBatonMessage(item.text);
    if (parts && !item.delivery && !outgoing) return <BatonMessage parts={parts} snapshot={snapshot} inspect={inspect} />;
  }
  if (item.type === "reasoning") return <ReasoningRow id={reasoningBlockId(row.nodeId, row.seq)} text={item.text} streaming={streaming} />;
  if (item.type === "tool_call") return <details className={`tool-row tool-${item.status}`}><summary><span className="tool-type">{item.detail.type}</span><span className="tool-summary">{toolSummary(item.detail)}</span><span className="tool-state">{item.status === "completed" ? "✓" : item.status === "running" ? "◌" : "✗"}</span></summary><div className="tool-body"><ToolDetail detail={item.detail} />{item.error && <Markdown text={item.error} />}</div></details>;
  if (item.type === "notice" || item.type === "error") return <div className={`notice-row ${item.type === "error" ? "error" : item.level}`}>{item.type === "error" ? "✗ " : "↳ "}<Markdown text={item.message} /></div>;
  if (item.type === "todo") return <div className="todo-row">{item.items.map((todo, index) => <div key={index}><span>{todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◉" : "○"}</span><Markdown text={todo.text} /></div>)}</div>;
  const delivery = item.type === "user_message" ? item.delivery ?? outgoing?.delivery : undefined;
  const canAct = act && row.seq > 0 && (!outgoing || outgoing.state === "accepted");
  return <article className={`message message-${item.type}${outgoing?.state === "failed" ? " message-send-failed" : ""}`}>
    <div className="message-meta">{item.type === "user_message" ? <span className="user-avatar">U</span> : <AgentMark agent={node.agentId} small />}<strong>{item.type === "user_message" ? "你" : node.agentId}</strong><time dateTime={row.ts}>{clock(row.ts)}</time>{item.type === "user_message" && <DeliveryIcon delivery={delivery} interrupted={item.interrupted ?? outgoing?.interrupted} state={outgoing?.state} />}
      <div className="message-top-actions">{canAct && <MessageActionIcons delivery={delivery} state={actionState} act={act} />}{outgoing?.state === "failed" && <button type="button" className="icon-button" aria-label="重试发送" title="重试发送" onClick={retry}><Icon name="refresh" size={15} /></button>}</div>
    </div>
    <Markdown text={item.text} streaming={streaming && item.type === "assistant_message"} />
    {actionState?.error && <div className="error-text send-error" role="alert">{actionState.error}</div>}
    {outgoing?.state === "failed" && <div className="error-text send-error">{outgoing.error}</div>}
  </article>;
}

export function ConversationStatus({ phase, snapshot, now, inspect }: { phase: ConversationPhase; snapshot: RunSnapshot; now: number; inspect: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false); const previewId = useId();
  const linkedNode = (id: string) => snapshot.nodes.find(node => node.id === id);
  return <div className={`conversation-live phase-${phase.kind}`}>
    <div className="live-compact-line"><span className="live-dot" /><strong className="live-phase-title" title={phase.label} role="status">{phase.label}</strong>
      {phase.toolSince && <span className="live-tool-time">{duration(phase.toolSince, now)}</span>}
      <span className="live-turn-time">{phaseTimerLabel(phase)} {duration(phase.since, now)}</span>
      {phase.quiet > 30 && <span className="quiet-label">已 {phase.quiet}s 无新输出</span>}
      {phase.tokens > 0 && <span className="live-token-count">{tokens(phase.tokens)} tokens</span>}
      <div className="live-inline-links">{phase.related.map(id => <button className="text-button" key={id} title={linkedNode(id)?.title} onClick={() => inspect(id)}>{phase.kind === "permission" ? "处理授权 ↗" : phase.kind === "question" ? "回答问题 ↗" : `${linkedNode(id)?.title ?? "子任务"} ↗`}</button>)}</div>
      {phase.reasoning && <button type="button" className={`icon-button live-expand${expanded ? " expanded" : ""}`} aria-label={expanded ? "收起实时思考" : "展开实时思考"} aria-expanded={expanded} aria-controls={previewId} onClick={() => setExpanded(value => !value)}><Icon name="chevron" size={13} /></button>}
    </div>
    {phase.reasoning && expanded && <div id={previewId} className="live-reasoning-expanded"><Markdown text={phase.reasoning} streaming /></div>}
  </div>;
}

export function Transcript({ snapshot, store, items, itemStatus, nodeId, setNodeId, now, inspect, projectName }: {
  projectName?: string; snapshot: RunSnapshot; store: RunStore; items: Record<string, ItemRecord[]>; itemStatus: Record<string, string>;
  nodeId: string; setNodeId: (id: string) => void; now: number; inspect: (id: string) => void;
}) {
  const [draft, setDraft] = useState(""); const [follow, setFollow] = useState(true); const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null); const node = snapshot.nodes.find(entry => entry.id === nodeId) ?? snapshot.nodes[0];
  const state = store.getSnapshot();
  useEffect(() => { if (node) { void store.loadItems(node.id); setDraft(""); setFollow(true); } }, [node?.id, store]);
  const rows = items[node?.id ?? nodeId] ?? [];
  const messages = conversationRows(rows, state.outgoing, node?.id ?? nodeId);
  const queueState = state.queues[node?.id ?? nodeId];
  const queue = queuedRows(rows, state.outgoing, node?.id ?? nodeId, queueState?.order);
  const pending = state.outgoing.findLast(message => message.nodeId === node?.id && (message.state === "sending" || (message.state === "accepted" && message.delivery === "turn" && !rows.some(row => row.seq === message.itemSeq))));
  const phase = node ? conversationPhase(snapshot, node, rows, now, state.lastEventAt[node.id], pending?.ts) : null;
  const live = node ? nodeIsLive(snapshot, node) : false;
  const turn = node ? activeTurn(snapshot, node.id) : undefined;
  const latestText = rows.filter(row => row.item.type === "reasoning" || row.item.type === "assistant_message").at(-1);
  const inTurn = (row: ItemRecord) => turn ? row.turnId === turn.id || (!row.turnId && Date.parse(row.ts) >= Date.parse(turn.startedAt)) : live && row.seq === latestText?.seq;
  useEffect(() => { if (follow) bottom.current?.scrollIntoView({ block: "end" }); }, [rows, state.outgoing, follow]);
  useEffect(() => {
    const content = bottom.current?.parentElement;
    if (!content || !follow) return;
    const observer = new ResizeObserver(() => bottom.current?.scrollIntoView({ block: "end" }));
    observer.observe(content); return () => observer.disconnect();
  }, [follow, node?.id]);
  useLayoutEffect(() => {
    const textarea = input.current; if (!textarea) return;
    const resize = () => {
      const style = getComputedStyle(textarea);
      const lineHeight = Number.parseFloat(style.lineHeight) || 20;
      const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
      textarea.style.height = "auto";
      textarea.style.height = `${composerHeight(textarea.scrollHeight, lineHeight, padding)}px`;
    };
    resize();
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width !== textarea.clientWidth) { width = textarea.clientWidth; resize(); }
    });
    observer.observe(textarea); return () => observer.disconnect();
  }, [draft, node?.id]);
  const submit = (): void => { const text = draft.trim(); if (!text || !node) return; setDraft(""); setFollow(true); void store.sendMessage(node.id, text); };
  if (!node) return <Empty>等待根节点创建…</Empty>;
  return <div className="transcript-view"><div className="view-toolbar conversation-toolbar"><div className="transcript-selector"><AgentMark agent={node.agentId} small /><select aria-label="选择会话节点" value={node.id} onChange={event => setNodeId(event.target.value)}>{treeOrder(snapshot.nodes).map(entry => <option key={entry.id} value={entry.id}>{"　".repeat(entry.depth)}{nodeIsLive(snapshot, entry) ? "◉ " : ""}{entry.title} · {entry.agentId}{nodeIsLive(snapshot, entry) ? " · 运行中" : ""}</option>)}</select><Status status={node.status} /></div><div className="conversation-toolbar-actions"><ReasoningControls rows={rows} /><span className="muted">{messages.length} items</span><button className="text-button" onClick={() => inspect(node.id)} title="查看当前节点详情">节点详情 ↗</button></div></div>
    <div className="transcript-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}><div className="transcript-content">{itemStatus[node.id] === "loading" && <div className="loading-line">正在加载会话…</div>}{itemStatus[node.id] === "error" && <button className="button" onClick={() => { void store.loadItems(node.id, true); }}>重试加载会话</button>}{messages.map(({ row, outgoing }) => <TranscriptRow key={outgoing?.clientId ?? row.seq} row={row} node={node} snapshot={snapshot} inspect={inspect} outgoing={outgoing} actionState={state.messageActions[messageActionKey(node.id, row.seq)]} act={action => { void store.actOnMessage(node.id, row.seq, action); }} retry={outgoing ? () => { void store.sendMessage(node.id, outgoing.text, outgoing.clientId); } : undefined} streaming={live && inTurn(row) && (row.item.type === "reasoning" || (row.seq === latestText?.seq && phase?.kind === "reply"))} />)}{!messages.length && itemStatus[node.id] === "ready" && <Empty>这个节点还没有消息。</Empty>}<div ref={bottom} /></div></div>
    {phase && <ConversationStatus key={node.id} phase={phase} snapshot={snapshot} now={now} inspect={inspect} />}
    <div className="composer-tools"><BackgroundPopover projectName={projectName} key={snapshot.run.id} snapshot={snapshot} now={now} client={store.client} /></div>
    <QueueDock key={node.id} entries={queue} actions={state.messageActions} pending={queueState?.pending} error={queueState?.error} reorder={order => { void store.reorderQueue(node.id, order); }} act={(seq, action) => { void store.actOnMessage(node.id, seq, action); }} />
    <form className="composer" onSubmit={event => { event.preventDefault(); submit(); }}><textarea ref={input} aria-label="消息" placeholder={`向 ${node.agentId} 发送消息…${live ? "（运行中也可发送）" : ""}`} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} disabled={["canceled", "replaced"].includes(node.status)} rows={2} /><div className="composer-footer"><span title="送达方式会显示在消息旁">{live ? "运行中 · 发送后排队，可在消息上改为引导或立即发送" : "发送到当前节点"} · ⌘ / Ctrl + Enter</span><button className="button primary" disabled={!draft.trim() || ["canceled", "replaced"].includes(node.status)}><Icon name="arrow" size={15} />发送</button></div></form>
  </div>;
}
