import { useState } from "react";
import type { AgentEntry, CollaborationMode, CreateRunRequest, RunPolicy, TeamMemberSpec, TeamPreset } from "@baton/protocol";
import { AdvancedPolicy } from "./AdvancedPolicy.js";
import { AgentMark, Icon, Toggle } from "./common.js";
import { AgentFields, MembersEditor, Modal } from "./TeamForms.js";
import { cleanMember, collaborationLabels, defaultAgentSpec, validateMembers } from "../lib/teams.js";

export function NewRun({ agents, presets, defaults, close, create, busy, demo, error }: { agents: AgentEntry[]; presets: TeamPreset[]; defaults: RunPolicy; close: () => void; create: (request: CreateRunRequest) => Promise<void>; busy: boolean; demo: boolean; error: string | null }) {
  const [lead, setLead] = useState(defaultAgentSpec(agents));
  const [mode, setMode] = useState<CollaborationMode>(defaults.mode ?? "dynamic");
  const [presetId, setPreset] = useState(presets[0]?.id ?? "");
  const [teamApproval, setTeamApproval] = useState(defaults.teamApproval !== false);
  const [members, setMembers] = useState<TeamMemberSpec[]>([]);
  const [advanced, setAdvanced] = useState<Partial<RunPolicy>>({});
  const [cwd, setCwd] = useState(demo ? "/workspace/atlas" : ""); const [prompt, setPrompt] = useState(""); const [autoApprove, setAutoApprove] = useState(defaults.autoApprove);
  const preset = presets.find(entry => entry.id === presetId);
  const chosenLead = mode === "preset" ? preset?.lead : lead;
  const available = agents.find(agent => agent.id === chosenLead?.agentId);
  const issues = mode === "dynamic" ? validateMembers(members) : [];
  if ((mode === "preset" ? preset?.members.length ?? 0 : members.length) > (advanced.maxTeamSize ?? defaults.maxTeamSize ?? 5)) issues.push("成员数超过最大团队成员数，请调整高级策略或名单");
  return <Modal title="新建 Run" close={close} wide><form onSubmit={event => { event.preventDefault(); if (issues.length) return; void create({ ...(mode === "preset" ? { teamPresetId: presetId } : { agent: lead.agentId, model: lead.model, modeId: lead.modeId, thinking: lead.thinking }), ...(mode === "dynamic" && members.length ? { team: members.map(cleanMember) } : {}), cwd: cwd.trim(), prompt: prompt.trim(), policy: { ...defaults, ...advanced, autoApprove, mode, teamApproval } }); }}>
    <p className="muted">选择协作方式，让主导者按任务组队，或使用固定配置。</p>
    <fieldset className="collaboration-picker"><legend>协作方式</legend>{(["dynamic", "preset", "solo"] as const).map(value => <button type="button" key={value} className={mode === value ? "selected" : ""} onClick={() => setMode(value)}><strong>{collaborationLabels[value]}</strong><span>{value === "dynamic" ? "主导者按需求组队与调整" : value === "preset" ? "使用已保存的 lead 与角色" : "根节点独立处理，不委派"}</span></button>)}</fieldset>
    {mode === "preset" ? <><label className="form-field">团队预设<select value={presetId} onChange={event => setPreset(event.target.value)} required><option value="">选择预设团队</option>{presets.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {entry.members.length} roles</option>)}</select></label>{preset ? <div className="new-run-lead-summary"><AgentMark agent={preset.lead.agentId} /><div><strong>Lead · {preset.lead.agentId}</strong><code>{preset.lead.model ?? "默认模型"}</code><span>{preset.lead.modeId ?? "default"} · {preset.lead.thinking ?? "default"}</span></div><p>{preset.description}</p><div className="catalog-tags">{preset.members.map(member => <span className="tag" key={member.role}>{member.role} · {member.agentId}</span>)}</div></div> : <p className="muted">先在左侧「团队」页创建预设，再回到这里使用。</p>}</> : <><h3 className="form-section-title">{mode === "solo" ? "执行 Agent" : "主导者 Lead"}</h3><AgentFields agents={agents} value={lead} onChange={setLead} />{mode === "dynamic" && <details className="seed-members"><summary>预先指定成员 <span>{members.length ? `${members.length} 个角色` : "可选"}</span></summary><p className="muted">主导者可继续追加或替换成员。职责请写清范围。</p><MembersEditor agents={agents} members={members} onChange={setMembers} /></details>}</>}
    {chosenLead && (!available || available.status !== "ready" || !available.enabled) && <p className="error-text">所选 lead agent 当前不可用，请重新检测或修改配置。</p>}
    <label className="form-field">工作目录<input required value={cwd} onChange={event => setCwd(event.target.value)} placeholder="/absolute/path/to/project" pattern="/.*" autoComplete="off" /><span className="field-hint">agent 将在此目录中运行，填写绝对路径。</span></label>
    <label className="form-field">任务<textarea autoFocus required rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述目标、约束与验收标准…" /></label>
    {mode === "dynamic" && <div className="policy-row"><Toggle checked={teamApproval} onChange={setTeamApproval} label="组队后需要我确认" /><p>主导者提交名单后暂停，批准或修改名单后成员才开始工作。</p></div>}<div className="policy-row"><Toggle checked={autoApprove} onChange={setAutoApprove} label="自动批准权限请求" /><p>授权动作会记录为 policy。默认由你逐次确认。</p></div>
    <AdvancedPolicy policy={{ ...defaults, ...advanced }} change={patch => setAdvanced(current => ({ ...current, ...patch }))} />
    {issues.length > 0 && <div className="form-errors">{issues.join("；")}</div>}{demo && <div className="demo-form-note">DEMO · 本次 Run 在浏览器中模拟运行。</div>}{error && <div className="error-panel" role="alert">{error}</div>}
    <div className="dialog-footer"><button className="button" type="button" onClick={close}>取消</button><button className="button primary" disabled={busy || !chosenLead?.agentId || available?.status !== "ready" || !available.enabled || !prompt.trim() || !cwd.startsWith("/") || issues.length > 0}>{busy ? "创建中…" : "创建 Run"}<Icon name="arrow" size={15} /></button></div>
  </form></Modal>;
}
