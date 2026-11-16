import { useEffect, useId, useState } from "react";
import type { RunSnapshot, TurnRecord } from "@baton/protocol";
import { phaseTimerLabel, type ConversationPhase } from "../lib/conversation.js";
import { startTurnTicker, turnElapsed, turnFooter, turnTokens } from "../lib/turns.js";
import { Icon } from "./common.js";
import { Markdown } from "./Markdown.js";

export function TurnIndicator({ phase, snapshot, now: sharedNow, inspect, jumpQuestion }: { jumpQuestion?: (id: string) => void; phase: ConversationPhase; snapshot: RunSnapshot; now?: number; inspect: (id: string) => void }) {
  const [localNow, setNow] = useState(Date.now); const now = sharedNow ?? localNow;
  const [expanded, setExpanded] = useState(false); const previewId = useId();
  useEffect(() => sharedNow === undefined ? startTurnTicker(setNow) : undefined, [sharedNow]);
  const linkedNode = (id: string) => snapshot.nodes.find(node => node.id === id);
  return <div className={`turn-indicator motion-safe phase-${phase.kind}`} aria-label="当前回合状态">
    <div className="turn-indicator-line"><span className="turn-thinking-dots" aria-hidden="true"><i /><i /><i /></span><strong className="turn-phase-title" title={phase.label} role="status">{phase.label}</strong>
      {phase.toolSince && <span className="turn-tool-time">工具 {turnElapsed(phase.toolSince, now)}</span>}<span className="turn-elapsed">{phaseTimerLabel(phase)} {turnElapsed(phase.since, now)}</span>
      {phase.quiet > 30 && <span className="quiet-label">已 {phase.quiet}s 无新输出</span>}{phase.tokens !== undefined && <span className="turn-token-count">{turnTokens(phase.tokens)} tokens</span>}
      <div className="turn-inline-links">{phase.related.map(id => <button type="button" className="text-button" key={id} title={linkedNode(id)?.title} onClick={() => { if (phase.kind === "question") jumpQuestion?.(id); else inspect(id); }}>{phase.kind === "permission" ? "处理授权 ↗" : phase.kind === "question" ? "回答问题 ↗" : `${linkedNode(id)?.title ?? "子任务"} ↗`}</button>)}</div>
      {phase.reasoning && <button type="button" className={`icon-button turn-preview-toggle${expanded ? " expanded" : ""}`} aria-label={expanded ? "收起实时思考" : "展开实时思考"} aria-expanded={expanded} aria-controls={previewId} onClick={() => setExpanded(value => !value)}><Icon name="chevron" size={13} /></button>}
    </div>{phase.reasoning && expanded && <div id={previewId} className="turn-reasoning-preview"><Markdown text={phase.reasoning} streaming /></div>}
  </div>;
}
export function TurnFooter({ turn }: { turn: TurnRecord }) {
  const value = turnFooter(turn);
  return <div className={`turn-footer turn-footer-${turn.status}`} data-turn-footer={turn.id} title={turn.endedAt ? new Date(turn.endedAt).toLocaleString("zh-CN") : undefined}><span className="turn-footer-status">{value.label}</span>{value.elapsed && <span>用时 {value.elapsed}</span>}{value.tokens !== undefined && <span>· {turnTokens(value.tokens)} tokens</span>}{value.trigger && <span className="turn-trigger-note">· {value.trigger}</span>}{value.error && <span className="turn-footer-error">· {value.error}</span>}</div>;
}
