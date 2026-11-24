import { useEffect, useRef, useState } from "react";
import type { PatchRunRequest, PullRequestRecord, ProjectSummary, RunSummary } from "@baton/protocol";
import { ProjectGroups } from "./Projects.js";
import { clampSidebarWidth, readSidebar, saveSidebar, sidebarDefaultWidth, sidebarKeyWidth } from "../lib/sidebar.js";
import { Icon } from "./common.js";
import batonIcon from "../assets/baton-icon.png";
export type Page = "inbox" | "runs" | "teams" | "settings";
export function Sidebar({ pullRequests, runs, runId, page, navigate, selectRun, newRun, canCreate, pendingCount, presetCount, theme, toggleTheme, loading, projects, currentProjectId, reveal, selectProject, addProject, mutateProject, mutateRun, draftProjectId }: {
  pullRequests?: PullRequestRecord[]; runs: RunSummary[]; runId: string | null; page: Page; navigate: (page: Page) => void; selectRun: (id: string) => void;
  newRun: (projectId?: string) => void; canCreate: boolean; pendingCount: number; presetCount: number;
  projects: ProjectSummary[]; currentProjectId: string | null; reveal: { id: string; serial: number } | null; selectProject: (id: string) => void; addProject: () => void; mutateProject: (id: string, request: { name?: string; archived?: boolean }) => Promise<void>;
  theme: string; toggleTheme: () => void; loading: boolean;
  mutateRun?: (id: string, request: PatchRunRequest) => Promise<void>; draftProjectId?: string | null;
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
    if (reveal && collapsed) setRunsOpen(true);
  }, [reveal]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && !event.altKey) { event.preventDefault(); setPreference(current => ({ ...current, collapsed: !current.collapsed })); setRunsOpen(false); }
      if (event.key === "Escape") { setRunsOpen(false); if (narrow) setPreference(current => ({ ...current, collapsed: true })); }
    };
    window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys);
  }, [narrow]);
  const dismissNavigation = () => { setRunsOpen(false); if (narrow) setPreference(current => ({ ...current, collapsed: true })); };
  const go = (target: Page) => { navigate(target); dismissNavigation(); };
  const choose = (id: string) => { selectRun(id); dismissNavigation(); };
  const startRun = (projectId?: string) => { newRun(projectId); dismissNavigation(); };
  const list = <ProjectGroups pullRequests={pullRequests} projects={projects} runs={runs} runId={runId} currentId={currentProjectId} page={page} reveal={reveal} choose={choose} selectProject={selectProject} newRun={startRun} add={addProject} canCreate={canCreate} mutate={mutateProject} loading={loading} mutateRun={mutateRun} draftProjectId={draftProjectId} />;
  return <>
    {narrow && !collapsed && <button className="sidebar-overlay-backdrop" aria-label="收起导航栏" onClick={toggle} />}
    <aside ref={aside} className={`sidebar navigation-sidebar${collapsed ? " is-collapsed" : ""}${narrow ? " is-narrow" : ""}`} style={{ width: collapsed ? 48 : preference.width, minWidth: collapsed || narrow ? 48 : preference.width }} aria-label="工作区导航">
      <div className="sidebar-top"><div className="brand"><img className="brand-symbol" src={batonIcon} alt="" width={34} height={34} /><div>baton <span className="version">0.1</span></div></div><button className="icon-button sidebar-toggle" title={`${collapsed ? "展开" : "收起"}侧栏 · ⌘/Ctrl+B`} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} aria-expanded={!collapsed} onClick={toggle}><Icon name="panel" size={17} /></button></div>
      <button className="button primary new-run-button" title="新建 Run" aria-label="新建 Run" onClick={() => startRun()} disabled={!canCreate && projects.some(project => !project.archived)}><Icon name="plus" /><span className="sidebar-label">新建 Run</span></button>
      {collapsed ? <div className="rail-runs"><button className={`sidebar-nav ${page === "runs" ? "selected" : ""}`} title="Runs" aria-label="打开 Run 列表" aria-expanded={runsOpen} onClick={() => setRunsOpen(value => !value)}><Icon name="chat" /></button>{runsOpen && <><button className="rail-popover-dismiss" aria-label="关闭 Run 列表" onClick={() => setRunsOpen(false)} /><div className="rail-run-popover"><div className="sidebar-section-heading"><span>PROJECTS</span><button className="icon-button" aria-label="关闭 Run 列表" onClick={() => setRunsOpen(false)}><Icon name="close" size={14} /></button></div>{list}</div></>}</div> : <><div className="sidebar-section-heading"><span>PROJECTS</span><span>{projects.filter(project => !project.archived).length.toString().padStart(2, "0")}</span></div>{list}</>}
      {/* Settings, teams and the inbox live bottom-left as icons (the inbox carries its count as a badge). */}
      <div className="sidebar-footer"><div className="sidebar-actions">{([{ id: "settings", icon: "settings", label: "设置", title: "设置" }, { id: "teams", icon: "graph", label: "团队", title: `团队 · ${presetCount} 个预设` }, { id: "inbox", icon: "inbox", label: `待处理 ${pendingCount}`, title: `待处理 · ${pendingCount} 项`, count: pendingCount }] as const).map(entry => <button key={entry.id} type="button" className={`icon-button sidebar-action${page === entry.id ? " selected" : ""}`} title={entry.title} aria-label={entry.label} aria-current={page === entry.id ? "page" : undefined} onClick={() => go(entry.id)}><Icon name={entry.icon} size={17} />{"count" in entry && entry.count > 0 && <span className="nav-badge">{entry.count > 99 ? "99+" : entry.count}</span>}</button>)}<button type="button" className="icon-button sidebar-action theme-toggle" title={theme === "dark" ? "切换为浅色" : "切换为深色"} aria-label={theme === "dark" ? "切换为浅色" : "切换为深色"} onClick={toggleTheme}><Icon name={theme === "dark" ? "sun" : "moon"} size={16} /></button></div></div>
      {!collapsed && <div className="sidebar-resizer" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={440} aria-valuenow={preference.width} tabIndex={0} title="拖动调整宽度；双击恢复 260px；方向键微调" onDoubleClick={() => setPreference(current => ({ ...current, width: sidebarDefaultWidth }))} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); setPreference(current => ({ ...current, width: sidebarKeyWidth(current.width, event.key, event.shiftKey) })); } }} onPointerDown={event => { if (event.button !== 0) return; dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }} onPointerMove={event => { if (dragging.current) { const left = aside.current?.getBoundingClientRect().left ?? 0; setPreference(current => ({ ...current, width: clampSidebarWidth(event.clientX - left) })); } }} onPointerUp={event => { dragging.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragging.current = false; }} />}
    </aside>{narrow && !collapsed && <div className="sidebar-rail-spacer" />}
  </>;
}
