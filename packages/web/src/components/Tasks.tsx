import { useMemo, useRef, useState } from "react";
import type { AgentEntry, CreateTaskRequest, PatchTaskRequest, ProjectSummary, StartTaskRequest, TaskSummary, TeamPreset } from "@baton/protocol";
import { agentReady } from "../lib/agents.js";
import { cost } from "../lib/derive.js";
import { readProjectAgent } from "../lib/projects.js";
import { activityAge, groupTasks, taskLabels } from "../lib/tasks.js";
import { AgentPicker } from "./AgentPicker.js";
import { ModelPicker } from "./ModelPicker.js";
import { Select } from "./Select.js";
import { Icon } from "./common.js";
import "./tasks.css";

interface TaskPageProps {
  tasks: TaskSummary[]; projects: ProjectSummary[]; currentProjectId: string | null; agents: AgentEntry[]; presets: TeamPreset[];
  busy: boolean; loading: boolean; error: string | null; now: number; refresh: () => void;
  create: (request: CreateTaskRequest) => Promise<boolean>;
  patch: (id: string, request: PatchTaskRequest) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  resolveAgent: (task: TaskSummary) => Pick<StartTaskRequest, "agent" | "model">;
  start: (task: TaskSummary) => Promise<boolean>;
  startMany: (tasks: TaskSummary[]) => Promise<boolean>;
  open: (runId: string, projectId: string) => void;
}

function QuickAdd({ projects, currentProjectId, agents, presets, busy, create }: Pick<TaskPageProps, "projects" | "currentProjectId" | "agents" | "presets" | "busy" | "create">) {
  const [title, setTitle] = useState(""); const [prompt, setPrompt] = useState("");
  const [details, setDetails] = useState(false); const field = useRef<HTMLInputElement>(null);
  const [projectChoice, setProjectChoice] = useState<string>();
  const [choice, setChoice] = useState<{ agentId: string; model?: string }>(); const [presetId, setPresetId] = useState("");
  const available = projects.filter(project => !project.archived);
  const projectId = (available.find(project => project.id === (projectChoice ?? currentProjectId)) ?? available[0])?.id;
  const saved = useMemo(() => projectId && typeof localStorage !== "undefined" ? readProjectAgent(localStorage, projectId) : undefined, [projectId]);
  const preferred = choice ?? saved;
  const agent = agents.find(entry => entry.id === preferred?.agentId && agentReady(entry)) ?? agents.find(agentReady);
  const model = preferred?.agentId === agent?.id ? preferred?.model : undefined;
  const preset = presets.find(entry => entry.id === presetId);
  const submit = async () => {
    if (busy || !title.trim() || !projectId) return;
    if (await create({ title: title.trim(), prompt: prompt.trim(), projectId, ...(preset ? { teamPresetId: preset.id } : { agent: agent?.id, model }) })) {
      setTitle(""); setPrompt(""); field.current?.focus();
    }
  };
  return <form className="task-quick-add" aria-label="快速添加任务" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="task-quick-line">
      <input ref={field} aria-label="任务标题" placeholder="任务标题" maxLength={200} required readOnly={busy} value={title} onChange={event => setTitle(event.target.value)} />
      <button className="button" type="button" aria-expanded={details} aria-controls="task-details" onClick={() => setDetails(!details)}>详情<Icon name={details ? "up" : "down"} size={12} /></button>
      <button className="button primary" type="submit" disabled={busy || !title.trim() || !projectId}><Icon name="plus" size={15} />添加</button>
    </div>
    {!projectId && <p className="task-note">请先在侧栏添加一个项目，再收集任务。</p>}
    {details && <div className="task-details" id="task-details">
      <label className="form-field">提示词<textarea value={prompt} readOnly={busy} rows={3} placeholder="希望 agent 做什么？留空则使用任务标题。" onChange={event => setPrompt(event.target.value)} /></label>
      <div className="task-config">
        <label className="form-field">项目<Select label="项目" value={projectId ?? ""} options={available.map(project => ({ value: project.id, label: project.name, description: project.path }))} onChange={id => { setProjectChoice(id); setChoice(undefined); }} /></label>
        <label className="form-field">团队预设<Select label="团队预设" value={preset?.id ?? ""} options={[{ value: "", label: "无预设" }, ...presets.map(entry => ({ value: entry.id, label: entry.name }))]} onChange={setPresetId} /></label>
        {preset ? <div className="task-preset-lead">预设主导者：{preset.lead.agentId} · {preset.lead.model ?? "默认模型"}</div> : <>
          <AgentPicker label="主导 Agent" agents={agents} value={agent?.id ?? ""} change={agentId => setChoice({ agentId })} />
          <label className="form-field">模型<ModelPicker key={agent?.id} label="模型" agent={agent} value={model} onChange={next => { if (agent) setChoice({ agentId: agent.id, model: next }); }} /></label>
        </>}
      </div>
    </div>}
  </form>;
}

const dragType = "application/x-baton-task";
interface TodoProps extends Pick<TaskPageProps, "busy" | "patch" | "remove" | "start" | "resolveAgent"> {
  task: TaskSummary; project: string; preset?: TeamPreset; checked: boolean; toggle: () => void; drag: (id: string | null) => void;
}
function TodoCard({ task, project, preset, checked, toggle, busy, patch, remove, start, resolveAgent, drag }: TodoProps) {
  const [edit, setEdit] = useState<{ title: string; prompt: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const save = async () => { if (edit?.title.trim() && await patch(task.id, { title: edit.title.trim(), prompt: edit.prompt.trim() })) setEdit(null); };
  const resolved = resolveAgent(task);
  const agent = preset?.lead.agentId ?? task.agent ?? (task.teamPresetId ? "预设主导者" : `默认 Agent（${resolved.agent ?? "暂无可用"}）`);
  return <article className={`task-card task-todo-card${checked ? " is-checked" : ""}`} aria-label={task.title} draggable={!edit && !confirm && !busy}
    onDragStart={event => { event.dataTransfer.setData(dragType, task.id); event.dataTransfer.effectAllowed = "move"; drag(task.id); }} onDragEnd={() => drag(null)}>
    {edit ? <form className="task-edit" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="form-field">标题<input autoFocus required readOnly={busy} maxLength={200} value={edit.title} onChange={event => setEdit({ ...edit, title: event.target.value })} /></label>
      <label className="form-field">提示词<textarea rows={2} readOnly={busy} value={edit.prompt} onChange={event => setEdit({ ...edit, prompt: event.target.value })} /></label>
      <div className="task-actions"><button className="button small" type="button" onClick={() => setEdit(null)}>取消</button><button className="button small primary" disabled={busy || !edit.title.trim()}>保存</button></div>
    </form> : <>
      <div className="task-card-heading"><strong>{task.title}</strong><input className="task-check" type="checkbox" aria-label={`选择「${task.title}」`} checked={checked} onChange={toggle} disabled={busy} /></div>
      <div className="task-project"><Icon name="folder" size={13} />{project}</div>
      <div className="task-meta">{agent} · {preset?.lead.model ?? task.model ?? resolved.model ?? "默认模型"}{preset && ` · ${preset.name}`}</div>
      <div className="task-actions">{confirm ? <><button className="button small" onClick={() => setConfirm(false)}>取消</button><button className="button small danger" disabled={busy} onClick={() => void remove(task.id)}>确认删除</button></> : <>
        <button className="icon-button" title="编辑任务" aria-label={`编辑「${task.title}」`} disabled={busy} onClick={() => setEdit({ title: task.title, prompt: task.prompt })}><Icon name="edit" size={15} /></button>
        <button className="icon-button" title="删除任务" aria-label={`删除「${task.title}」`} disabled={busy} onClick={() => setConfirm(true)}><Icon name="trash" size={15} /></button>
        <button className="button small task-start" disabled={busy} onClick={() => void start(task)}><Icon name="play" size={12} />开始</button>
      </>}</div>
    </>}
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
  const dragged = !busy && dragging ? groups.todo.find(task => task.id === dragging) : undefined;
  const selectedTasks = groups.todo.filter(task => selected.has(task.id));
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <div className="page-content tasks-page">
    <header className="page-heading"><div><span className="eyebrow">TASK BOARD</span><h1>任务 <span className="inbox-heading-count">{tasks.length}</span></h1></div></header>
    <QuickAdd {...props} />
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
        return section.key === "todo" ? <TodoCard key={task.id} {...props} task={task} project={project} preset={presets.find(entry => entry.id === task.teamPresetId)} checked={selected.has(task.id)} toggle={() => toggle(task.id)} drag={setDragging} /> : <StartedCard key={task.id} task={task} project={project} now={now} open={open} />;
      }) : <p className="task-column-empty">{section.key === "progress" && dragged ? "松开以开始任务" : section.empty}</p>}</div>
    </section>)}</div>
  </div>;
}
