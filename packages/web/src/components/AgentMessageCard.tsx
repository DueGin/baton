import { useId, useState, useSyncExternalStore } from "react";
import { agentCardPreferences } from "../lib/agent-card-preferences.js";
import { outcomeIcons, type AgentCardData } from "../lib/agent-messages.js";
import { clock, statusLabels } from "../lib/derive.js";
import { AgentIcon, ModelIcon } from "./AgentIcon.js";
import { Icon, Toggle } from "./common.js";
import { Markdown } from "./Markdown.js";

export function AgentMessagePreference() {
  const { defaultOpen } = useSyncExternalStore(agentCardPreferences.subscribe, agentCardPreferences.getSnapshot, agentCardPreferences.getSnapshot);
  return <div className="settings-row"><div><strong>agent 消息卡片默认展开</strong><p>任务书、追问、结果与通知的默认显示；已手动切换的卡片在本页保留选择。</p></div><Toggle label="agent 消息卡片默认展开" checked={defaultOpen} onChange={agentCardPreferences.setDefault} /></div>;
}
function CardBody({ card }: { card: AgentCardData }) {
  const body = card.body;
  if (body.type === "assignment") {
    const part = body.assignment;
    return <><h4>任务</h4><Markdown text={part.task} />{part.context && <><h4>Context</h4><Markdown text={part.context} /></>}{part.acceptance.length > 0 && <><h4>验收标准</h4><ul>{part.acceptance.map((value, index) => <li key={index}><Markdown text={value} /></li>)}</ul></>}{part.readonly && <span className="tag">只读委派</span>}{part.outputSchema && <details className="detail-disclosure"><summary>Output schema</summary><pre>{part.outputSchema}</pre></details>}</>;
  }
  if (body.type === "result") {
    const result = body.result;
    return <><Markdown text={result.summary} />{result.resultText !== undefined && <details className="detail-disclosure"><summary>Result JSON</summary><pre>{result.resultText}</pre></details>}{result.artifactsText && <details className="detail-disclosure"><summary>Artifacts</summary><pre>{result.artifactsText}</pre></details>}{result.note && <Markdown text={result.note} />}</>;
  }
  return <><Markdown text={body.text} />{body.detail && <details className="detail-disclosure"><summary>调用详情</summary><pre>{JSON.stringify({ ...(body.detail.type === "baton" ? { tool: body.detail.tool } : {}), ...("input" in body.detail ? { input: body.detail.input } : {}), ...("output" in body.detail ? { output: body.detail.output } : {}) }, null, 2)}</pre></details>}{body.error && <div className="error-text"><Markdown text={body.error} /></div>}</>;
}
/** Compact row/disclosure structure adapted from Orca NativeChatAgentMessageCard (MIT).
 * Reference: Orca NativeChatAgentMessageCard.tsx (MIT); rewritten for baton protocol, CSS and disclosure store.
 */
export function AgentMessageCard({ card, inspect }: { card: AgentCardData; inspect?: (id: string) => void }) {
  const state = useSyncExternalStore(agentCardPreferences.subscribe, agentCardPreferences.getSnapshot, agentCardPreferences.getSnapshot);
  const open = state.overrides.get(card.id) ?? state.defaultOpen; const headingId = useId(); const bodyId = useId();
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const to = card.counterpart;
  const copy = () => { void Promise.resolve().then(() => navigator.clipboard.writeText(card.copyText)).then(() => setCopied("copied"), () => setCopied("failed")); };
  return <article className={`agent-message-card agent-card-${card.kind}${open ? " is-open" : ""}`} data-agent-card={card.kind}>
    <div className="agent-card-row"><button type="button" className="agent-card-toggle" title={`${card.heading} · ${card.title}`} aria-labelledby={headingId} aria-expanded={open} aria-controls={bodyId} onClick={() => agentCardPreferences.toggle(card.id)} />
      <span className="agent-card-avatar"><AgentIcon agent={to.agentId} size={17} /><i className={`agent-card-state state-${to.status}`} title={statusLabels[to.status] ?? to.status} /></span>
      <span className="agent-card-direction" title={card.heading}>{card.heading}</span>
      <button type="button" className="agent-card-counterpart" disabled={!to.nodeId || !inspect} title={`${to.title ?? to.role}\n${to.agentId}${to.model ? ` · ${to.model}` : ""}${to.nodeId ? " · 查看节点详情" : " · 节点尚未创建或不可用"}`} aria-label={`查看 ${to.role} 节点`} onClick={() => { if (to.nodeId) inspect?.(to.nodeId); }}><strong>{to.role}</strong><span>{to.agentId}{to.model ? <> · <ModelIcon model={to.model} size={11} />{to.model}</> : ""}</span></button>
      <strong className="agent-card-title" id={headingId} title={card.title}>{card.title}</strong>
      {card.outcome && <span className={`agent-card-outcome outcome-${card.outcome}`} title={{ success: "完成", partial: "部分完成", failed: "失败" }[card.outcome]} aria-label={`结果：${card.outcome}`}>{outcomeIcons[card.outcome]}</span>}
      <button type="button" className="icon-button agent-card-copy" aria-label={copied === "copied" ? "已复制消息" : copied === "failed" ? "复制失败，重试" : "复制消息"} title={copied === "copied" ? "已复制" : copied === "failed" ? "复制失败，重试" : "复制消息"} onClick={copy}><Icon name={copied === "copied" ? "check" : "copy"} size={12} /></button>
      <time className="agent-card-time" dateTime={card.ts} title={new Date(card.ts).toLocaleString("zh-CN", { hour12: false })}>{clock(card.ts)}</time><Icon name="chevron" size={12} />
    </div><div className="agent-card-body" id={bodyId} hidden={!open}>{open && <CardBody card={card} />}</div>
  </article>;
}
