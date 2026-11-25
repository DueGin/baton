import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEntry, CreateTaskRequest, PatchTaskRequest, ProjectSummary, StartTaskRequest, TaskSummary, TeamPreset } from "@baton/protocol";
import { cost } from "../lib/derive.js";
import { keepUnlisted } from "../lib/listbox.js";
import { shortcutLabel } from "../lib/send-shortcut.js";
import { activityAge, groupTasks, taskChanges, taskLabels } from "../lib/tasks.js";
import { errorText } from "../store.js";
import { AgentPicker } from "./AgentPicker.js";
import { ModelPicker } from "./ModelPicker.js";
import { Select } from "./Select.js";
import { Modal } from "./TeamForms.js";
import { Icon } from "./common.js";
import "./tasks.css";

interface TaskPageProps {
  tasks: TaskSummary[]; projects: ProjectSummary[]; currentProjectId: string | null; agents: AgentEntry[]; presets: TeamPreset[];
  busy: boolean; loading: boolean; error: string | null; now: number; refresh: () => void;
  create: (request: CreateTaskRequest) => Promise<TaskSummary>;
  patch: (id: string, request: PatchTaskRequest) => Promise<TaskSummary>;
  startSaved: (task: TaskSummary) => Promise<TaskSummary>;
  remove: (id: string) => Promise<boolean>;
  resolveAgent: (task: Pick<CreateTaskRequest, "projectId" | "agent" | "model" | "teamPresetId">) => Pick<StartTaskRequest, "agent" | "model">;
  start: (task: TaskSummary) => Promise<boolean>;
  startMany: (tasks: TaskSummary[]) => Promise<boolean>;
  open: (runId: string, projectId: string) => void;
}

type TaskDialogProps = Pick<TaskPageProps, "projects" | "currentProjectId" | "agents" | "presets" | "create" | "patch" | "resolveAgent" | "startSaved" | "refresh"> & { task?: TaskSummary; close: () => void };
function TaskDialog({ task, projects, currentProjectId, agents, presets, create, patch, resolveAgent, startSaved, refresh, close }: TaskDialogProps) {
  const available = projects.filter(project => !project.archived);
  const [projectChoice, setProjectChoice] = useState(task?.projectId);
  const projectId = projectChoice ?? (available.find(project => project.id === currentProjectId) ?? available[0])?.id ?? "";
  const [title, setTitle] = useState(task?.title ?? ""); const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [presetId, setPresetId] = useState(task?.teamPresetId ?? "");
  const [choice, setChoice] = useState<Pick<CreateTaskRequest, "agent" | "model">>({ agent: task?.agent, model: task?.model });
  const defaults = resolveAgent({ projectId, ...choice });
  const agentId = choice.agent ?? defaults.agent; const model = choice.model ?? defaults.model;
  const preset = presets.find(entry => entry.id === presetId);
  const [saved, setSaved] = useState(task); const [saving, setSaving] = useState(false); const pending = useRef(false);
  const [error, setError] = useState(""); const [invalidTitle, setInvalidTitle] = useState(false);
  const titleField = useRef<HTMLInputElement>(null); const heading = task ? "编辑任务" : "新建任务";
  useEffect(() => { titleField.current?.closest("dialog")?.setAttribute("aria-label", heading); titleField.current?.focus(); }, [heading]);
  const submit = async (start: boolean) => {
    if (pending.current) return;
    if (!title.trim()) { setInvalidTitle(true); titleField.current?.focus(); return; }
    if (!available.some(project => project.id === projectId)) { setError("请选择未归档的项目。"); return; }
    const request = { projectId, title: title.trim(), prompt: prompt.trim(), ...(presetId ? { teamPresetId: presetId } : choice) };
    pending.current = true; setSaving(true); setError("");
    try {
      let record = saved;
      if (record) {
        const changes = taskChanges(record, request);
        if (Object.keys(changes).length) record = await patch(record.id, changes);
      } else record = await create(request);
      setSaved(record);
      if (start) {
        try { await startSaved(record); }
        catch (cause) { setError(`任务已保存，但启动失败：${errorText(cause)}`); return; }
      }
      close();
    } catch (cause) { setError(errorText(cause)); }
    finally { pending.current = false; setSaving(false); refresh(); }
  };
  const dismiss = () => { if (!pending.current) close(); };
  return <fieldset disabled={saving} className="task-dialog-scope"><Modal title={heading} close={dismiss}>
    <form className="task-dialog-form" noValidate aria-busy={saving} onSubmit={event => {
      event.preventDefault(); const button = (event.nativeEvent as SubmitEvent).submitter;
      void submit(button instanceof HTMLButtonElement && button.value === "start");
    }} onKeyDownCapture={event => {
        if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey || event.shiftKey) return;
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault(); event.stopPropagation();
          const form = event.currentTarget; const button = form.querySelector<HTMLButtonElement>(`button[value="${task ? "save" : "start"}"]`);
          if (button) { button.focus(); queueMicrotask(() => { if (form.isConnected) form.requestSubmit(button); }); }
        }
      }}>
      <label className="form-field"><span>标题 <span className="task-required">必填</span></span><input ref={titleField} autoFocus required maxLength={200} placeholder="任务标题" value={title}
        aria-invalid={invalidTitle || undefined} aria-describedby={invalidTitle ? "task-title-error" : undefined} onChange={event => { setTitle(event.target.value); setInvalidTitle(false); }} /></label>
      {invalidTitle && <p className="task-error" id="task-title-error" role="alert">请输入任务标题。</p>}
      <label className="form-field">提示词<textarea value={prompt} rows={3} placeholder="希望 Agent 做什么？留空则使用任务标题。" onChange={event => setPrompt(event.target.value)} /></label>
      <div className="task-config">
        <label className="form-field">项目<Select label="项目" value={projectId} options={keepUnlisted(available.map(project => ({ value: project.id, label: project.name, description: project.path })), projectId, "项目不可用")} onChange={id => { setProjectChoice(id); setChoice({}); }} /></label>
        <label className="form-field">团队预设<Select label="团队预设" value={presetId} options={keepUnlisted([{ value: "", label: "无预设" }, ...presets.map(entry => ({ value: entry.id, label: entry.name }))], presetId, "预设不可用")} onChange={setPresetId} /></label>
        {presetId ? <div className="task-preset-lead">{preset ? `预设主导者：${preset.lead.agentId} · ${preset.lead.model ?? "默认模型"}` : "找不到此预设，请重新选择。"}</div> : <>
          <AgentPicker label="主导 Agent" agents={agents} value={agentId ?? ""} change={agent => setChoice({ agent })} />
          <label className="form-field">模型<ModelPicker key={agentId} label="模型" agent={agents.find(entry => entry.id === agentId)} value={model} onChange={next => setChoice({ agent: agentId, model: next })} /></label>
        </>}
      </div>
      {!available.length && <p className="task-note">请先在侧栏添加一个项目。</p>}
      {error && <div className="error-panel" role="alert">{error}</div>}
      <div className="dialog-footer"><button className="button" type="button" onClick={dismiss}>取消</button>
        <button className="button primary" type="submit" value="save">{saving ? "保存中…" : saved ? "保存" : "创建"}</button>
        {!task && <button className="button" type="submit" value="start" title={shortcutLabel("mod-enter")} aria-keyshortcuts="Meta+Enter Control+Enter"><Icon name="play" size={13} />{saved ? "重试开始" : "创建并开始"}</button>}
      </div>
    </form>
  </Modal></fieldset>;
}

const dragType = "application/x-baton-task";
interface TodoProps extends Pick<TaskPageProps, "busy" | "remove" | "start" | "resolveAgent"> {
  task: TaskSummary; project: string; preset?: TeamPreset; checked: boolean; toggle: () => void; edit: () => void; drag: (id: string | null) => void;
}
function TodoCard({ task, project, preset, checked, toggle, edit, busy, remove, start, resolveAgent, drag }: TodoProps) {
  const [confirm, setConfirm] = useState(false);
  const resolved = resolveAgent(task);
  const agent = preset?.lead.agentId ?? task.agent ?? (task.teamPresetId ? "预设主导者" : `默认 Agent（${resolved.agent ?? "暂无可用"}）`);
  return <article className={`task-card task-todo-card${checked ? " is-checked" : ""}`} aria-label={task.title} draggable={!confirm && !busy}
    onDragStart={event => { event.dataTransfer.setData(dragType, task.id); event.dataTransfer.effectAllowed = "move"; drag(task.id); }} onDragEnd={() => drag(null)}>
      <div className="task-card-heading"><strong>{task.title}</strong><input className="task-check" type="checkbox" aria-label={`选择「${task.title}」`} checked={checked} onChange={toggle} disabled={busy} /></div>
      <div className="task-project"><Icon name="folder" size={13} />{project}</div>
      <div className="task-meta">{agent} · {preset?.lead.model ?? task.model ?? resolved.model ?? "默认模型"}{preset && ` · ${preset.name}`}</div>
      <div className="task-actions">{confirm ? <><button className="button small" onClick={() => setConfirm(false)}>取消</button><button className="button small danger" disabled={busy} onClick={() => void remove(task.id)}>确认删除</button></> : <>
        <button className="icon-button" title="编辑任务" aria-label={`编辑「${task.title}」`} disabled={busy} onClick={edit}><Icon name="edit" size={15} /></button>
        <button className="icon-button" title="删除任务" aria-label={`删除「${task.title}」`} disabled={busy} onClick={() => setConfirm(true)}><Icon name="trash" size={15} /></button>
        <button className="button small task-start" disabled={busy} onClick={() => void start(task)}><Icon name="play" size={12} />开始</button>
      </>}</div>
    {task.error && <p className="task-error" role="alert">启动失败：{task.error}</p>}
  </article>;
}

function StartedCard({ task, project, now, open }: Pick<TaskPageProps, "now" | "open"> & { task: TaskSummary; project: string }) {
  const { run } = task; const at = run?.lastActivityAt ?? run?.lastEventAt ?? run?.updatedAt ?? task.updatedAt;
  return <button className="task-card task-run-card" disabled={!run} onClick={() => { if (run) open(run.id, task.projectId); }} title={run ? "打开 Run 会话" : "关联的 Run 已不存在"}>
    <span className="task-card-heading"><strong>{task.title}</strong>{run && <Icon name="chevron" size={13} />}</span>
    <span className="task-project"><Icon name="folder" size={13} />{project}</span>
    <span className="task-meta">{run ? <><span>活跃 Agent {run.activeNodeCount}/{run.nodeCount}</span><span className={run.pendingTotal ? "amber-text" : undefined}>{run.pendingTotal} 待处理</span><span>{cost(run.usage.costUsd)}</span></> : "关联的 Run 已不存在"}</span>
    <span className="task-card-footer"><span className={`task-badge status status-${task.status}`}><i className="run-dot" />{taskLabels[task.status]}</span><time dateTime={at} title={new Date(at).toLocaleString("zh-CN")}>{activityAge(at, now)}</time></span>
  </button>;
}

const sections = [
  { key: "todo", title: "待开始", empty: "暂无待开始的任务" },
  { key: "progress", title: "进行中", empty: "暂无正在运行的任务" },
  { key: "attention", title: "待你处理", empty: "暂无暂停或待处理的任务" },
  { key: "ended", title: "已结束", empty: "暂无空闲或已结束的任务" },
] as const;

export function TasksPage(props: TaskPageProps) {
  const { tasks, projects, presets, loading, busy, error, now, refresh, startMany, open } = props;
  const groups = useMemo(() => groupTasks(tasks), [tasks]); const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [dialog, setDialog] = useState<TaskSummary | "create" | null>(null);
  useEffect(() => {
    const newTask = (event: KeyboardEvent) => {
      if (dialog || busy || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== "n") return;
      if (event.target instanceof HTMLElement && (event.target.matches("input, textarea, select") || event.target.isContentEditable)) return;
      if (document.querySelector('dialog[open], [aria-modal="true"], [role="dialog"]')) return;
      event.preventDefault(); setDialog("create");
    };
    window.addEventListener("keydown", newTask); return () => window.removeEventListener("keydown", newTask);
  }, [dialog, busy]);
  const dragged = !busy && dragging ? groups.todo.find(task => task.id === dragging) : undefined;
  const selectedTasks = groups.todo.filter(task => selected.has(task.id));
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <div className="page-content tasks-page">
    <header className="page-heading"><div><span className="eyebrow">TASK BOARD</span><h1>任务 <span className="inbox-heading-count">{tasks.length}</span></h1></div>
      <button className="button primary" aria-keyshortcuts="N" disabled={busy} onClick={() => setDialog("create")}><Icon name="plus" size={15} />新建任务<kbd aria-hidden="true">N</kbd></button>
    </header>
    {dialog && <TaskDialog {...props} task={dialog === "create" ? undefined : dialog} close={() => setDialog(null)} />}
    {error && <div className="error-panel" role="alert">{error} <button className="text-button" onClick={refresh}>刷新任务</button></div>}
    {loading && <p className="task-note" role="status">正在加载任务…</p>}
    <div className="task-board" aria-label="任务看板">{sections.map(section => <section className={`task-column column-${section.key}${section.key === "progress" && dragged ? " can-drop" : ""}`} key={section.key} aria-label={section.title}
      onDragOver={event => { if (section.key === "progress" && dragged && event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
      onDrop={event => { if (section.key !== "progress" || !dragged || event.dataTransfer.getData(dragType) !== dragged.id) return; event.preventDefault(); setDragging(null); void props.start(dragged); }}>
      <header className="task-column-head"><h2><i aria-hidden="true" />{section.title}<span>{groups[section.key].length}</span></h2>
        {section.key === "todo" && <div className="task-batch-actions">
          <button className="button small" disabled={busy || !selectedTasks.length} onClick={() => void startMany(selectedTasks)}>开始所选 ({selectedTasks.length})</button>
          <button className="button small" disabled={busy || !groups.todo.length} onClick={() => void startMany(groups.todo)}>全部开始</button>
        </div>}
      </header>
      <div className="task-cards">{groups[section.key].length ? groups[section.key].map(task => {
        const project = projects.find(entry => entry.id === task.projectId)?.name ?? task.projectId;
        return section.key === "todo" ? <TodoCard key={task.id} {...props} task={task} project={project} preset={presets.find(entry => entry.id === task.teamPresetId)} checked={selected.has(task.id)} toggle={() => toggle(task.id)} edit={() => setDialog(task)} drag={setDragging} /> : <StartedCard key={task.id} task={task} project={project} now={now} open={open} />;
      }) : <p className="task-column-empty">{section.key === "progress" && dragged ? "松开以开始任务" : section.empty}</p>}</div>
    </section>)}</div>
  </div>;
}
