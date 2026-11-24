import { useState } from "react";
import type { AgentEntry, CollaborationMode, CreateRunRequest, ProjectSummary, RunPolicy, TeamCandidateSpec, TeamMemberSpec, TeamPreset } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { agentReady, unavailableMembers } from "../lib/agents.js";
import { projectRunPayload, readProjectAgent, saveProjectAgent, subdirectoryPath } from "../lib/projects.js";
import { candidateConfig, cleanCandidate, cleanMember, collaborationLabels, defaultAgentSpec, validateCandidates, validateMembers } from "../lib/teams.js";
import { AdvancedPolicy } from "./AdvancedPolicy.js";
import { AgentMark, Icon, Toggle } from "./common.js";
import { Select } from "./Select.js";
import { SuggestTextarea } from "./SuggestTextarea.js";
import { AgentFields, CandidatesEditor, MembersEditor } from "./TeamForms.js";
import "./new-session.css";

interface NewSessionProps {
  agents: AgentEntry[];
  presets: TeamPreset[];
  defaults: RunPolicy;
  projects: ProjectSummary[];
  projectId: string;
  selectProject: (id: string) => void;
  addProject: () => void;
  create: (request: CreateRunRequest) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  client: BatonClient;
}

const modes = [
  { id: "dynamic", icon: "graph", hint: "主导者按任务组队" },
  { id: "preset", icon: "agents", hint: "使用已保存的团队" },
  { id: "solo", icon: "chat", hint: "由一个 Agent 独立完成" },
] as const;

function PresetSummary({ preset }: { preset: TeamPreset }) {
  return <div className="new-run-lead-summary">
    <AgentMark agent={preset.lead.agentId} /><div><strong>Lead · {preset.lead.agentId}</strong><code>{preset.lead.model ?? "默认模型"}</code><span>{preset.lead.modeId ?? "default"} · {preset.lead.thinking ?? "default"}</span></div>
    {preset.description && <p>{preset.description}</p>}
    {preset.members.length > 0 && <div className="catalog-tags">{preset.members.map(member => <span className="tag" key={member.role}>{member.role} · {member.agentId}</span>)}</div>}
    {Boolean(preset.candidates?.length) && <div className="new-run-candidates"><strong>候选成员 · 主导者按任务自主招入</strong><ul>{preset.candidates?.map((candidate, index) => <li key={index}><AgentMark agent={candidate.agentId} small /><code>{candidateConfig(candidate)}</code><span>{candidate.description ?? "未填写描述"}</span></li>)}</ul></div>}
  </div>;
}

export function NewSession({ agents, presets, defaults, projects, projectId, selectProject, addProject, create, busy, client, error }: NewSessionProps) {
  const availableProjects = projects.filter(entry => !entry.archived);
  const project = availableProjects.find(entry => entry.id === projectId);
  const initialWorkspace = () => ({ projectId, subdir: "", lead: readProjectAgent(localStorage, projectId) ?? defaultAgentSpec(agents) });
  const [workspace, setWorkspace] = useState(initialWorkspace);
  if (workspace.projectId !== projectId) setWorkspace(initialWorkspace());
  const { subdir, lead } = workspace;
  const [mode, setMode] = useState<CollaborationMode>(defaults.mode ?? "dynamic");
  const [presetId, setPreset] = useState(presets[0]?.id ?? "");
  const [teamApproval, setTeamApproval] = useState(defaults.teamApproval !== false);
  const [autoApprove, setAutoApprove] = useState(defaults.autoApprove);
  const [members, setMembers] = useState<TeamMemberSpec[]>([]);
  const [candidates, setCandidates] = useState<TeamCandidateSpec[]>([]);
  const [advanced, setAdvanced] = useState<Partial<RunPolicy>>({});
  const [prompt, setPrompt] = useState("");
  const preset = presets.find(entry => entry.id === presetId);
  const chosenLead = mode === "preset" ? preset?.lead : lead;
  const policy = { ...defaults, ...advanced, autoApprove, mode, teamApproval, ...(mode === "solo" ? { leadReview: false } : {}) };
  const workdir = project ? subdirectoryPath(project.path, subdir) : {};
  const cwd = project?.exists && !workdir.error ? workdir.cwd ?? project.path : "";
  const roster = mode === "preset" ? preset?.members ?? [] : mode === "dynamic" ? members : [];
  const issues = [...unavailableMembers(agents, roster), ...(mode === "dynamic" ? validateMembers(members) : []), ...(mode !== "solo" ? validateCandidates(candidates) : [])];
  if (workdir.error) issues.push(workdir.error);
  if (!project?.exists) issues.push(project ? "项目目录不存在" : "请选择项目");
  if (mode === "preset" && !preset) issues.push("请选择团队预设");
  else if (!agentReady(agents.find(agent => agent.id === chosenLead?.agentId))) issues.push("所选 Agent 当前不可用，请重新检测或修改配置。");
  if (roster.length > (policy.maxTeamSize ?? 5)) issues.push("成员数超过最大团队成员数，请调整高级策略或名单");
  const disabled = busy || issues.length > 0 || !prompt.trim();
  const submit = async () => {
    if (disabled || !project || !chosenLead) return;
    const payload = projectRunPayload(project, subdir, {
      ...(mode === "preset" ? { teamPresetId: presetId } : { agent: lead.agentId, model: lead.model, modeId: lead.modeId, thinking: lead.thinking }),
      ...(mode === "dynamic" && members.length ? { team: members.map(cleanMember) } : {}),
      ...(mode !== "solo" && candidates.length ? { candidates: candidates.map(cleanCandidate) } : {}),
      prompt: prompt.trim(), policy,
    });
    if (await create(payload)) saveProjectAgent(localStorage, projectId, chosenLead);
  };

  return <section className="new-session" aria-label="新会话">
    <header className="new-session-header"><Icon name="chat" size={17} /><h1>新会话{project && <> · {project.name}</>}</h1><span>草稿</span></header>
    <div className="new-session-scroll"><fieldset className="new-session-config" disabled={busy} aria-label="会话配置">
      <div className="new-session-intro"><h2>开始新会话</h2><p>选择协作方式，发送第一条消息后开始。</p></div>
      <div className="new-session-project"><label className="form-field">项目（工作目录）<Select label="选择项目" value={project?.id ?? ""} onChange={selectProject} searchable searchPlaceholder="搜索项目名称或路径…" options={availableProjects.map(entry => ({ value: entry.id, label: entry.name, description: entry.path, hint: entry.gitBranch, warning: entry.exists ? undefined : "目录不存在", icon: <Icon name="folder" size={15} /> }))} /></label>
        <button type="button" className="text-button" onClick={addProject}><Icon name="plus" size={13} />添加项目…</button></div>
      <fieldset className="new-session-modes"><legend>协作方式</legend>{modes.map(entry => <button key={entry.id} type="button" aria-pressed={mode === entry.id} onClick={() => setMode(entry.id)}><span><Icon name={entry.icon} size={16} /><strong>{collaborationLabels[entry.id]}</strong>{mode === entry.id && <Icon name="check" size={13} />}</span><small>{entry.hint}</small></button>)}</fieldset>
      {mode === "preset" ? <div className="new-session-lead"><label className="form-field">团队预设<Select label="团队预设" value={presetId} onChange={setPreset} placeholder="选择预设团队" options={presets.map(entry => ({ value: entry.id, label: `${entry.name} · ${entry.members.length} roles${entry.candidates?.length ? ` · ${entry.candidates.length} 候选` : ""}`, icon: <AgentMark agent={entry.lead.agentId} small />, description: entry.description }))} /></label>
        {preset ? <PresetSummary preset={preset} /> : <p className="muted">先在左侧「团队」页创建预设，再回到这里使用。</p>}</div>
        : <div className="new-session-lead"><h3>{mode === "solo" ? "执行 Agent" : "主导者 Lead"}</h3><AgentFields agents={agents} value={lead} onChange={next => setWorkspace({ ...workspace, lead: next })} /></div>}
      {mode === "dynamic" && <details className="seed-members"><summary>预先指定成员 <span>{members.length ? `${members.length} 个角色` : "可选"}</span></summary><p className="muted">主导者可继续追加或替换成员。职责请写清范围。</p><MembersEditor agents={agents} members={members} onChange={setMembers} /></details>}
      {mode !== "solo" && <details className="seed-members new-run-candidates"><summary>候选成员 <span>{candidates.length ? `${candidates.length} 个候选` : "可选"}</span></summary><p className="muted">{mode === "preset" ? "在预设的候选之外再加几个。" : "不用填角色，"}主导者按任务、模型和描述选择成员，招入时无需再确认。</p><CandidatesEditor agents={agents} candidates={candidates} onChange={setCandidates} /></details>}
      <div className="new-session-toggles">{mode === "dynamic" && <div><Toggle checked={teamApproval} onChange={setTeamApproval} label="组队后需要我确认" /><p>批准或修改名单后，成员才开始工作。</p></div>}<div><Toggle checked={autoApprove} onChange={setAutoApprove} label="自动批准权限请求" /><p>开启后按策略批准，否则由你逐次确认。</p></div></div>
      <details className="advanced-project-dir"><summary>项目内子目录 <span>{subdir || "可选"}</span></summary><label className="form-field">相对子目录<input aria-label="项目内子目录" value={subdir} onChange={event => setWorkspace({ ...workspace, subdir: event.target.value })} placeholder="packages/web" /><span className="field-hint">留空使用 {project?.path ?? "项目根目录"}；不能越出项目。</span></label></details>
      <AdvancedPolicy policy={policy} change={patch => setAdvanced(current => ({ ...current, ...patch }))} />
    </fieldset></div>
    <div className="composer-stack new-session-dock">
      {issues.length > 0 && <div className="form-errors" role="status" id="new-session-issues">{issues.join("；")}</div>}
      {error && <div className="form-errors" role="alert">{error}</div>}
      <form className="composer" aria-label="第一条消息" aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit(); }} onKeyDown={event => {
        if (!(event.target instanceof HTMLTextAreaElement) || event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault(); if (!event.repeat && !disabled) event.currentTarget.requestSubmit();
      }}>
        <SuggestTextarea autoFocus disabled={busy} rows={2} value={prompt} setValue={setPrompt} aria-label="任务" aria-describedby={issues.length ? "new-session-issues" : undefined} placeholder="描述目标、约束与验收标准…" onKeyDownCapture={event => { if (event.key === "Enter" && event.shiftKey) event.stopPropagation(); }} source={{ client, cwd, commandQuery: chosenLead?.agentId && cwd ? { agentId: chosenLead.agentId, cwd } : null }} />
        <div className="composer-footer"><span className="new-session-input-hint">/ 命令 · @ 文件<span> · Shift+Enter 换行</span></span><div className="composer-actions">{busy ? <span role="status">创建中…</span> : client.demo && <span className="new-session-demo" title="本次 Run 在浏览器中模拟运行">演示模式</span>}<button className="button primary composer-send composer-icon-action" aria-label="发送" title="发送并创建会话 · Enter" disabled={disabled}><Icon name="arrow" size={15} /></button></div></div>
      </form>
    </div>
  </section>;
}
