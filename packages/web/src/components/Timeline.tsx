import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RunSnapshot } from "@baton/protocol";
import { agentColors, clock, duration, treeOrder } from "../lib/derive.js";
import { fitTime, niceTicks, panTime, timeX, waitingIntervals, zoomTime, type TimeViewport } from "../lib/timeline.js";
import { Toggle } from "./common.js";

const ROW = 44; const HEADER = 40;
const triggerColors: Record<string, string> = { user: "#5b8fce", delegation: "#8b7acb", result: "#37a28d", followup: "#c79852", correction: "#cf7a64" };
const toolColors: Record<string, string> = { shell: "#cf9b41", read: "#4c9bd4", edit: "#ae79d3", write: "#df80ad", search: "#35b2a7", fetch: "#7184df", baton: "#d57759", plan: "#9aaf4a", sub_agent: "#a08ce0", plain_text: "#8398a6" };

export function Timeline({ snapshot, now, inspect }: { snapshot: RunSnapshot; now: number; inspect: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1100);
  const [gutter, setGutter] = useState(260);
  const [view, setView] = useState<TimeViewport>(() => fitTime(snapshot, now));
  const [follow, setFollow] = useState(true);
  const drag = useRef<{ x: number; view: TimeViewport; moved: boolean } | null>(null);
  const resizing = useRef(false);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const pattern = useId().replace(/:/g, "");
  useEffect(() => { const observer = new ResizeObserver(entries => { const size = entries[0]?.contentRect.width; if (size) setWidth(Math.max(640, size)); }); if (container.current) observer.observe(container.current); return () => observer.disconnect(); }, []);
  useEffect(() => { if (follow) setView(fitTime(snapshot, now)); }, [follow, now, snapshot]);
  const rows = useMemo(() => treeOrder(snapshot.nodes), [snapshot.nodes]);
  const index = useMemo(() => new Map(rows.map((node, row) => [node.id, row])), [rows]);
  const grouped = useMemo(() => {
    const groups = new Map<string, { turns: RunSnapshot["turns"]; tools: RunSnapshot["toolSpans"]; permissions: RunSnapshot["permissions"] }>();
    const group = (nodeId: string) => { let value = groups.get(nodeId); if (!value) { value = { turns: [], tools: [], permissions: [] }; groups.set(nodeId, value); } return value; };
    snapshot.turns.forEach(turn => group(turn.nodeId).turns.push(turn));
    snapshot.toolSpans.forEach(span => group(span.nodeId).tools.push(span));
    snapshot.permissions.forEach(permission => group(permission.nodeId).permissions.push(permission));
    return groups;
  }, [snapshot.turns, snapshot.toolSpans, snapshot.permissions]);
  const chartWidth = Math.max(200, width - gutter - 20);
  const x = (time: string | number): number => gutter + timeX(typeof time === "string" ? Date.parse(time) : time, view, chartWidth);
  const band = (start: string | number, end?: string | number) => ({ x: x(start), width: Math.max(2, x(end ?? now) - x(start)) });
  const hover = (event: React.MouseEvent, text: string): void => setTooltip({ x: event.clientX, y: event.clientY, text });
  const height = Math.max(280, rows.length * ROW + HEADER + 20);
  return <div className="timeline-view" ref={container}><div className="view-toolbar"><span className="eyebrow">EXECUTION TIMELINE</span><div className="toolbar-actions"><span className="muted timeline-hint">滚轮缩放 · 拖拽平移</span><Toggle checked={follow} onChange={setFollow} label="跟随现在" /><button className="button small" onClick={() => { setView(fitTime(snapshot, now)); setFollow(true); }}>适应时间</button></div></div>
    <div className="timeline-scroll"><svg className="timeline-svg" width={width} height={height} role="img" aria-label="节点执行时间线，滚轮缩放、拖动平移，点击行查看节点详情"
      onWheel={event => { const bounds = event.currentTarget.getBoundingClientRect(); const anchor = (event.clientX - bounds.left - gutter) / chartWidth; if (anchor >= 0) { setFollow(false); setView(current => zoomTime(current, Math.exp(event.deltaY * 0.002), anchor)); } }}
      onPointerDown={event => { if (event.button !== 0) return; const px = event.clientX - event.currentTarget.getBoundingClientRect().left; resizing.current = Math.abs(px - gutter) <= 6; drag.current = resizing.current ? null : { x: event.clientX, view, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => {
        if (resizing.current) { const px = event.clientX - event.currentTarget.getBoundingClientRect().left; setGutter(Math.max(220, Math.min(420, width - 220, px))); setTooltip(null); }
        else if (drag.current) { const delta = event.clientX - drag.current.x; if (Math.abs(delta) > 4) { drag.current.moved = true; setFollow(false); setView(panTime(drag.current.view, delta, chartWidth)); setTooltip(null); } }
      }}
      onPointerUp={event => { if (!resizing.current && drag.current && !drag.current.moved) { const bounds = event.currentTarget.getBoundingClientRect(); const row = Math.floor((event.clientY - bounds.top - HEADER) / ROW); if (rows[row]) inspect(rows[row].id); } resizing.current = false; drag.current = null; }}
      onPointerCancel={() => { drag.current = null; resizing.current = false; }} onMouseLeave={() => setTooltip(null)}>
      <defs><pattern id={`${pattern}-hatch`} patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(40)"><rect width="7" height="7" fill="var(--amber-soft)" /><line x1="0" y1="0" x2="0" y2="7" stroke="var(--amber)" strokeWidth="2" /></pattern><marker id={`${pattern}-arrow`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0 5 2.5 0 5" fill="var(--text-dim)" /></marker><clipPath id={`${pattern}-clip`}><rect x={gutter} y={0} width={chartWidth} height={height} /></clipPath><clipPath id={`${pattern}-labels`}><rect x="0" y="0" width={gutter - 12} height={height} /></clipPath></defs>
      <rect width={width} height={height} fill="var(--surface)" />
      <text x="20" y="26" className="svg-eyebrow">NODE / AGENT</text>
      <g clipPath={`url(#${pattern}-clip)`}>{niceTicks(view, chartWidth).map(tick => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1={HEADER} y2={height} stroke="var(--border)" strokeDasharray="3 5" /><text x={x(tick) + 4} y={26} className="svg-time">{clock(new Date(tick).toISOString())}</text></g>)}</g>
      {rows.map((node, row) => { const y = HEADER + row * ROW; const data = grouped.get(node.id) ?? { turns: [], tools: [], permissions: [] }; return <g key={node.id} className="timeline-row">
        <rect x="0" y={y} width={width} height={ROW} className="timeline-row-bg" />
        <line x1="0" x2={width} y1={y + ROW} y2={y + ROW} stroke="var(--border)" />
        <g clipPath={`url(#${pattern}-labels)`} onMouseMove={event => hover(event, `${node.title}\n${node.agentId} · ${duration(node.createdAt, node.endedAt ?? now)}`)} onMouseLeave={() => setTooltip(null)}><title>{node.title}</title><rect x="0" y={y} width={gutter} height={ROW} fill="transparent" />
          <circle cx={18 + node.depth * 14} cy={y + 16} r="3.5" fill={agentColors[node.agentId] ?? "#758799"} />
          <text x={29 + node.depth * 14} y={y + 19} className="svg-node-title">{node.title}</text>
          <text x={29 + node.depth * 14} y={y + 34} className="svg-node-subtitle">{node.agentId} · {duration(node.createdAt, node.endedAt ?? now)}</text>
        </g>
        <g clipPath={`url(#${pattern}-clip)`}>
          <rect {...band(node.createdAt, node.endedAt)} y={y + 5} height="33" rx="4" fill={agentColors[node.agentId] ?? "#758799"} opacity="0.09" onMouseMove={event => hover(event, `${node.title}\n${node.status} · ${duration(node.createdAt, node.endedAt ?? now)}`)} />
          {waitingIntervals(snapshot, node.id, now).map(([start, end], i) => <rect key={i} {...band(start, end)} y={y + 39} height="3" rx="1" fill="none" stroke="var(--text-dim)" strokeDasharray="2 4" onMouseMove={event => hover(event, `等待子节点 · ${duration(start, end)}`)} />)}
          {data.turns.map(turn => <rect key={turn.id} {...band(turn.startedAt, turn.endedAt ?? node.endedAt)} y={y + 8} height="11" rx="2" fill={triggerColors[turn.trigger]} opacity="0.85" onMouseMove={event => hover(event, `${turn.trigger} turn · ${turn.status}\n${clock(turn.startedAt)} · ${duration(turn.startedAt, turn.endedAt ?? now)}`)} />)}
          {data.permissions.map(permission => <rect key={permission.id} {...band(permission.requestedAt, permission.resolvedAt ?? node.endedAt)} y={y + 6} height="15" rx="2" fill={`url(#${pattern}-hatch)`} onMouseMove={event => hover(event, `${permission.request.title ?? "权限请求"}\n${permission.status} · ${duration(permission.requestedAt, permission.resolvedAt ?? now)}`)} />)}
          {data.tools.map((span, i) => <rect key={span.id} data-tool-kind={span.kind} {...band(span.startedAt, span.endedAt)} y={y + 24 + i % 2 * 7} height="5" rx="1" fill={toolColors[span.kind] ?? "#8794a4"} stroke={span.status === "failed" ? "var(--red)" : "none"} strokeWidth="1" onMouseMove={event => hover(event, `工具 · ${span.kind} / ${span.name}\n${span.summary ?? ""}\n${span.status} · ${clock(span.startedAt)} · ${duration(span.startedAt, span.endedAt ?? now)}`)}><title>{`${span.kind}: ${span.summary ?? span.name}`}</title></rect>)}
        </g>
      </g>; })}
      <g clipPath={`url(#${pattern}-clip)`} pointerEvents="none">{snapshot.delegations.map(edge => { const from = index.get(edge.fromNodeId); const to = index.get(edge.toNodeId); if (from === undefined || to === undefined) return null; const startX = x(edge.createdAt); const fromY = HEADER + from * ROW + 11; const toY = HEADER + to * ROW + 9; const deliveredX = edge.deliveredAt ? x(edge.deliveredAt) : 0; return <g key={edge.id} fill="none" stroke="var(--text-dim)" strokeWidth="1" opacity="0.7"><path d={`M${startX - 8} ${fromY} H${startX} V${toY - 4}`} markerEnd={`url(#${pattern}-arrow)`} />{edge.deliveredAt && <path d={`M${deliveredX - 7} ${toY + 10} H${deliveredX} V${fromY + 6}`} strokeDasharray="3 3" markerEnd={`url(#${pattern}-arrow)`} />}</g>; })}
        <line x1={x(snapshot.run.endedAt ?? now)} x2={x(snapshot.run.endedAt ?? now)} y1={HEADER - 7} y2={height} stroke="var(--accent)" strokeWidth="1.4" /><text x={x(snapshot.run.endedAt ?? now) - 4} y={HEADER - 13} textAnchor="end" fill="var(--accent)" fontSize="10">{snapshot.run.endedAt ? "结束" : "NOW"}</text>
      </g>
      <line x1={gutter} x2={gutter} y1="0" y2={height} stroke="var(--border-strong)" />
      <rect x={gutter - 5} y="0" width="10" height={height} fill="transparent" className="timeline-column-resizer" role="separator" aria-label="调整节点标题列宽" aria-orientation="vertical" aria-valuenow={gutter} tabIndex={0} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setGutter(current => Math.max(220, Math.min(420, width - 220, current + (event.key === "ArrowRight" ? 20 : -20)))); } }}><title>拖动调整列宽；方向键微调</title></rect>
    </svg></div>
    <div className="timeline-legend">{Object.entries(triggerColors).map(([trigger, color]) => <span key={trigger}><i style={{ background: color }} />{trigger}</span>)}<span><i className="hatched" />权限等待</span><span><i className="dotted" />等待子节点</span></div>
    <div className="timeline-tool-legend"><span>TOOLS</span>{Object.entries(toolColors).slice(0, 8).map(([kind, color]) => <span key={kind}><i style={{ background: color }} />{kind}</span>)}</div>
    {tooltip && <div className="timeline-tooltip" style={{ left: Math.min(tooltip.x + 14, window.innerWidth - 330), top: Math.min(tooltip.y + 14, window.innerHeight - 100) }}>{tooltip.text}</div>}
  </div>;
}
