import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentEntry, ItemRecord, NodeRecord, QuestionRecord, RunSnapshot, ToolCallDetail } from "@baton/protocol";
import { activeTurn, conversationPhase, conversationRows, messageActionKey, queuedRows, nodeIsLive, inFlightMessage, type OutgoingMessage, type MessageActionState, type MessageAction } from "../lib/conversation.js";
import { composerHeight } from "../lib/run-layout.js";
import { clock, displayStatus, treeOrder } from "../lib/derive.js";
import { AgentMark, Empty, Icon, Status } from "./common.js";
import type { RunStore } from "../store.js";
import { AgentMessageCard } from "./AgentMessageCard.js";
import { partAgentCards, toolAgentCard } from "../lib/agent-messages.js";
import { parseBatonMessage, type BatonMessagePart } from "../lib/baton-messages.js";

import { Markdown } from "./Markdown.js";
import { reasoningBlockId, reasoningOpen, reasoningPreferences } from "../lib/reasoning.js";
import type { BatonClient } from "../api.js";
import { pullRequestsAtRow } from "../lib/pull-requests.js";
import { InlinePullRequest, PullRequestPopover } from "./PullRequests.js";
import { BackgroundPopover } from "./BackgroundProcesses.js";
import { QuestionCard } from "./QuestionCard.js";
import { inlineQuestionEntries, questionCardId, questionPrompts } from "../lib/questions.js";
import type { HumanActions } from "./HumanActions.js";
import { QueueDock } from "./QueueDock.js";
import { DeliveryIcon, EditedMarker, MessageActionIcons } from "./MessageActions.js";
import { turnFooters } from "../lib/turns.js";
import { TurnFooter, TurnIndicator } from "./TurnIndicator.js";
import { markdownPlainText } from "../lib/markdown.js";
import { ToolImages } from "./Images.js";
import { ImageContext } from "../lib/images.js";
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

export function toolSummary(detail: ToolCallDetail, name = "tool"): string {
  if (detail.type === "unknown") {
    const input = detail.input;
    const summary = typeof input === "string" ? input : input === undefined || input === null ? "" : JSON.stringify(input);
    return `${name}${summary && summary !== "{}" ? ` · ${summary.replace(/\s+/g, " ").slice(0, 100)}` : ""}`;
  }
  if (detail.type === "shell") return detail.command;
  if ("filePath" in detail) return detail.filePath;
  if (detail.type === "search") return detail.query;
  if (detail.type === "fetch") return detail.url;
  if (detail.type === "baton") return detail.tool;
  return detail.type;
}
function BatonMessage({ parts, row, node, snapshot, inspect }: { parts: BatonMessagePart[]; row: ItemRecord; node: NodeRecord; snapshot?: RunSnapshot; inspect?: (id: string) => void }) {
  return <div className="baton-message agent-message-stack">{parts.map((part, index) => {
    if (part.type === "text") return <Markdown key={index} text={part.text} />;
    if (part.type === "answer") return <article key={index} className="message message-user_message human-answer"><div className="message-meta"><span className="user-avatar">U</span><strong>你的回答</strong><time dateTime={row.ts}>{clock(row.ts)}</time><code>{part.questionId}</code></div><Markdown text={part.text} /></article>;
    return <Fragment key={index}>{partAgentCards(part, row, node, snapshot, index).map(card => <AgentMessageCard key={card.id} card={card} inspect={inspect} />)}</Fragment>;
  })}</div>;
}

function ReasoningRow({ id, text, streaming }: { id: string; text: string; streaming: boolean }) {
  const state = useSyncExternalStore(reasoningPreferences.subscribe, reasoningPreferences.getSnapshot, reasoningPreferences.getSnapshot);
  const open = reasoningOpen(state.preference, streaming, state.overrides.get(id));
  return <details className={`reasoning-row${streaming ? " reasoning-live" : ""}`} open={open}><summary onClick={event => { event.preventDefault(); reasoningPreferences.setBlocks([id], !open); }}>{streaming && <span className="live-dot" />}思考过程 <span>{text.length} 字{streaming ? " · 生成中" : ""}</span></summary><Markdown text={text} streaming={streaming} /></details>;
}
export function TranscriptRow({ row, node, snapshot, inspect, client, streaming = false, outgoing, retry, actionState, act }: { row: ItemRecord; node: NodeRecord; snapshot?: RunSnapshot; client?: BatonClient; inspect?: (id: string) => void; streaming?: boolean; outgoing?: OutgoingMessage; retry?: () => void; actionState?: MessageActionState; act?: (action: MessageAction) => void }) {
  const item = row.item;
  if (item.type === "user_message" && ["queued", "retracted"].includes(item.delivery ?? "")) return null;
  if (item.type === "user_message") {
    const parts = parseBatonMessage(item.text);
    if (parts && !item.delivery && !outgoing) return <BatonMessage parts={parts} row={row} node={node} snapshot={snapshot} inspect={inspect} />;
  }
  const card = toolAgentCard(row, node, snapshot);
  if (card) return <div className="agent-message-stack"><AgentMessageCard card={card} inspect={inspect} /></div>;
  if (item.type === "reasoning") return <ReasoningRow id={reasoningBlockId(row.nodeId, row.seq)} text={item.text} streaming={streaming} />;
  if (item.type === "tool_call") return <><details className={`tool-row tool-${item.status}`}><summary><span className="tool-type">{item.detail.type === "unknown" ? "tool" : item.detail.type}</span><span className="tool-summary">{toolSummary(item.detail, item.name)}</span><span className="tool-state">{item.status === "completed" ? "✓" : item.status === "running" ? "◌" : "✗"}</span></summary><div className="tool-body"><ToolDetail detail={item.detail} />{item.error && <Markdown text={item.error} />}</div></details>{item.images?.length ? <ToolImages images={item.images} /> : null}{snapshot && pullRequestsAtRow(snapshot, row).map(pr => <InlinePullRequest key={pr.id} pr={pr} snapshot={snapshot} client={client} inspect={inspect} />)}</>;
  if (item.type === "notice" || item.type === "error") return <div className={`notice-row ${item.type === "error" ? "error" : item.level}`}>{item.type === "error" ? "✗ " : "↳ "}<Markdown text={item.message} /></div>;
  if (item.type === "todo") return <div className="todo-row">{item.items.map((todo, index) => <div key={index}><span>{todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◉" : "○"}</span><Markdown text={todo.text} /></div>)}</div>;
  const delivery = item.type === "user_message" ? item.delivery ?? outgoing?.delivery : undefined;
  const canAct = act && row.seq > 0 && (!outgoing || outgoing.state === "accepted");
  return <article className={`message message-${item.type}${outgoing?.state === "failed" ? " message-send-failed" : ""}`}>
    <div className="message-meta">{item.type === "user_message" ? <span className="user-avatar">U</span> : <AgentMark agent={node.agentId} small />}<strong>{item.type === "user_message" ? "你" : node.agentId}</strong><time dateTime={row.ts}>{clock(row.ts)}</time>{item.type === "user_message" && <DeliveryIcon delivery={delivery} interrupted={item.interrupted ?? outgoing?.interrupted} state={outgoing?.state} />}{item.type === "user_message" && <EditedMarker at={item.editedAt ?? outgoing?.editedAt} />}
      <div className="message-top-actions">{canAct && <MessageActionIcons delivery={delivery} state={actionState} act={action => { if (action !== "edit") act(action); }} />}{outgoing?.state === "failed" && <button type="button" className="icon-button" aria-label="重试发送" title="重试发送" onClick={retry}><Icon name="refresh" size={15} /></button>}</div>
    </div>
    <Markdown text={item.text} streaming={streaming && item.type === "assistant_message"} />
    {actionState?.error && <div className="error-text send-error" role="alert">{actionState.error}</div>}
    {outgoing?.state === "failed" && <div className="error-text send-error">{outgoing.error}</div>}
  </article>;
}

// A pending question lives in the dock above the composer; the transcript keeps a slim marker at the
// point where it was asked so the conversation still reads in order.
function QuestionMarker({ question, jump }: { question: QuestionRecord; jump: (id: string) => void }) {
  const prompts = questionPrompts(question);
  return <button type="button" className="question-marker" onClick={() => jump(question.id)} title="跳到输入框上方的问题卡片"><i aria-hidden="true" /><strong>等你回答</strong><span>{markdownPlainText(prompts[0]?.question ?? question.question)}{prompts.length > 1 ? ` 等 ${prompts.length} 个问题` : ""}</span><small>在输入框上方作答 ↓</small></button>;
}
export function Transcript({ snapshot, store, items, itemStatus, nodeId, setNodeId, now, inspect, projectName, answer, decline, busy, stopRun, resumeRun }: {
  agents?: AgentEntry[]; answer: HumanActions["answer"]; decline?: HumanActions["decline"]; busy: boolean; projectName?: string; stopRun?: () => void; resumeRun?: () => void; snapshot: RunSnapshot; store: RunStore; items: Record<string, ItemRecord[]>; itemStatus: Record<string, string>;
  nodeId: string; setNodeId: (id: string) => void; now: number; inspect: (id: string) => void;
}) {
  const [draft, setDraft] = useState(""); const [follow, setFollow] = useState(true); const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null); const node = snapshot.nodes.find(entry => entry.id === nodeId) ?? snapshot.nodes[0];
  const state = store.getSnapshot();
  // Relative image paths in this node's messages resolve against its working directory.
  const imageContext = useMemo(() => ({ client: store.client, cwd: node?.cwd }), [store.client, node?.cwd]);
  useEffect(() => { if (node) { void store.loadItems(node.id); setDraft(""); setFollow(true); } }, [node?.id, store]);
  const rows = items[node?.id ?? nodeId] ?? [];
  const messages = conversationRows(rows, state.outgoing, node?.id ?? nodeId);
  const entries = inlineQuestionEntries(messages, snapshot.questions, node?.id ?? nodeId);
  const footers = turnFooters(entries, snapshot, node?.id ?? nodeId);
  const dockQuestions = (snapshot.questions ?? []).filter(question => question.nodeId === (node?.id ?? nodeId) && question.status === "pending");
  const jumpQuestion = (id: string) => { const card = document.getElementById(questionCardId(id)); card?.scrollIntoView({ block: "nearest", behavior: "smooth" }); card?.focus({ preventScroll: true }); };
  const queueState = state.queues[node?.id ?? nodeId];
  const queue = queuedRows(rows, state.outgoing, node?.id ?? nodeId, queueState?.order);
  const pending = inFlightMessage(state.outgoing, rows, node?.id ?? nodeId, now);
  const phase = node ? conversationPhase(snapshot, node, rows, now, state.lastEventAt[node.id], pending) : null;
  const live = snapshot.run.status !== "paused" && node ? nodeIsLive(snapshot, node) : false;
  const turn = node ? activeTurn(snapshot, node.id) : undefined;
  const latestText = rows.filter(row => row.item.type === "reasoning" || row.item.type === "assistant_message").at(-1);
  const inTurn = (row: ItemRecord) => turn ? row.turnId === turn.id || (!row.turnId && Date.parse(row.ts) >= Date.parse(turn.startedAt)) : false;
  useEffect(() => { if (follow) bottom.current?.scrollIntoView({ block: "end" }); }, [rows, state.outgoing, snapshot.questions, snapshot.turns, phase?.kind, follow]);
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
  // Empty composer + agents still working anywhere in this run → the send button becomes 停止 (pause the
  // whole run: every running turn is interrupted and nothing restarts on its own); a paused run offers 继续.
  const terminal = ["completed", "failed", "canceled"].includes(snapshot.run.status);
  const runWorking = !terminal && snapshot.run.status !== "paused" && snapshot.nodes.some(entry => nodeIsLive(snapshot, entry));
  const composerAction: "send" | "stop" | "resume" = draft.trim() ? "send" : runWorking && stopRun ? "stop" : snapshot.run.status === "paused" && resumeRun ? "resume" : "send";
  const submit = (): void => { const text = draft.trim(); if (!text || !node) return; setDraft(""); setFollow(true); void store.sendMessage(node.id, text); };
  if (!node) return <Empty>等待根节点创建…</Empty>;
  return <ImageContext value={imageContext}><div className="transcript-view"><div className="view-toolbar conversation-toolbar"><div className="transcript-selector"><AgentMark agent={node.agentId} small /><select aria-label="选择会话节点" value={node.id} onChange={event => setNodeId(event.target.value)}>{treeOrder(snapshot.nodes).map(entry => <option key={entry.id} value={entry.id}>{"　".repeat(entry.depth)}{snapshot.run.status === "paused" && !["canceled", "completed", "failed", "replaced"].includes(entry.status) ? "⏸ " : nodeIsLive(snapshot, entry) ? "◉ " : ""}{entry.title} · {entry.agentId}{nodeIsLive(snapshot, entry) ? " · 运行中" : ""}</option>)}</select><Status status={displayStatus(node, snapshot)} /></div><div className="conversation-toolbar-actions"><span className="muted">{messages.length} items</span><button className="text-button" onClick={() => inspect(node.id)} title="查看当前节点详情">节点详情 ↗</button></div></div>
    <div className="transcript-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}><div className="transcript-content">{itemStatus[node.id] === "loading" && <div className="loading-line">正在加载会话…</div>}{itemStatus[node.id] === "error" && <button className="button" onClick={() => { void store.loadItems(node.id, true); }}>重试加载会话</button>}{entries.map((entry, index) => <Fragment key={entry.type === "question" ? entry.question.id : entry.entry.outgoing?.clientId ?? entry.entry.row.seq}>{entry.type === "question" ? entry.question.status === "pending" ? <QuestionMarker question={entry.question} jump={jumpQuestion} /> : <QuestionCard inline compact question={entry.question} answer={answer} busy={busy} /> : (() => { const { row, outgoing } = entry.entry; return <TranscriptRow client={store.client} row={row} node={node} snapshot={snapshot} inspect={inspect} outgoing={outgoing} actionState={state.messageActions[messageActionKey(node.id, row.seq)]} act={action => { void store.actOnMessage(node.id, row.seq, action); }} retry={outgoing ? () => { void store.sendMessage(node.id, outgoing.text, outgoing.clientId); } : undefined} streaming={live && inTurn(row) && (row.item.type === "reasoning" || (row.seq === latestText?.seq && phase?.kind === "reply"))} />; })()}{footers.get(index)?.map(turn => <TurnFooter key={turn.id} turn={turn} />)}</Fragment>)}{!entries.length && itemStatus[node.id] === "ready" && <Empty>这个节点还没有消息。</Empty>}{phase && <TurnIndicator key={node.id} phase={phase} snapshot={snapshot} now={now} inspect={inspect} jumpQuestion={jumpQuestion} />}<div ref={bottom} /></div></div>
    <div className="composer-stack">{dockQuestions.length > 0 && <div className="question-dock" aria-label="待回答的问题">{dockQuestions.map(question => <QuestionCard key={question.id} inline compact question={question} answer={answer} decline={decline} busy={busy} />)}</div>}
    <div className="composer-tools"><BackgroundPopover projectName={projectName} key={snapshot.run.id} snapshot={snapshot} now={now} client={store.client} /><PullRequestPopover key={`pr:${snapshot.run.id}`} snapshot={snapshot} client={store.client} inspect={inspect} /></div>
    <QueueDock key={node.id} entries={queue} actions={state.messageActions} pending={queueState?.pending} error={queueState?.error} reorder={order => { void store.reorderQueue(node.id, order); }} act={(seq, action) => store.actOnMessage(node.id, seq, action)} edit={(seq, text) => store.editMessage(node.id, seq, text)} />
    <form className="composer" onSubmit={event => { event.preventDefault(); submit(); }}><textarea ref={input} aria-label="消息" placeholder={`向 ${node.agentId} 发送消息…${live ? "（运行中也可发送）" : ""}`} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} disabled={["canceled", "replaced"].includes(node.status)} rows={2} /><div className="composer-footer"><span title="送达方式会显示在消息旁">{snapshot.run.status === "paused" ? "会话已暂停，消息会在继续后送达" : live ? "运行中 · 发送后排队，可在消息上改为引导或立即发送" : "发送到当前节点"} · ⌘ / Ctrl + Enter</span>{composerAction === "stop" ? <button type="button" className="button composer-stop" disabled={busy} title="停止本会话中所有正在工作的 agent（可继续）" onClick={() => stopRun?.()}><Icon name="stop" size={13} />停止</button>
      : composerAction === "resume" ? <button type="button" className="button primary composer-resume" disabled={busy} title="继续本会话" onClick={() => resumeRun?.()}><Icon name="play" size={13} />继续</button>
      : <button className="button primary" disabled={!draft.trim() || ["canceled", "replaced"].includes(node.status)}><Icon name="arrow" size={15} />发送</button>}</div></form></div>
  </div></ImageContext>;
}
