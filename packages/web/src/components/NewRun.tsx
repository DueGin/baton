import { useEffect, useRef, useState } from "react";
import type { AgentEntry, CreateRunRequest, RunPolicy } from "@baton/protocol";
import { AgentMark, Icon, Status, Toggle } from "./common.js";

export function NewRun({ agents, defaults, close, create, busy, demo, error }: { agents: AgentEntry[]; defaults: RunPolicy; close: () => void; create: (request: CreateRunRequest) => Promise<void>; busy: boolean; demo: boolean; error: string | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [agentId, setAgentId] = useState(agents.find(agent => agent.status === "ready" && agent.enabled)?.id ?? "");
  const agent = agents.find(entry => entry.id === agentId);
  const [model, setModel] = useState(agent?.models.find(entry => entry.isDefault)?.id ?? agent?.models[0]?.id ?? "");
  const [modeId, setMode] = useState(agent?.defaultModeId ?? agent?.modes[0]?.id ?? "");
  const [thinking, setThinking] = useState(""); const [cwd, setCwd] = useState(demo ? "/workspace/atlas" : ""); const [prompt, setPrompt] = useState(""); const [autoApprove, setAutoApprove] = useState(defaults.autoApprove);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const chooseAgent = (id: string): void => { setAgentId(id); const next = agents.find(entry => entry.id === id); setModel(next?.models.find(entry => entry.isDefault)?.id ?? next?.models[0]?.id ?? ""); setMode(next?.defaultModeId ?? next?.modes[0]?.id ?? ""); setThinking(""); };
  const options = agent?.models.find(entry => entry.id === model)?.thinkingOptions ?? [];
  return <dialog ref={dialog} className="new-run-dialog" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget && !busy) close(); }}><form onSubmit={event => { event.preventDefault(); void create({ agent: agentId, ...(model ? { model } : {}), ...(modeId ? { modeId } : {}), ...(thinking ? { thinking } : {}), cwd: cwd.trim(), prompt: prompt.trim(), policy: { ...defaults, autoApprove } }); }}>
    <div className="dialog-heading"><div><span className="eyebrow">NEW COLLABORATION</span><h2>新建 Run</h2><p>选择一个 agent 开始，委派由它自然发起。</p></div><button type="button" className="icon-button" onClick={close} title="关闭"><Icon name="close" /></button></div>
    <fieldset className="agent-picker"><legend>根节点 Agent</legend>{agents.map(entry => <button type="button" key={entry.id} className={`agent-option ${agentId === entry.id ? "selected" : ""}`} disabled={entry.status !== "ready" || !entry.enabled} onClick={() => chooseAgent(entry.id)}><AgentMark agent={entry.id} small /><strong>{entry.label}</strong><Status status={entry.status} dot={false} /></button>)}</fieldset>
    <div className="form-columns"><label>Model<select value={model} onChange={event => { setModel(event.target.value); setThinking(""); }}><option value="">默认模型</option>{agent?.models.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label><label>Mode<select value={modeId} onChange={event => setMode(event.target.value)}><option value="">默认模式</option>{agent?.modes.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label><label>Thinking<select value={thinking} onChange={event => setThinking(event.target.value)} disabled={!options.length}><option value="">默认</option>{options.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label></div>
    <label className="form-field">工作目录<input required value={cwd} onChange={event => setCwd(event.target.value)} placeholder="/absolute/path/to/project" pattern="/.*" autoComplete="off" /><span className="field-hint">agent 将在此目录中运行，填写绝对路径。</span></label>
    <label className="form-field">任务<textarea autoFocus required rows={5} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述目标、约束与验收标准…" /></label>
    <div className="policy-row"><div><Toggle checked={autoApprove} onChange={setAutoApprove} label="自动批准权限请求" /><p>授权动作会记录为 policy。默认由你逐次确认。</p></div></div>
    {demo && <div className="demo-form-note">DEMO · 本次 Run 在浏览器中模拟运行。</div>}
    {error && <div className="error-panel" role="alert">{error}</div>}
    <div className="dialog-footer"><button className="button" type="button" onClick={close}>取消</button><button className="button primary" disabled={busy || !agentId || !prompt.trim() || !cwd.startsWith("/")}>{busy ? "创建中…" : "创建 Run"}<Icon name="arrow" size={15} /></button></div>
  </form></dialog>;
}
