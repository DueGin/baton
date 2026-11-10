import { Fragment, useEffect, useRef, useState } from "react";
import type { ItemRecord, NodeRecord, RunSnapshot, ToolCallDetail } from "@baton/protocol";
import { clock, treeOrder } from "../lib/derive.js";
import { AgentMark, Empty, Icon, Status } from "./common.js";
import type { RunStore } from "../store.js";
import { parseBatonMessage, type BatonMessagePart } from "../lib/baton-messages.js";

function Inline({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : <Fragment key={index}>{part}</Fragment>)}</>;
}
/** Deliberately small markdown renderer: React escapes every piece of agent content. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  return <div className="markdown">{blocks.map((block, index) => {
    if (block.startsWith("```")) { const newline = block.indexOf("\n"); const code = block.slice(newline + 1).replace(/```$/, ""); return <div className="code-block" key={index}><div className="code-language">{block.slice(3, newline) || "text"}</div><pre><code>{code}</code></pre></div>; }
    const lines = block.split("\n"); const groups: React.ReactNode[] = [];
    for (let line = 0; line < lines.length; line++) {
      const value = lines[line]!;
      if (/^\s*[-*]\s/.test(value) || /^\s*\d+\.\s/.test(value)) {
        const ordered = /^\s*\d+\./.test(value); const list: string[] = [];
        while (line < lines.length && (ordered ? /^\s*\d+\.\s/ : /^\s*[-*]\s/).test(lines[line]!)) { list.push(lines[line]!.replace(/^\s*(?:[-*]|\d+\.)\s/, "")); line++; }
        line--; const children = list.map((entry, i) => <li key={i}><Inline text={entry} /></li>); groups.push(ordered ? <ol key={line}>{children}</ol> : <ul key={line}>{children}</ul>);
      } else if (/^#{1,3} /.test(value)) groups.push(<h4 key={line}><Inline text={value.replace(/^#+ /, "")} /></h4>);
      else if (value.trim()) groups.push(<p key={line}><Inline text={value} /></p>);
    }
    return <Fragment key={index}>{groups}</Fragment>;
  })}</div>;
}

export function ToolDetail({ detail }: { detail: ToolCallDetail }) {
  switch (detail.type) {
    case "shell": return <><div className="tool-command">$ {detail.command}</div>{detail.cwd && <div className="detail-path">{detail.cwd}</div>}{detail.output && <pre>{detail.output}</pre>}{detail.exitCode !== undefined && <div className={`tool-exit ${detail.exitCode ? "error-text" : ""}`}>exit {detail.exitCode ?? "…"}</div>}</>;
    case "edit": return <><div className="detail-path">{detail.filePath}</div><div className="diff">{(detail.unifiedDiff ?? `--- before\n${detail.oldString ?? ""}\n+++ after\n${detail.newString ?? ""}`).split("\n").map((line, index) => <div key={index} className={line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : ""}>{line || " "}</div>)}</div></>;
    case "read": case "write": return <><div className="detail-path">{detail.filePath}{detail.type === "read" && detail.offset !== undefined ? ` · line ${detail.offset}` : ""}</div>{detail.content && <pre>{detail.content}</pre>}</>;
    case "search": return <><div className="tool-command">{detail.toolName ?? "search"}: {detail.query}</div>{detail.content && <pre>{detail.content}</pre>}{detail.filePaths && <pre>{detail.filePaths.join("\n")}</pre>}{detail.numMatches !== undefined && <div className="muted">{detail.numMatches} matches · {detail.numFiles ?? 0} files</div>}</>;
    case "fetch": return <><div className="detail-path">{detail.url} {detail.code && <span>· {detail.code}</span>}</div>{detail.prompt && <p>{detail.prompt}</p>}{detail.result && <pre>{detail.result}</pre>}</>;
    case "baton": return <><div className="detail-path">baton.{detail.tool}{detail.delegationId && ` · ${detail.delegationId}`}</div>{detail.input !== undefined && <pre>{JSON.stringify(detail.input, null, 2)}</pre>}{detail.output !== undefined && <pre>{JSON.stringify(detail.output, null, 2)}</pre>}</>;
    case "sub_agent": return <><p>{detail.description ?? detail.subAgentType ?? "Sub-agent"}</p>{detail.childSessionId && <code>{detail.childSessionId}</code>}{detail.actions?.map(action => <div key={action.index}>{action.toolName} · {action.summary}</div>)}</>;
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
      return <article key={index} className="protocol-card assignment-card"><div className="protocol-card-type"><span>↗ 任务书</span>{part.role && <span className="role-badge">{part.role}</span>}{part.readonly && <span className="tag">只读委派</span>}</div><button className="protocol-card-heading" disabled={!nodeId || !inspect} onClick={() => { if (nodeId) inspect?.(nodeId); }} title={nodeId ? "查看委派节点" : "委派节点不可用"}><strong>{part.title}</strong><span>↗</span></button><div className="protocol-card-body"><h4>任务</h4><Markdown text={part.task} />{part.context && <><h4>Context</h4><Markdown text={part.context} /></>}{part.acceptance.length > 0 && <><h4>验收标准</h4><ul>{part.acceptance.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul></>}</div></article>;
    }
    return <Fragment key={index}>{part.results.map((result, i) => {
      const nodeId = openNode(result.delegationId);
      const badge = { success: "✓ 完成", partial: "◐ 部分完成", failed: "✗ 失败" }[result.outcome];
      return <article key={`${result.delegationId}:${i}`} className={`protocol-card delivered-card outcome-${result.outcome}`}><div className="protocol-card-type"><span>↙ 结果送达</span><span className="result-outcome">{badge}</span></div><button className="protocol-card-heading" disabled={!nodeId || !inspect} onClick={() => { if (nodeId) inspect?.(nodeId); }} title={nodeId ? "查看子节点" : "委派节点不可用"}><strong>{result.title}</strong><span>↗</span></button><div className="protocol-card-body"><Markdown text={result.summary} />{result.resultText !== undefined && <details className="detail-disclosure"><summary>Result JSON</summary><pre>{result.resultText}</pre></details>}{result.artifactsText && <details className="detail-disclosure"><summary>Artifacts</summary><pre>{result.artifactsText}</pre></details>}{result.note && <p className="protocol-note">{result.note}</p>}</div></article>;
    })}</Fragment>;
  })}</div>;
}

export function TranscriptRow({ row, node, snapshot, inspect }: { row: ItemRecord; node: NodeRecord; snapshot?: RunSnapshot; inspect?: (id: string) => void }) {
  const item = row.item;
  if (item.type === "user_message") {
    const parts = parseBatonMessage(item.text);
    if (parts) return <BatonMessage parts={parts} snapshot={snapshot} inspect={inspect} />;
  }
  if (item.type === "reasoning") return <details className="reasoning-row"><summary>思考过程 <span>{item.text.length} 字</span></summary><Markdown text={item.text} /></details>;
  if (item.type === "tool_call") return <details className={`tool-row tool-${item.status}`}><summary><span className="tool-type">{item.detail.type}</span><span className="tool-summary">{toolSummary(item.detail)}</span><span className="tool-state">{item.status === "completed" ? "✓" : item.status === "running" ? "◌" : "✗"}</span></summary><div className="tool-body"><ToolDetail detail={item.detail} />{item.error && <div className="error-text">{item.error}</div>}</div></details>;
  if (item.type === "notice" || item.type === "error") return <div className={`notice-row ${item.type === "error" ? "error" : item.level}`}>{item.type === "error" ? "✗ " : "↳ "}{item.message}</div>;
  if (item.type === "todo") return <div className="todo-row">{item.items.map((todo, index) => <div key={index}><span>{todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◉" : "○"}</span>{todo.text}</div>)}</div>;
  return <article className={`message message-${item.type}`}><div className="message-meta">{item.type === "user_message" ? <span className="user-avatar">U</span> : <AgentMark agent={node.agentId} small />}<strong>{item.type === "user_message" ? "你" : node.agentId}</strong><time>{clock(row.ts)}</time></div><Markdown text={item.text} /></article>;
}

export function Transcript({ snapshot, store, items, itemStatus, nodeId, setNodeId, send, busy, inspect }: {
  snapshot: RunSnapshot; store: RunStore; items: Record<string, ItemRecord[]>; itemStatus: Record<string, string>;
  nodeId: string; setNodeId: (id: string) => void; send: (id: string, text: string) => Promise<boolean>; busy: boolean; inspect: (id: string) => void;
}) {
  const [draft, setDraft] = useState(""); const [follow, setFollow] = useState(true); const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null); const node = snapshot.nodes.find(entry => entry.id === nodeId) ?? snapshot.nodes[0];
  useEffect(() => { if (node) { void store.loadItems(node.id); setDraft(""); setFollow(true); } }, [node?.id, store]);
  const rows = items[nodeId] ?? [];
  useEffect(() => { if (follow) bottom.current?.scrollIntoView({ block: "end" }); }, [rows, follow]);
  const submit = async (): Promise<void> => { const text = draft.trim(); if (!text || !node || busy) return; if (await send(node.id, text)) { setDraft(""); setFollow(true); } };
  if (!node) return <Empty>等待根节点创建…</Empty>;
  return <div className="transcript-view"><div className="view-toolbar"><div className="transcript-selector"><AgentMark agent={node.agentId} small /><select aria-label="选择会话节点" value={node.id} onChange={event => setNodeId(event.target.value)}>{treeOrder(snapshot.nodes).map(entry => <option key={entry.id} value={entry.id}>{"　".repeat(entry.depth)}{entry.title} · {entry.agentId}</option>)}</select><Status status={node.status} /></div><span className="muted">{rows.length} items</span></div>
    <div className="transcript-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}><div className="transcript-content">{itemStatus[node.id] === "loading" && <div className="loading-line">正在加载会话…</div>}{itemStatus[node.id] === "error" && <button className="button" onClick={() => { void store.loadItems(node.id, true); }}>重试加载会话</button>}{rows.map(row => <TranscriptRow key={row.seq} row={row} node={node} snapshot={snapshot} inspect={inspect} />)}{!rows.length && itemStatus[node.id] === "ready" && <Empty>这个节点还没有消息。</Empty>}<div ref={bottom} /></div></div>
    <form className="composer" onSubmit={event => { event.preventDefault(); void submit(); }}><textarea aria-label="消息" placeholder={`向 ${node.agentId} 发送消息…`} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} disabled={["canceled", "replaced"].includes(node.status)} rows={3} /><div className="composer-footer"><span>发送到当前节点 · ⌘ / Ctrl + Enter</span><button className="button primary" disabled={!draft.trim() || busy || ["canceled", "replaced"].includes(node.status)}><Icon name="arrow" size={15} />发送</button></div></form>
  </div>;
}
