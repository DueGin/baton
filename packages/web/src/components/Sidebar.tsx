import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PatchRunRequest, PullRequestRecord, ProjectSummary, RunSummary } from "@baton/protocol";
import { expandProjectGroup, ProjectGroups, ProjectListTools } from "./Projects.js";
import { clampSidebarWidth, readSidebar, readSidebarUnreadOnly, saveSidebar, saveSidebarUnreadOnly, sidebarDefaultWidth, sidebarKeyWidth } from "../lib/sidebar.js";
import { markRunSeen, mergeRunSeenStorage, readRunSeen, reconcileRunSeen, runActivityAt, runSeenKey, saveRunSeen, setRunRead, summarizeUnread, type RunSeen } from "../lib/unread.js";
import { Icon } from "./common.js";
import batonIcon from "../assets/baton-icon.png";
export type Page = "inbox" | "runs" | "tasks" | "teams" | "settings";
export function Sidebar({ pullRequests, runs, runId, page, navigate, selectRun, newRun, canCreate, pendingCount, presetCount, taskCount = 0, theme, toggleTheme, loading, projects, currentProjectId, reveal, selectProject, addProject, mutateProject, mutateRun, draftProjectId }: {
  pullRequests?: PullRequestRecord[]; runs: RunSummary[]; runId: string | null; page: Page; navigate: (page: Page) => void; selectRun: (id: string) => void;
  newRun: (projectId?: string) => void; canCreate: boolean; pendingCount: number; presetCount: number; taskCount?: number;
  projects: ProjectSummary[]; currentProjectId: string | null; reveal: { id: string; serial: number } | null; selectProject: (id: string) => void; addProject: () => void; mutateProject: (id: string, request: { name?: string; archived?: boolean }) => Promise<void>;
  theme: string; toggleTheme: () => void; loading: boolean;
  mutateRun?: (id: string, request: PatchRunRequest) => Promise<void>; draftProjectId?: string | null;
}) {
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 900px)").matches);
  const [preference, setPreference] = useState(() => readSidebar(localStorage, narrow));
  const [unreadOnly, setUnreadOnly] = useState(() => readSidebarUnreadOnly(localStorage));
  const [seen, setSeen] = useState(() => readRunSeen(localStorage));
  const seenRef = useRef(seen);
  const updateSeen = useCallback((next: RunSeen | null) => {
    if (next === seenRef.current) return;
    seenRef.current = next;
    setSeen(next);
  }, []);
  const [runsOpen, setRunsOpen] = useState(false); const dragging = useRef(false); const aside = useRef<HTMLElement>(null);
  const collapsed = preference.collapsed;
  const toggle = () => { setPreference(current => ({ ...current, collapsed: !current.collapsed })); setRunsOpen(false); };
  const viewedRun = page === "runs" && !draftProjectId ? runs.find(run => run.id === runId) : undefined;
  const viewedId = viewedRun?.id;
  const viewedAt = viewedRun && runActivityAt(viewedRun);
  const unread = useMemo(() => summarizeUnread(runs, seen), [runs, seen]);
  useEffect(() => { saveSidebar(localStorage, preference); }, [preference]);
  useEffect(() => { saveSidebarUnreadOnly(localStorage, unreadOnly); }, [unreadOnly]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === runSeenKey && event.storageArea === localStorage) updateSeen(mergeRunSeenStorage(seenRef.current, event));
    };
    window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, [updateSeen]);
  useEffect(() => {
    if (!loading) {
      const current = seenRef.current ?? readRunSeen(localStorage);
      updateSeen(saveRunSeen(localStorage, reconcileRunSeen(current, runs, false), { runs }));
    }
  }, [runs, loading, updateSeen]);
  useEffect(() => {
    const current = seenRef.current;
    if (!current || !viewedId || !viewedAt) return;
    const next = markRunSeen(current, viewedId, viewedAt);
    if (next !== current) updateSeen(saveRunSeen(localStorage, next));
  }, [viewedId, viewedAt, loading, updateSeen]);
  useEffect(() => {
    const media = matchMedia("(max-width: 900px)"); const change = () => { setNarrow(media.matches); if (media.matches) setPreference(current => ({ ...current, collapsed: true })); };
    media.addEventListener("change", change); return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!reveal) return;
    expandProjectGroup(reveal.id);
    if (collapsed) setRunsOpen(true);
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
  const changeRunRead = (run: RunSummary, read: boolean) => {
    const current = seenRef.current ?? readRunSeen(localStorage) ?? reconcileRunSeen(null, runs, false);
    const next = read ? setRunRead(current, run, true) : current;
    updateSeen(saveRunSeen(localStorage, next, read ? undefined : { markUnread: run }));
  };
  const choose = (id: string) => {
    const run = runs.find(entry => entry.id === id);
    if (run) changeRunRead(run, true);
    selectRun(id); dismissNavigation();
  };
  const startRun = (projectId?: string) => { newRun(projectId); dismissNavigation(); };
  const list = <ProjectGroups pullRequests={pullRequests} projects={projects} runs={runs} runId={runId} currentId={currentProjectId} page={page} reveal={reveal} choose={choose} selectProject={selectProject} newRun={startRun} add={addProject} canCreate={canCreate} mutate={mutateProject} loading={loading} mutateRun={mutateRun} draftProjectId={draftProjectId} unread={unread} unreadOnly={unreadOnly} setRunRead={changeRunRead} />;
  const projectHeading = <div className="sidebar-section-heading">
    <span>PROJECTS</span>
    <div className="sidebar-project-tools">
      <span className="sidebar-project-count">{projects.filter(project => !project.archived).length.toString().padStart(2, "0")}</span>
      <ProjectListTools projects={projects} unreadOnly={unreadOnly} toggleUnreadOnly={() => setUnreadOnly(value => !value)} />
      {collapsed && <button type="button" className="icon-button" title="关闭 Run 列表" aria-label="关闭 Run 列表" onClick={() => setRunsOpen(false)}><Icon name="close" size={14} /></button>}
    </div>
  </div>;
  const taskLabel = taskCount > 0 ? `任务 · ${taskCount} 项进行中` : "任务";
  const runListLabel = unread.ids.size ? `打开 Run 列表 · ${unread.ids.size} 个未读会话` : "打开 Run 列表";
  return <>
    {narrow && !collapsed && <button className="sidebar-overlay-backdrop" aria-label="收起导航栏" onClick={toggle} />}
    <aside ref={aside} className={`sidebar navigation-sidebar${collapsed ? " is-collapsed" : ""}${narrow ? " is-narrow" : ""}`} style={{ width: collapsed ? 48 : preference.width, minWidth: collapsed || narrow ? 48 : preference.width }} aria-label="工作区导航">
      <div className="sidebar-top"><div className="brand"><img className="brand-symbol" src={batonIcon} alt="" width={34} height={34} /><div>baton <span className="version">0.1</span></div></div><button className="icon-button sidebar-toggle" title={`${collapsed ? "展开" : "收起"}侧栏 · ⌘/Ctrl+B`} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} aria-expanded={!collapsed} onClick={toggle}><Icon name="panel" size={17} /></button></div>
      <button className="button primary new-run-button" title="新建 Run" aria-label="新建 Run" onClick={() => startRun()} disabled={!canCreate && projects.some(project => !project.archived)}><Icon name="plus" /><span className="sidebar-label">新建 Run</span></button>
      <button type="button" className={`sidebar-nav sidebar-tasks${page === "tasks" ? " selected" : ""}`} title={taskLabel} aria-label={taskLabel} aria-current={page === "tasks" ? "page" : undefined} onClick={() => go("tasks")}>
        <Icon name="checklist" size={17} /><span className="sidebar-label">任务</span>{taskCount > 0 && <span className="nav-badge" aria-hidden="true">{taskCount > 99 ? "99+" : taskCount}</span>}
      </button>
      {collapsed ? <div className="rail-runs">
        <button type="button" className={`sidebar-nav${page === "runs" ? " selected" : ""}`} title={runListLabel} aria-label={runListLabel} aria-expanded={runsOpen} onClick={() => setRunsOpen(value => !value)}>
          <Icon name="chat" />{unread.ids.size > 0 && <span className="nav-badge unread-badge" aria-hidden="true">{unread.ids.size > 99 ? "99+" : unread.ids.size}</span>}
        </button>
        {runsOpen && <><button className="rail-popover-dismiss" aria-label="关闭 Run 列表" onClick={() => setRunsOpen(false)} /><div className="rail-run-popover">{projectHeading}{list}</div></>}
      </div> : <>{projectHeading}{list}</>}
      {/* Settings, teams and the inbox live bottom-left as icons (the inbox carries its count as a badge). */}
      <div className="sidebar-footer"><div className="sidebar-actions">{([{ id: "settings", icon: "settings", label: "设置", title: "设置" }, { id: "teams", icon: "graph", label: "团队", title: `团队 · ${presetCount} 个预设` }, { id: "inbox", icon: "inbox", label: `待处理 ${pendingCount}`, title: `待处理 · ${pendingCount} 项`, count: pendingCount }] as const).map(entry => <button key={entry.id} type="button" className={`icon-button sidebar-action${page === entry.id ? " selected" : ""}`} title={entry.title} aria-label={entry.label} aria-current={page === entry.id ? "page" : undefined} onClick={() => go(entry.id)}><Icon name={entry.icon} size={17} />{"count" in entry && entry.count > 0 && <span className="nav-badge">{entry.count > 99 ? "99+" : entry.count}</span>}</button>)}<button type="button" className="icon-button sidebar-action theme-toggle" title={theme === "dark" ? "切换为浅色" : "切换为深色"} aria-label={theme === "dark" ? "切换为浅色" : "切换为深色"} onClick={toggleTheme}><Icon name={theme === "dark" ? "sun" : "moon"} size={16} /></button></div></div>
      {!collapsed && <div className="sidebar-resizer" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={440} aria-valuenow={preference.width} tabIndex={0} title="拖动调整宽度；双击恢复 260px；方向键微调" onDoubleClick={() => setPreference(current => ({ ...current, width: sidebarDefaultWidth }))} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); setPreference(current => ({ ...current, width: sidebarKeyWidth(current.width, event.key, event.shiftKey) })); } }} onPointerDown={event => { if (event.button !== 0) return; dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }} onPointerMove={event => { if (dragging.current) { const left = aside.current?.getBoundingClientRect().left ?? 0; setPreference(current => ({ ...current, width: clampSidebarWidth(event.clientX - left) })); } }} onPointerUp={event => { dragging.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragging.current = false; }} />}
    </aside>{narrow && !collapsed && <div className="sidebar-rail-spacer" />}
  </>;
}
