import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { prTone } from "../lib/pull-requests.js";
import type { PatchRunRequest, PullRequestRecord, ListDirsResponse, ProjectRecord, ProjectSummary, RunSummary } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { compareRunActivity, groupProjects, pathBasename, readCollapsedProjects, saveCollapsedProjects } from "../lib/projects.js";
import { filterUnreadRuns, runActivityAt, type UnreadSummary } from "../lib/unread.js";
import { errorText } from "../store.js";
import { cost, statusLabels } from "../lib/derive.js";
import { ModelIcon } from "./AgentIcon.js";
import { CopyButton } from "./CopyButton.js";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu.js";
import { Empty, Icon } from "./common.js";
import { Modal } from "./TeamForms.js";
import { desktopBridge } from "../desktop.js";
import { DesktopAddProject } from "./DesktopAddProject.js";

export function ProjectLink({ project, open, details = false }: { project: ProjectSummary; open: () => void; details?: boolean }) {
  return <button type="button" className={`project-link${details ? " project-link-detail" : ""}`} onClick={open} title={`${project.name}\n${project.path}${project.gitBranch ? `\n${project.gitBranch}` : ""}`}>
    <Icon name="folder" size={13} /><span className="project-link-name">{project.name}</span>{project.gitBranch && <code className="project-link-branch">{project.gitBranch}</code>}{details && <small>{project.path}</small>}
  </button>;
}
export function ProjectsEmpty({ add }: { add: () => void }) { return <Empty><Icon name="folder" size={42} /><h1>添加项目（工作目录）后才能开始会话</h1><p>将工作目录登记为项目，在项目中创建和管理会话。</p><button type="button" className="button primary" onClick={add}><Icon name="plus" size={15} />添加项目</button></Empty>; }
export function DirectoryBrowser({ value, loading, browse, select }: { value?: ListDirsResponse; loading: boolean; browse: (path: string) => void; select: (path: string) => void }) {
  const crumbs = value?.path.split("/").filter(Boolean) ?? [];
  return <div className="directory-browser"><div className="directory-browser-toolbar"><button type="button" className="button small" disabled={loading || !value?.parent} onClick={() => { if (value?.parent) browse(value.parent); }}>↑ 上级</button><button type="button" className="button small" disabled={loading} onClick={() => browse(value?.home ?? "~")}>⌂ Home</button><nav aria-label="目录路径"><button type="button" disabled={loading} onClick={() => browse("/")}>/</button>{crumbs.map((part, i) => <button type="button" key={i} disabled={loading} onClick={() => browse(`/${crumbs.slice(0, i + 1).join("/")}`)}>{part} /</button>)}</nav></div>
    <div className="directory-list" aria-busy={loading}>{loading ? <p className="muted">正在读取目录…</p> : value?.dirs.length ? value.dirs.map(dir => <div key={dir.path} className="directory-row"><button type="button" className="directory-name" title={`${dir.path} · 双击进入；Enter 进入`} onClick={() => select(dir.path)} onDoubleClick={() => browse(dir.path)} onKeyDown={event => { if (event.key === "Enter" || event.key === "ArrowRight") { event.preventDefault(); browse(dir.path); } }}><Icon name="folder" size={15} /><span>{dir.name}</span>{dir.isGitRepo && <span className="git-badge">git</span>}{dir.isProject && <span className="tag">已是项目</span>}</button><button type="button" className="text-button" aria-label={`进入 ${dir.name}`} onClick={() => browse(dir.path)}>进入 ›</button></div>) : <p className="muted">此目录没有子目录</p>}</div><div className="directory-selection"><code>{value?.path ?? "~"}</code><button type="button" className="button small" disabled={!value || loading} onClick={() => { if (value) select(value.path); }}>选择当前文件夹</button></div></div>;
}
export function AddProject({ client, close, added }: { client: BatonClient; close: () => void; added: (project: ProjectRecord) => Promise<void> }) {
  if (desktopBridge()) return <DesktopAddProject client={client} close={close} added={added} manual={<ManualAddProject client={client} close={close} added={added} embedded />} />;
  return <ManualAddProject client={client} close={close} added={added} />;
}
function ManualAddProject({ client, close, added, embedded = false }: { client: BatonClient; close: () => void; added: (project: ProjectRecord) => Promise<void>; embedded?: boolean }) {
  const [path, setPath] = useState(""); const [name, setName] = useState(""); const [nameEdited, setNameEdited] = useState(false); const [directory, setDirectory] = useState<ListDirsResponse>();
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState<string>(); const generation = useRef(0);
  const select = (value: string) => { setPath(value); if (!nameEdited) setName(pathBasename(value)); };
  const browse = async (value: string, choose = false) => { const current = ++generation.current; setLoading(true); setError(undefined); try { const dirs = await client.dirs(value); if (current !== generation.current) return; setDirectory(dirs); if (choose) select(dirs.path); } catch (cause) { if (current === generation.current) setError(errorText(cause)); } finally { if (current === generation.current) setLoading(false); } };
  useEffect(() => { void browse("~", true); return () => { generation.current++; }; }, [client]);
  const submit = async () => { setSaving(true); setError(undefined); try { const project = await client.createProject({ path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) }); await added(project); } catch (cause) { setError(errorText(cause)); } finally { setSaving(false); } };
  const form = <form onSubmit={event => { event.preventDefault(); void submit(); }}><p className="muted">选择一个工作目录。路径支持 ~，已登记的项目会直接打开，已归档的会恢复。</p><label className="form-field">工作目录<div className="project-path-input"><input autoFocus required value={path} aria-label="项目路径" onChange={event => select(event.target.value)} placeholder="~/projects/my-app" /><button className="button" type="button" disabled={loading || !path.trim()} onClick={() => { void browse(path, true); }}>浏览</button></div></label><DirectoryBrowser value={directory} loading={loading} browse={value => { void browse(value); }} select={select} /><label className="form-field">项目名称<input aria-label="项目名称" value={name} placeholder={pathBasename(path)} onChange={event => { setName(event.target.value); setNameEdited(true); }} /></label>{error && <div className="error-panel" role="alert">{error}</div>}<div className="dialog-footer"><button type="button" className="button" disabled={saving} onClick={close}>取消</button><button className="button primary" disabled={saving || !path.trim()}>{saving ? "添加中…" : "添加项目"}</button></div></form>;
  return embedded ? form : <Modal title="添加项目" close={() => { if (!saving) close(); }}>{form}</Modal>;
}
let collapsedState: Set<string> | undefined;
const collapsedListeners = new Set<() => void>();
function collapsedSnapshot(): Set<string> { if (!collapsedState) { try { collapsedState = readCollapsedProjects(localStorage); } catch { collapsedState = new Set(); } } return collapsedState; }
function setCollapsedState(update: (current: Set<string>) => Set<string>): void { collapsedState = update(collapsedSnapshot()); try { saveCollapsedProjects(localStorage, collapsedState); } catch { /* Storage may be unavailable. */ } collapsedListeners.forEach(listener => listener()); }
function subscribeCollapsed(listener: () => void): () => void { collapsedListeners.add(listener); return () => { collapsedListeners.delete(listener); }; }
export function expandProjectGroup(id: string): void {
  if (!collapsedSnapshot().has(id)) return;
  setCollapsedState(current => { const next = new Set(current); next.delete(id); return next; });
}

export function ProjectListTools({ projects, unreadOnly, toggleUnreadOnly }: { projects: ProjectSummary[]; unreadOnly: boolean; toggleUnreadOnly: () => void }) {
  const collapsed = useSyncExternalStore(subscribeCollapsed, collapsedSnapshot, collapsedSnapshot);
  const activeIds = projects.filter(project => !project.archived).map(project => project.id);
  const allCollapsed = activeIds.length > 0 && activeIds.every(id => collapsed.has(id));
  const toggleLabel = allCollapsed ? "全部展开" : "全部折叠";
  return <>
    <button type="button" className="icon-button" title="只看未读" aria-label="只看未读" aria-pressed={unreadOnly} onClick={toggleUnreadOnly}><Icon name={unreadOnly ? "bell-filled" : "bell"} size={14} /></button>
    <button type="button" className="icon-button" title={toggleLabel} aria-label={toggleLabel} disabled={!activeIds.length} onClick={() => setCollapsedState(() => new Set(allCollapsed ? [] : activeIds))}><Icon name={allCollapsed ? "expand-all" : "collapse-all"} size={15} /></button>
  </>;
}

export interface ProjectGroupsProps {
  pullRequests?: PullRequestRecord[];
  projects: ProjectSummary[]; runs: RunSummary[]; runId: string | null; currentId: string | null; page: string; reveal: { id: string; serial: number } | null;
  choose: (id: string) => void; selectProject: (id: string) => void; newRun: (projectId?: string) => void; add: () => void; canCreate: boolean;
  mutate: (id: string, request: { name?: string; archived?: boolean }) => Promise<void>; loading: boolean;
  mutateRun?: (id: string, request: PatchRunRequest) => Promise<void>;
  draftProjectId?: string | null;
  unread?: UnreadSummary;
  unreadOnly?: boolean;
  setRunRead?: (run: RunSummary, read: boolean) => void;
}
const noUnread: UnreadSummary = { ids: new Set(), byProject: new Map() };
function ArchivedRuns({ runs, renderRun, pinnedId }: { runs: RunSummary[]; renderRun: (run: RunSummary) => React.ReactNode; pinnedId?: string | null }) {
  const [open, setOpen] = useState(false);
  if (!runs.length) return null;
  return <div className="project-archived-runs">
    <button type="button" className="project-archived-runs-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><span aria-hidden="true">{open ? "▾" : "▸"}</span>已归档会话 {runs.length}</button>
    {(open ? runs : runs.filter(run => run.id === pinnedId)).map(renderRun)}
  </div>;
}
function RunModelStack({ run }: { run: RunSummary }) {
  const models: NonNullable<RunSummary["models"]> = run.models ?? [
    ...run.agents.filter(agentId => agentId === run.rootAgentId),
    ...run.agents.filter(agentId => agentId !== run.rootAgentId),
  ].map(agentId => ({ agentId }));
  if (!models.length) return null;
  const label = models.map(({ agentId, model }) => `${agentId} · ${model ?? "未知模型"}`).join("\n");
  const overflow = models.length - 4;
  return <span className="run-model-stack" title={label} aria-label={label} role="img">
    {models.slice(0, 4).map(({ agentId, model }) => <span className="run-model-chip" key={JSON.stringify([agentId, model])}><ModelIcon model={model} fallbackAgent={agentId} size={11} /></span>)}
    {overflow > 0 && <span className="run-model-chip run-model-overflow">+{overflow}</span>}
  </span>;
}
export function ProjectGroups({ pullRequests = [], projects, runs, runId, currentId, page, reveal, choose, selectProject, newRun, add, canCreate, mutate, loading, mutateRun, draftProjectId, unread = noUnread, unreadOnly = false, setRunRead }: ProjectGroupsProps) {
  const collapsed = useSyncExternalStore(subscribeCollapsed, collapsedSnapshot, collapsedSnapshot); const [archivedOpen, setArchivedOpen] = useState(false);
  const [editing, setEditing] = useState<string>(); const [name, setName] = useState(""); const [archiving, setArchiving] = useState<ProjectSummary>(); const [working, setWorking] = useState(false); const [error, setError] = useState<string>();
  const [runMenu, setRunMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLButtonElement }>();
  const [runEdit, setRunEdit] = useState<{ id: string; title: string }>();
  const [runSaving, setRunSaving] = useState(false);
  const restoreRunFocus = useRef<string>(undefined);
  const selectedId = !draftProjectId && page === "runs" ? runId : null;
  const filterRuns = (entries: RunSummary[]) => unreadOnly ? filterUnreadRuns(entries, unread.ids, selectedId) : entries;
  const groups = groupProjects(projects, runs).map(entry => ({ ...entry, runs: filterRuns(entry.runs) }))
    .filter(({ project, runs: children }) => !unreadOnly || children.length > 0 || project.id === draftProjectId);
  useEffect(() => { if (reveal && projects.some(project => project.id === reveal.id && project.archived)) setArchivedOpen(true); }, [reveal]);
  const toggle = (id: string) => { selectProject(id); setCollapsedState(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); };
  const update = async (id: string, request: { name?: string; archived?: boolean }): Promise<boolean> => { setWorking(true); setError(undefined); try { await mutate(id, request); return true; } catch (cause) { setError(errorText(cause)); return false; } finally { setWorking(false); } };
  const updateRun = async (id: string, request: PatchRunRequest): Promise<boolean> => {
    if (!mutateRun) return false;
    setError(undefined);
    try { await mutateRun(id, request); return true; }
    catch (cause) { setError(errorText(cause)); return false; }
  };
  const endRename = (id: string) => { restoreRunFocus.current = id; setRunEdit(undefined); };
  const renameRun = async (id: string, title: string) => {
    setRunSaving(true);
    try { if (await updateRun(id, { title })) endRename(id); }
    finally { setRunSaving(false); }
  };
  const copyRun = async (id: string) => {
    setError(undefined);
    try { await navigator.clipboard.writeText(id); }
    catch (cause) { setError(`复制会话 ID 失败：${errorText(cause)}`); }
  };
  const runRow = (run: RunSummary) => {
    const selected = selectedId === run.id;
    const isUnread = unread.ids.has(run.id);
    const activityAt = runActivityAt(run);
    const activityDate = new Date(activityAt);
    const activityLabel = activityDate.toDateString() === new Date().toDateString()
      ? activityDate.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      : activityDate.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
    const className = `run-list-item${selected ? " selected" : ""}${run.archived ? " is-archived" : ""}${isUnread ? " is-unread" : ""}`;
    if (mutateRun && runEdit?.id === run.id) return <form key={run.id} className={`${className} run-rename-form`} onSubmit={event => {
      event.preventDefault();
      if (!runSaving && runEdit.title.trim()) void renameRun(run.id, runEdit.title.trim());
    }}><div className="run-list-heading"><input autoFocus aria-label="重命名会话" value={runEdit.title} readOnly={runSaving} onFocus={event => event.currentTarget.select()}
      onChange={event => setRunEdit({ id: run.id, title: event.target.value })}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!runSaving) endRename(run.id); } }} /></div></form>;
    return <button key={run.id} type="button" title={run.title} className={className} aria-current={selected ? true : undefined} aria-haspopup="menu" aria-expanded={runMenu?.id === run.id} onClick={() => choose(run.id)}
      ref={element => { if (element && restoreRunFocus.current === run.id) { restoreRunFocus.current = undefined; element.focus({ preventScroll: true }); } }}
      onContextMenu={event => { event.preventDefault(); setRunMenu({ id: run.id, x: event.clientX, y: event.clientY, trigger: event.currentTarget }); }}
      onKeyDown={event => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const { left, bottom } = event.currentTarget.getBoundingClientRect();
        setRunMenu({ id: run.id, x: left, y: bottom, trigger: event.currentTarget });
      }}>
      <div className="run-list-heading">{run.status === "paused" ? <span className="run-paused-icon" title="已暂停"><Icon name="pause" size={11} /></span> : <i className={`run-dot status-${run.status}`} />}<span className="run-list-title">{run.title}</span>{run.titleSource === "generated" && <span className="generated-title-mark" title="由标题模型命名">✦</span>}{isUnread && <i className="run-unread-dot" role="img" aria-label="未读" title="未读" />}{run.pendingTotal > 0 && <span className="permission-count">{run.pendingTotal}</span>}</div>
      <div className="run-list-meta"><span className="run-agents"><RunModelStack run={run} /><span>{run.nodeCount} agents</span></span><span>{cost(run.usage.costUsd)}</span></div>
      <div className="run-list-bottom">{(run.backgroundCount ?? 0) > 0 && <span className="run-background-count" title={`${run.backgroundCount} 个后台进程`}><Icon name="server" size={11} />{run.backgroundCount}</span>}{(run.openPrCount ?? 0) > 0 && <span className={`run-pr-count pr-tone-${prTone(pullRequests.filter(pr => pr.runId === run.id))}`} title="Open / Draft PR">⑂ {run.openPrCount} PR</span>}<span>{statusLabels[run.status]}</span><time dateTime={activityAt} title={activityDate.toLocaleString("zh-CN", { hourCycle: "h23" })}>{activityLabel}</time></div>
    </button>;
  };
  const menuRun = runMenu && runs.find(run => run.id === runMenu.id);
  const runMenuEntries = (run: RunSummary): ContextMenuEntry[] => {
    const entries: ContextMenuEntry[] = [{ label: "复制会话 ID", action: () => void copyRun(run.id) }];
    if (setRunRead) {
      const isUnread = unread.ids.has(run.id);
      entries.push({ label: isUnread ? "标为已读" : "标为未读", action: () => setRunRead(run, isUnread) });
    }
    if (mutateRun) {
      if (!runSaving) entries.unshift({ label: "重命名", action: () => { setError(undefined); setRunEdit({ id: run.id, title: run.title }); } });
      entries.push({ separator: true }, { label: run.archived ? "取消归档" : "归档", danger: !run.archived, action: () => void updateRun(run.id, { archived: !run.archived }) });
    }
    return entries;
  };
  const group = ({ project, runs: children }: ReturnType<typeof groupProjects>[number]) => {
    const hasDraft = draftProjectId === project.id;
    const expanded = hasDraft || !collapsed.has(project.id);
    const displayed = expanded ? children : unreadOnly ? children.filter(run => run.id === selectedId) : [];
    const visible = displayed.filter(run => !run.archived);
    const unreadCount = unread.byProject.get(project.id) ?? 0;
    return <section key={project.id} data-project-id={project.id} className={`project-group${project.id === currentId ? " is-current" : ""}`}><div className="project-group-header">
    {editing === project.id ? <form onSubmit={event => { event.preventDefault(); if (name.trim()) void update(project.id, { name: name.trim() }).then(ok => { if (ok) setEditing(undefined); }); }}><input autoFocus aria-label="重命名项目" value={name} disabled={working} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setEditing(undefined); } }} /><button className="icon-button" disabled={working || !name.trim()} aria-label="保存项目名称"><Icon name="check" size={12} /></button></form> : <button className="project-group-title" title={`${project.name}\n${project.path}`} aria-expanded={expanded} onClick={() => { if (hasDraft) selectProject(project.id); else toggle(project.id); }}><span>{expanded ? "▾" : "▸"}</span><Icon name="folder" size={13} /><strong>{project.name}</strong></button>}
    {unreadCount > 0 && <span className="project-unread-count" title={`${unreadCount} 个未读会话`}>{unreadCount}</span>}
    {!project.archived && <button type="button" className="icon-button" disabled={!canCreate || !project.exists} aria-label={`在 ${project.name} 新建 Run`} title="新建 Run" onClick={() => newRun(project.id)}><Icon name="plus" size={14} /></button>}{project.archived && <button type="button" className="project-restore text-button" disabled={working} onClick={() => { void update(project.id, { archived: false }); }}>恢复</button>}
    <details className="project-menu" data-menu><summary aria-label={`${project.name} 菜单`}>⋯</summary><div><button type="button" onClick={event => { setEditing(project.id); setName(project.name); event.currentTarget.closest("details")?.removeAttribute("open"); }}>重命名</button><CopyButton text={project.path} label="复制路径" />{desktopBridge() && <button type="button" onClick={() => { void desktopBridge()?.showItemInFolder(project.path).catch((cause: unknown) => setError(errorText(cause))); }}>{desktopBridge()?.platform === "darwin" ? "在 Finder 中显示" : "在资源管理器中显示"}</button>}{project.archived ? <button type="button" disabled={working} onClick={() => { void update(project.id, { archived: false }); }}>恢复</button> : <button type="button" onClick={event => { setError(undefined); setArchiving(project); event.currentTarget.closest("details")?.removeAttribute("open"); }}>归档</button>}</div></details></div>
    <div className="project-group-meta" title={project.path}>{project.gitBranch && <span className="git-badge">⑂ {project.gitBranch}</span>}<span>{project.activeRunCount} 活跃</span>{project.pendingTotal > 0 && <span className="project-pending">{project.pendingTotal} 待处理</span>}{project.backgroundCount > 0 && <span className="run-background-count"><Icon name="server" size={10} />{project.backgroundCount}</span>}{(project.openPrCount ?? 0) > 0 && <span className={`project-pr-count pr-tone-${prTone(pullRequests.filter(pr => pr.projectId === project.id))}`} title={`${project.openPrCount} 个 open / draft PR`}>⑂ {project.openPrCount} PR</span>}{!project.exists && <span className="error-text">目录不存在</span>}</div>
    {(expanded || displayed.length > 0) && <div className="project-runs">
      {hasDraft && <div className="run-list-item selected run-draft" aria-current="page"><div className="run-list-heading"><i className="run-dot" /><span className="run-list-title">新会话</span><span className="run-draft-hint">草稿</span></div></div>}
      {visible.map(runRow)}
      {!unreadOnly && !hasDraft && !visible.length && (children.length === 0 || !project.archived) && <button type="button" className="project-no-runs" disabled={Boolean(project.archived) || !canCreate || !project.exists} onClick={() => newRun(project.id)}>{project.archived ? "没有会话" : "＋ 开始第一个会话"}</button>}
      <ArchivedRuns runs={displayed.filter(run => run.archived)} renderRun={runRow} pinnedId={unreadOnly ? selectedId : null} />
    </div>}
    </section>;
  };
  const unassigned = filterRuns(runs.filter(run => !run.projectId || !projects.some(project => project.id === run.projectId))).sort(compareRunActivity);
  const archivedProjects = groups.filter(entry => entry.project.archived);
  const showArchivedProjects = archivedOpen || archivedProjects.some(({ project }) => project.id === draftProjectId);
  return <nav className="runs-list project-groups" aria-label="项目与会话">
    {error && !archiving && <div className="error-panel sidebar-project-error" role="alert">{error}</div>}
    <button type="button" className="add-project-button" onClick={add}><Icon name="plus" size={13} />添加项目</button>{groups.filter(entry => !entry.project.archived).map(group)}
    {unassigned.length > 0 && <section className="project-group unassigned-project"><div className="project-group-meta">未归属 <span>{unassigned.length} 个旧会话</span></div><div className="project-runs">{unassigned.filter(run => !run.archived).map(runRow)}<ArchivedRuns runs={unassigned.filter(run => run.archived)} renderRun={runRow} pinnedId={unreadOnly ? selectedId : null} /></div></section>}
    {archivedProjects.length > 0 && <div className="archived-projects">
      {unreadOnly ? <div className="archived-projects-toggle">已归档项目 <span>{archivedProjects.length}</span></div> : <button className="archived-projects-toggle" type="button" aria-expanded={showArchivedProjects} onClick={() => setArchivedOpen(value => !value)}>{showArchivedProjects ? "▾" : "▸"} 已归档项目 <span>{archivedProjects.length}</span></button>}
      {(unreadOnly || showArchivedProjects) && archivedProjects.map(group)}
    </div>}
    {loading && <div className="sidebar-loading">正在连接…</div>}
    {!loading && (unreadOnly ? unread.ids.size === 0 && <div className="sidebar-loading">没有未读会话</div> : !projects.length && <div className="sidebar-loading">添加工作目录后开始会话</div>)}
    {archiving && <Modal title="归档项目" close={() => { if (!working) setArchiving(undefined); }}><p>归档「{archiving.name}」？会话会保留，可从“已归档项目”中查看或恢复。</p><code>{archiving.path}</code>{error && <div className="error-panel" role="alert">{error}</div>}<div className="dialog-footer"><button className="button" type="button" disabled={working} onClick={() => setArchiving(undefined)}>返回</button><button className="button danger" type="button" disabled={working} onClick={() => { void update(archiving.id, { archived: true }).then(ok => { if (ok) setArchiving(undefined); }); }}>{working ? "归档中…" : "确认归档"}</button></div></Modal>}
    {runMenu && menuRun && <ContextMenu key={menuRun.id} x={runMenu.x} y={runMenu.y} label="会话操作" trigger={runMenu.trigger} close={() => setRunMenu(undefined)} entries={runMenuEntries(menuRun)} />}
  </nav>;
}
