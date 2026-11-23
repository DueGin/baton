import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { AgentEntry, ItemRecord, NodeRecord, QuestionRecord, RunSnapshot, ToolCallDetail } from "@baton/protocol";
import { activeTurn, conversationPhase, conversationRows, messageActionKey, queuedRows, nodeIsLive, inFlightMessage, type OutgoingMessage, type MessageActionState, type MessageAction } from "../lib/conversation.js";
import { clock } from "../lib/derive.js";
import { AgentMark, Empty, Icon } from "./common.js";
import { SessionTabs } from "./SessionTabs.js";
import { SessionConfig } from "./SessionConfig.js";
import { shortcutLabel, useSendShortcut } from "../lib/send-shortcut.js";
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
import { AttachImageButton, LazyComposer, type ComposerHandle, type ComposerStatus } from "./composer-shell.js";
import { RollbackAction, RolledBackToggle, type RollbackProps } from "./RollbackMenu.js";
import { rolledBackGroups, rollbackTarget } from "../lib/rollback.js";
import { ConversationOutline } from "./ConversationOutline.js";
import { outlineItems } from "../lib/outline.js";
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
function BatonMessage({ parts, row, node, snapshot, inspect, refs }: { parts: BatonMessagePart[]; row: ItemRecord; node: NodeRecord; snapshot?: RunSnapshot; inspect?: (id: string) => void; refs: ReadonlyMap<string, RunSnapshot> }) {
  return <div className="baton-message agent-message-stack">{parts.map((part, index) => {
    if (part.type === "text") return <Markdown key={index} text={part.text} />;
    if (part.type === "answer") return <article key={index} className="message message-user_message human-answer"><div className="message-meta"><span className="user-avatar">U</span><strong>你的回答</strong><time dateTime={row.ts}>{clock(row.ts)}</time><code>{part.questionId}</code></div><Markdown text={part.text} /></article>;
    return <Fragment key={index}>{partAgentCards(part, row, node, snapshot, index, refs).map(card => <AgentMessageCard key={card.id} card={card} inspect={inspect} />)}</Fragment>;
  })}</div>;
}

function ReasoningRow({ id, text, streaming }: { id: string; text: string; streaming: boolean }) {
  const state = useSyncExternalStore(reasoningPreferences.subscribe, reasoningPreferences.getSnapshot, reasoningPreferences.getSnapshot);
  const open = reasoningOpen(state.preference, streaming, state.overrides.get(id));
  return <details className={`reasoning-row${streaming ? " reasoning-live" : ""}`} open={open}><summary onClick={event => { event.preventDefault(); reasoningPreferences.setBlocks([id], !open); }}>{streaming && <span className="live-dot" />}思考过程 <span>{text.length} 字{streaming ? " · 生成中" : ""}</span></summary><Markdown text={text} streaming={streaming} /></details>;
}
export function TranscriptRow({ row, node, snapshot, inspect, client, streaming = false, outgoing, retry, actionState, act, rollback, refs = EMPTY_REFS }: { row: ItemRecord; node: NodeRecord; snapshot?: RunSnapshot; refs?: ReadonlyMap<string, RunSnapshot>; client?: BatonClient; inspect?: (id: string) => void; streaming?: boolean; outgoing?: OutgoingMessage; retry?: () => void; actionState?: MessageActionState; act?: (action: MessageAction) => void; rollback?: RollbackProps }) {
  const item = row.item;
  if (item.type === "user_message" && ["queued", "retracted"].includes(item.delivery ?? "")) return null;
  if (item.type === "user_message") {
    const parts = parseBatonMessage(item.text);
    if (parts && !item.delivery && !outgoing) return <BatonMessage parts={parts} row={row} node={node} snapshot={snapshot} inspect={inspect} refs={refs} />;
  }
  const card = toolAgentCard(row, node, snapshot, refs);
  if (card) return <div className="agent-message-stack"><AgentMessageCard card={card} inspect={inspect} /></div>;
  if (item.type === "reasoning") return <ReasoningRow id={reasoningBlockId(row.nodeId, row.seq)} text={item.text} streaming={streaming} />;
  if (item.type === "tool_call") return <><details className={`tool-row tool-${item.status}`}><summary><span className="tool-type">{item.detail.type === "unknown" ? "tool" : item.detail.type}</span><span className="tool-summary">{toolSummary(item.detail, item.name)}</span><span className="tool-state">{item.status === "completed" ? "✓" : item.status === "running" ? "◌" : "✗"}</span></summary><div className="tool-body"><ToolDetail detail={item.detail} />{item.error && <Markdown text={item.error} />}</div></details>{item.images?.length ? <ToolImages images={item.images} /> : null}{snapshot && pullRequestsAtRow(snapshot, row).map(pr => <InlinePullRequest key={pr.id} pr={pr} snapshot={snapshot} client={client} inspect={inspect} />)}</>;
  if (item.type === "notice" || item.type === "error") return <div className={`notice-row ${item.type === "error" ? "error" : item.level}`}>{item.type === "error" ? "✗ " : "↳ "}<Markdown text={item.message} /></div>;
  if (item.type === "todo") return <div className="todo-row">{item.items.map((todo, index) => <div key={index}><span>{todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◉" : "○"}</span><Markdown text={todo.text} /></div>)}</div>;
  const delivery = item.type === "user_message" ? item.delivery ?? outgoing?.delivery : undefined;
  const canAct = act && row.seq > 0 && (!outgoing || outgoing.state === "accepted");
  return <article className={`message message-${item.type}${outgoing?.state === "failed" ? " message-send-failed" : ""}`} data-user-message={item.type === "user_message" && row.seq > 0 ? row.seq : undefined}>
    <div className="message-meta">{item.type === "user_message" ? <span className="user-avatar">U</span> : <AgentMark agent={node.agentId} small />}<strong>{item.type === "user_message" ? "你" : node.agentId}</strong><time dateTime={row.ts}>{clock(row.ts)}</time>{item.type === "user_message" && <DeliveryIcon delivery={delivery} interrupted={item.interrupted ?? outgoing?.interrupted} state={outgoing?.state} />}{item.type === "user_message" && <EditedMarker at={item.editedAt ?? outgoing?.editedAt} />}
      <div className="message-top-actions">{canAct && <MessageActionIcons delivery={delivery} state={actionState} act={action => { if (action !== "edit") act(action); }} />}{rollback && item.type === "user_message" && row.seq > 0 && (!outgoing || outgoing.state === "accepted") && <RollbackAction row={row} {...rollback} />}{outgoing?.state === "failed" && <button type="button" className="icon-button" aria-label="重试发送" title="重试发送" onClick={retry}><Icon name="refresh" size={15} /></button>}</div>
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
const EMPTY_REFS: ReadonlyMap<string, RunSnapshot> = new Map();

function nearTranscriptBottom(scroll: Pick<HTMLDivElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 24;
}

export function TranscriptScroll({ scroll, bottom, follow, setFollow, children }: {
  scroll: RefObject<HTMLDivElement | null>; bottom: RefObject<HTMLDivElement | null>; follow: boolean;
  setFollow: (follow: boolean) => void; children?: ReactNode;
}) {
  const jumpToBottom = () => {
    const viewport = scroll.current;
    viewport?.focus({ preventScroll: true });
    if (viewport && nearTranscriptBottom(viewport)) setFollow(true);
    const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    bottom.current?.scrollIntoView({ block: "end", behavior: reduceMotion ? "instant" : "smooth" });
  };
  return <>
    <div className="transcript-scroll" tabIndex={-1} ref={scroll} onScroll={event => setFollow(nearTranscriptBottom(event.currentTarget))}>
      <div className="transcript-content">{children}</div>
      <div ref={bottom} />
    </div>
    {!follow && <button type="button" className="icon-button transcript-to-bottom" aria-label="回到最新消息" title="回到最新消息" onClick={jumpToBottom}><Icon name="down" size={18} /></button>}
  </>;
}

/** Snapshots of the other runs, so a session message shows its sender even after switching runs (DESIGN §4.16). */
export function Transcript({ snapshot, store, items, itemStatus, nodeId, setNodeId, now, inspect, showTopology, projectName, answer, decline, busy, stopRun, resumeRun, agents = [], refs = EMPTY_REFS }: {
  refs?: ReadonlyMap<string, RunSnapshot>;
  agents?: AgentEntry[]; answer: HumanActions["answer"]; decline?: HumanActions["decline"]; busy: boolean; projectName?: string; stopRun?: () => void; resumeRun?: () => void; snapshot: RunSnapshot; store: RunStore; items: Record<string, ItemRecord[]>; itemStatus: Record<string, string>;
  nodeId: string; setNodeId: (id: string) => void; now: number; inspect: (id: string) => void; showTopology: (id: string) => void;
}) {
  const [follow, setFollow] = useState(true); const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const sendLabel = `发送（${shortcutLabel(useSendShortcut())}）`;
  const [composerStatus, setComposerStatus] = useState<ComposerStatus>({ empty: true, uploading: false, failed: false });
  const scroll = useRef<HTMLDivElement>(null); const node = snapshot.nodes.find(entry => entry.id === nodeId) ?? snapshot.nodes[0];
  const state = store.getSnapshot();
  // Relative image paths in this node's messages resolve against its working directory.
  const imageContext = useMemo(() => ({ client: store.client, cwd: node?.cwd }), [store.client, node?.cwd]);
  useEffect(() => { if (node) { void store.loadItems(node.id); setFollow(true); } }, [node?.id, store]);
  const rows = items[node?.id ?? nodeId] ?? [];
  const messages = conversationRows(rows, state.outgoing, node?.id ?? nodeId);
  const entries = inlineQuestionEntries(messages, snapshot.questions, node?.id ?? nodeId);
  const footers = turnFooters(entries, snapshot, node?.id ?? nodeId);
  // Rolled-back rows (DESIGN §4.13) hide behind one slim bar per run of rows; the bar reveals them greyed out.
  const rolled = rolledBackGroups(entries);
  const outlineAll = outlineItems(entries), outlineKey = outlineAll.map(item => `${item.seq}:${item.preview}`).join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content so the rail does not re-measure on every render
  const outline = useMemo(() => outlineAll, [outlineKey]);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const groupKey = (start: number): string => { const entry = entries[start]; return `${node?.id ?? nodeId}:${entry?.type === "row" ? entry.entry.row.seq : start}`; };
  const firstHuman = rows.find(row => row.item.type === "user_message")?.seq;
  const rollback: RollbackProps | undefined = node ? { client: store.client, nodeId: node.id, rows, rollback: (checkpointId, mode) => store.client.rollback(node.id, { checkpointId, mode }), done: response => {
    if (response.draft) composer.current?.setDraft(response.draft);
    else if (response.files) composer.current?.hint(response.files.length ? `已还原 ${response.files.length} 个文件` : "文件与快照一致，没有改动");
  } } : undefined;
  const dockQuestions = (snapshot.questions ?? []).filter(question => question.nodeId === (node?.id ?? nodeId) && question.status === "pending");
  const jumpQuestion = (id: string) => { const card = document.getElementById(questionCardId(id)); card?.scrollIntoView({ block: "nearest", behavior: "smooth" }); card?.focus({ preventScroll: true }); };
  const queueState = state.queues[node?.id ?? nodeId];
  const queue = queuedRows(rows, state.outgoing, node?.id ?? nodeId, queueState?.order);
  const pending = inFlightMessage(state.outgoing, rows, node?.id ?? nodeId, now);
  const phase = node ? conversationPhase(snapshot, node, rows, now, state.lastEventAt[node.id], pending) : null;
  const live = node ? nodeIsLive(snapshot, node) : false;
  const turn = node ? activeTurn(snapshot, node.id) : undefined;
  const latestText = rows.filter(row => row.item.type === "reasoning" || row.item.type === "assistant_message").at(-1);
  const inTurn = (row: ItemRecord) => turn ? row.turnId === turn.id || (!row.turnId && Date.parse(row.ts) >= Date.parse(turn.startedAt)) : false;
  useEffect(() => { if (follow) bottom.current?.scrollIntoView({ block: "end" }); }, [rows, state.outgoing, snapshot.questions, snapshot.turns, phase?.kind, follow]);
  useEffect(() => {
    const viewport = scroll.current; const content = viewport?.firstElementChild;
    if (!content || !viewport) return;
    const observer = new ResizeObserver(() => {
      if (follow) bottom.current?.scrollIntoView({ block: "end" });
      else if (nearTranscriptBottom(viewport)) setFollow(true);
    });
    observer.observe(content); observer.observe(viewport); return () => observer.disconnect();
  }, [follow, node?.id]);
  // An empty composer offers 停止 only if the selected node has an active turn. It still pauses the
  // whole run and interrupts all active turns; a paused run offers 继续 from any tab.
  const terminal = ["completed", "failed", "canceled"].includes(snapshot.run.status);
  // The draft is a Markdown document; any text or image in it turns the button back into 发送.
  const composerAction: "send" | "stop" | "resume" = !composerStatus.empty ? "send" : !terminal && live && stopRun ? "stop" : snapshot.run.status === "paused" && resumeRun ? "resume" : "send";
  const send = (markdown: string): void => { if (!node) return; setFollow(true); void store.sendMessage(node.id, markdown); };
  const agent = agents.find(entry => entry.id === node?.agentId);
  const imagesEnabled = agent?.capabilities.images === true;
  const closed = node ? ["canceled", "replaced"].includes(node.status) : false;
  if (!node) return <Empty>等待根节点创建…</Empty>;
  return <ImageContext value={imageContext}><div className="transcript-view"><div className="view-toolbar conversation-toolbar"><SessionTabs snapshot={snapshot} selected={node.id} select={setNodeId} inspect={inspect} showTopology={showTopology} /><div className="conversation-toolbar-actions"><span className="muted">{messages.length} items</span><button className="text-button" onClick={() => inspect(node.id)} title="查看当前节点详情">节点详情 ↗</button></div></div>
    <div className="transcript-body" id="session-content" role="tabpanel" aria-labelledby={`session-tab-${node.id}`}><TranscriptScroll scroll={scroll} bottom={bottom} follow={follow} setFollow={setFollow}>{itemStatus[node.id] === "loading" && <div className="loading-line">正在加载会话…</div>}{itemStatus[node.id] === "error" && <button className="button" onClick={() => { void store.loadItems(node.id, true); }}>重试加载会话</button>}{entries.map((entry, index) => {
      const start = rolled.start[index]!, key = start >= 0 ? groupKey(start) : "", hidden = start >= 0 && !revealed.has(key);
      const toggle = start === index ? <RolledBackToggle count={rolled.size.get(index)!} open={!hidden} toggle={() => setRevealed(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} /> : null;
      if (hidden) return toggle && <Fragment key={`rolled:${key}`}>{toggle}</Fragment>;
      const content = <>{entry.type === "question" ? entry.question.status === "pending" ? <QuestionMarker question={entry.question} jump={jumpQuestion} /> : <QuestionCard inline compact question={entry.question} answer={answer} busy={busy} /> : (() => { const { row, outgoing } = entry.entry; return <TranscriptRow client={store.client} refs={refs} row={row} node={node} snapshot={snapshot} inspect={inspect} outgoing={outgoing} actionState={state.messageActions[messageActionKey(node.id, row.seq)]} act={action => { void store.actOnMessage(node.id, row.seq, action); }} retry={outgoing ? () => { void store.sendMessage(node.id, outgoing.text, outgoing.clientId); } : undefined} streaming={live && inTurn(row) && (row.item.type === "reasoning" || (row.seq === latestText?.seq && phase?.kind === "reply"))} rollback={rollbackTarget(row, row.seq === firstHuman) ? rollback : undefined} />; })()}{footers.get(index)?.map(turn => <TurnFooter key={turn.id} turn={turn} />)}</>;
      return <Fragment key={entry.type === "question" ? entry.question.id : entry.entry.outgoing?.clientId ?? entry.entry.row.seq}>{toggle}{start >= 0 ? <div className="rolled-back-row">{content}</div> : content}</Fragment>;
    })}{!entries.length && itemStatus[node.id] === "ready" && <Empty>这个节点还没有消息。</Empty>}{phase && <TurnIndicator key={node.id} phase={phase} snapshot={snapshot} now={now} inspect={inspect} jumpQuestion={jumpQuestion} />}</TranscriptScroll><ConversationOutline items={outline} scroll={scroll} /></div>
    <div className="composer-stack">{dockQuestions.length > 0 && <div className="question-dock" aria-label="待回答的问题">{dockQuestions.map(question => <QuestionCard key={question.id} inline compact question={question} answer={answer} decline={decline} busy={busy} />)}</div>}
    <div className="composer-tools"><BackgroundPopover projectName={projectName} key={snapshot.run.id} snapshot={snapshot} now={now} client={store.client} inspect={inspect} /><PullRequestPopover key={`pr:${snapshot.run.id}`} snapshot={snapshot} client={store.client} inspect={inspect} /></div>
    <QueueDock key={node.id} entries={queue} actions={state.messageActions} pending={queueState?.pending} error={queueState?.error} reorder={order => { void store.reorderQueue(node.id, order); }} act={(seq, action) => store.actOnMessage(node.id, seq, action)} edit={(seq, text) => store.editMessage(node.id, seq, text)} />
    <form className="composer" onSubmit={event => { event.preventDefault(); composer.current?.submit(); }}
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={event => { if (event.defaultPrevented || !event.dataTransfer.types.includes("Files")) return; event.preventDefault(); composer.current?.attach([...event.dataTransfer.files]); }}>
      <LazyComposer key={node.id} ref={composer} nodeId={node.id} cwd={node.cwd} client={store.client} placeholder={`向 ${node.agentId} 发送消息…${live ? "（运行中也可发送）" : ""}`} disabled={closed} imagesEnabled={imagesEnabled} onSend={send} onStatus={setComposerStatus} />
      {composerStatus.hint ? <div className="composer-hint" role="status">{composerStatus.hint}</div> : snapshot.run.status === "paused" && <div className="composer-paused-hint" role="status">{snapshot.run.pauses?.at(-1)?.by === "restart" ? "baton 重启时有 agent 正在工作，会话已暂停 · 点「继续」让它们接着跑" : "会话已暂停，消息会在继续后送达"}</div>}
      <div className="composer-footer">{agent && <SessionConfig key={node.id} agent={agent} node={node} updateNodeConfig={store.updateNodeConfig} />}<div className="composer-actions"><AttachImageButton enabled={imagesEnabled} disabled={closed} attach={files => composer.current?.attach(files)} />{composerAction === "stop" ? <button type="button" className="button composer-stop composer-icon-action" disabled={busy} aria-label="停止（暂停整个 Run）" title="暂停本 Run：中断所有正在工作的 agent（可继续）" onClick={() => stopRun?.()}><Icon name="stop" size={13} /></button>
      : composerAction === "resume" ? <button type="button" className="button primary composer-resume composer-icon-action" disabled={busy} aria-label="继续" title="继续本会话" onClick={() => resumeRun?.()}><Icon name="play" size={13} /></button>
      : <button className="button primary composer-send composer-icon-action" disabled={composerStatus.empty || closed || composerStatus.uploading} aria-label={sendLabel} title={`${sendLabel}${composerStatus.uploading ? " · 图片上传中…" : composerStatus.failed ? " · 有图片上传失败" : ""}`}><Icon name="arrow" size={15} /></button>}</div></div></form></div>
  </div></ImageContext>;
}
