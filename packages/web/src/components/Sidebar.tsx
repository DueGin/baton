import { useEffect, useRef, useState } from "react";
import type { RunSummary } from "@baton/protocol";
import { agentColors, cost, statusLabels } from "../lib/derive.js";
import { clampSidebarWidth, readSidebar, saveSidebar, sidebarDefaultWidth, sidebarKeyWidth } from "../lib/sidebar.js";
import { Icon } from "./common.js";
export type Page = "inbox" | "runs" | "agents" | "teams" | "settings";
export function Sidebar({ runs, runId, page, navigate, selectRun, newRun, canCreate, pendingCount, agentCount, presetCount, theme, toggleTheme, demo, loading }: {
  runs: RunSummary[]; runId: string | null; page: Page; navigate: (page: Page) => void; selectRun: (id: string) => void;
  newRun: () => void; canCreate: boolean; pendingCount: number; agentCount: number; presetCount: number;
  theme: string; toggleTheme: () => void; demo: boolean; loading: boolean;
}) {
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 900px)").matches);
  const [preference, setPreference] = useState(() => readSidebar(localStorage, narrow));
  const [runsOpen, setRunsOpen] = useState(false); const dragging = useRef(false); const aside = useRef<HTMLElement>(null);
  const collapsed = preference.collapsed;
  const toggle = () => { setPreference(current => ({ ...current, collapsed: !current.collapsed })); setRunsOpen(false); };
  useEffect(() => { saveSidebar(localStorage, preference); }, [preference]);
  useEffect(() => {
    const media = matchMedia("(max-width: 900px)"); const change = () => { setNarrow(media.matches); if (media.matches) setPreference(current => ({ ...current, collapsed: true })); };
    media.addEventListener("change", change); return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && !event.altKey) { event.preventDefault(); setPreference(current => ({ ...current, collapsed: !current.collapsed })); setRunsOpen(false); }
      if (event.key === "Escape") { setRunsOpen(false); if (narrow) setPreference(current => ({ ...current, collapsed: true })); }
    };
    window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys);
  }, [narrow]);
  const go = (target: Page) => { navigate(target); setRunsOpen(false); if (narrow) setPreference(current => ({ ...current, collapsed: true })); };
  const choose = (id: string) => { selectRun(id); setRunsOpen(false); if (narrow) setPreference(current => ({ ...current, collapsed: true })); };
  const list = <nav className="runs-list" aria-label="Runs">{runs.map(run => <button key={run.id} title={run.title} className={`run-list-item ${runId === run.id && page === "runs" ? "selected" : ""}`} onClick={() => choose(run.id)}><div className="run-list-heading"><i className={`run-dot status-${run.status}`} /><span>{run.title}</span>{run.titleSource === "generated" && <span className="generated-title-mark" title="由标题模型命名">✦</span>}{run.pendingTotal > 0 && <span className="permission-count">{run.pendingTotal}</span>}</div><div className="run-list-meta"><span className="run-agent-dots">{run.agents.map(agent => <i key={agent} style={{ background: agentColors[agent] ?? "#758799" }} title={agent} />)}{run.nodeCount} agents</span><span>{cost(run.usage.costUsd)}</span></div><div className="run-list-bottom"><span>{statusLabels[run.status]}</span><span>{new Date(run.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span></div></button>)}{loading && <div className="sidebar-loading">正在连接…</div>}{!loading && !runs.length && <div className="sidebar-loading">创建第一个 Run 开始协作</div>}</nav>;
  return <>
    {narrow && !collapsed && <button className="sidebar-overlay-backdrop" aria-label="收起导航栏" onClick={toggle} />}
    <aside ref={aside} className={`sidebar navigation-sidebar${collapsed ? " is-collapsed" : ""}${narrow ? " is-narrow" : ""}`} style={{ width: collapsed ? 48 : preference.width, minWidth: collapsed || narrow ? 48 : preference.width }} aria-label="工作区导航">
      <div className="sidebar-top"><div className="brand"><span className="brand-symbol">b<span>↗</span></span><div>baton <span className="version">0.1</span><small>LOCAL AGENT WORKSPACE</small></div></div><button className="icon-button sidebar-toggle" title={`${collapsed ? "展开" : "收起"}侧栏 · ⌘/Ctrl+B`} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} aria-expanded={!collapsed} onClick={toggle}><Icon name="panel" size={17} /></button></div>
      <button className="button primary new-run-button" title="新建 Run" aria-label="新建 Run" onClick={newRun} disabled={!canCreate}><Icon name="plus" /><span className="sidebar-label">新建 Run</span></button>
      <button className={`sidebar-nav inbox-nav ${page === "inbox" ? "selected" : ""}`} title={`待处理 ${pendingCount}`} aria-label={`待处理 ${pendingCount}`} onClick={() => go("inbox")}><Icon name="inbox" /><span className="sidebar-label">待处理</span><span className="nav-count">{pendingCount}</span></button>
      {collapsed ? <div className="rail-runs"><button className={`sidebar-nav ${page === "runs" ? "selected" : ""}`} title="Runs" aria-label="打开 Run 列表" aria-expanded={runsOpen} onClick={() => setRunsOpen(value => !value)}><Icon name="chat" /></button>{runsOpen && <><button className="rail-popover-dismiss" aria-label="关闭 Run 列表" onClick={() => setRunsOpen(false)} /><div className="rail-run-popover"><div className="sidebar-section-heading"><span>RUNS</span><button className="icon-button" aria-label="关闭 Run 列表" onClick={() => setRunsOpen(false)}><Icon name="close" size={14} /></button></div>{list}</div></>}</div> : <><div className="sidebar-section-heading"><span>RUNS</span><span>{runs.length.toString().padStart(2, "0")}</span></div>{list}</>}
      <div className="sidebar-footer">{([{ id: "agents", icon: "agents", label: "Agents", count: agentCount }, { id: "teams", icon: "graph", label: "团队", count: presetCount }, { id: "settings", icon: "settings", label: "设置" }] as const).map(entry => <button key={entry.id} className={`sidebar-nav ${page === entry.id ? "selected" : ""}`} title={entry.label} aria-label={entry.label} onClick={() => go(entry.id)}><Icon name={entry.icon} /><span className="sidebar-label">{entry.label}</span>{"count" in entry && entry.count !== undefined && <span className="nav-count">{entry.count}</span>}</button>)}<div className="sidebar-bottom"><span className="local-indicator"><i />{demo ? "Demo workspace" : "Local daemon"}</span><button className="icon-button" title={theme === "dark" ? "切换为浅色" : "切换为深色"} onClick={toggleTheme}><Icon name={theme === "dark" ? "sun" : "moon"} size={16} /></button></div></div>
      {!collapsed && <div className="sidebar-resizer" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={440} aria-valuenow={preference.width} tabIndex={0} title="拖动调整宽度；双击恢复 260px；方向键微调" onDoubleClick={() => setPreference(current => ({ ...current, width: sidebarDefaultWidth }))} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); setPreference(current => ({ ...current, width: sidebarKeyWidth(current.width, event.key, event.shiftKey) })); } }} onPointerDown={event => { if (event.button !== 0) return; dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }} onPointerMove={event => { if (dragging.current) { const left = aside.current?.getBoundingClientRect().left ?? 0; setPreference(current => ({ ...current, width: clampSidebarWidth(event.clientX - left) })); } }} onPointerUp={event => { dragging.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragging.current = false; }} />}
    </aside>{narrow && !collapsed && <div className="sidebar-rail-spacer" />}
  </>;
}
