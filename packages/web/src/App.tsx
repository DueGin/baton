import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AgentEntry, CreateRunRequest, PermissionResponse, RunPolicy, RunSummary } from "@baton/protocol";
import type { BatonClient } from "./api.js";
import { RunStore, errorText } from "./store.js";
import { agentColors, cost, duration, statusLabels, summarize, terminal, tokens } from "./lib/derive.js";
import { AgentMark, Empty, Icon, Status, Toggle } from "./components/common.js";
import { Transcript } from "./components/Transcript.js";
import { Inspector } from "./components/Inspector.js";
import { NewRun } from "./components/NewRun.js";

type Page = "runs" | "agents" | "settings";
type Tab = "topology" | "timeline" | "transcript";
const Topology = lazy(() => import("./components/Topology.js").then(module => ({ default: module.Topology })));
const Timeline = lazy(() => import("./components/Timeline.js").then(module => ({ default: module.Timeline })));
const defaultPolicy: RunPolicy = { maxDepth: 3, maxActiveChildren: 6, autoApprove: false };
function storedPolicy(): RunPolicy {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem("baton.defaults") ?? "null");
    if (typeof saved === "object" && saved) {
      const values = saved as Record<string, unknown>;
      return { maxDepth: typeof values.maxDepth === "number" ? Math.max(0, Math.min(10, values.maxDepth)) : 3, maxActiveChildren: typeof values.maxActiveChildren === "number" ? Math.max(1, Math.min(30, values.maxActiveChildren)) : 6, autoApprove: values.autoApprove === true, ...(typeof values.maxCostUsd === "number" && values.maxCostUsd > 0 ? { budget: { maxCostUsd: values.maxCostUsd } } : {}) };
    }
  } catch { /* Use conservative defaults for malformed settings. */ }
  return defaultPolicy;
}

export default function App({ client }: { client: BatonClient }) {
  const store = useMemo(() => new RunStore(client), [client]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("runs");
  const [tab, setTab] = useState<Tab>("topology");
  const [inspected, setInspected] = useState<string | null>(null);
  const [conversation, setConversation] = useState("");
  const [newRun, setNewRun] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState(storedPolicy);
  const [theme, setTheme] = useState(() => localStorage.getItem("baton.theme") ?? "system");
  const [initialLoading, setInitialLoading] = useState(true);
  const snapshot = state.snapshot;

  const refreshRuns = useCallback(async (): Promise<void> => {
    const entries = await client.runs(); entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); setRuns(entries);
    setRunId(current => current ?? entries[0]?.id ?? null);
  }, [client]);
  useEffect(() => {
    let active = true;
    void Promise.all([refreshRuns(), client.agents().then(entries => { if (active) setAgents(entries); })]).catch((cause: unknown) => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setInitialLoading(false); });
    const timer = setInterval(() => { void refreshRuns().catch(() => undefined); }, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [client, refreshRuns]);
  useEffect(() => { if (runId) { void store.open(runId); setInspected(null); setConversation(""); } return () => store.close(); }, [store, runId]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("baton.theme", theme); }, [theme]);
  useEffect(() => { if (snapshot) { setRuns(current => current.map(entry => entry.id === snapshot.run.id ? summarize(snapshot) : entry)); setConversation(current => current || snapshot.run.rootNodeId); } }, [snapshot]);
  useEffect(() => { const handler = (event: KeyboardEvent): void => { if (event.key === "Escape") setInspected(null); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, []);

  const action = async (operation: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setError(null);
    try { await operation(); return true; } catch (cause) { setError(errorText(cause)); return false; } finally { setBusy(false); }
  };
  const decide = (requestId: string, response: PermissionResponse): void => { void action(() => client.decide(requestId, { response })); };
  const send = async (nodeId: string, text: string): Promise<boolean> => action(() => client.send(nodeId, text));
  const create = async (request: CreateRunRequest): Promise<void> => {
    await action(async () => { const created = await client.createRun(request); await refreshRuns(); setRunId(created.run.id); setPage("runs"); setTab("topology"); setNewRun(false); });
  };
  const refreshAgents = async (): Promise<void> => {
    setRefreshing(true); setError(null);
    try { setAgents(await client.agents(true)); } catch (cause) { setError(errorText(cause)); } finally { setRefreshing(false); }
  };
  const saveDefaults = (policy: RunPolicy): void => { setDefaults(policy); localStorage.setItem("baton.defaults", JSON.stringify({ ...policy, maxCostUsd: policy.budget?.maxCostUsd })); };
  const active = snapshot?.nodes.filter(node => !terminal(node.status) && node.status !== "idle").length ?? 0;
  const permissions = snapshot?.permissions.filter(permission => permission.status === "pending").length ?? 0;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-symbol">b<span>↗</span></span><div>baton <span className="version">0.1</span><small>LOCAL AGENT WORKSPACE</small></div></div>
      <button className="button primary new-run-button" onClick={() => setNewRun(true)} disabled={!agents.some(agent => agent.status === "ready" && agent.enabled)}><Icon name="plus" />新建 Run<span>↵</span></button>
      <div className="sidebar-section-heading"><span>RUNS</span><span>{runs.length.toString().padStart(2, "0")}</span></div>
      <nav className="runs-list" aria-label="Runs">{runs.map(run => <button key={run.id} className={`run-list-item ${runId === run.id && page === "runs" ? "selected" : ""}`} onClick={() => { setRunId(run.id); setPage("runs"); }}><div className="run-list-heading"><i className={`run-dot status-${run.status}`} /><span>{run.title}</span>{run.pendingPermissions > 0 && <span className="permission-count">{run.pendingPermissions}</span>}</div><div className="run-list-meta"><span className="run-agent-dots">{run.agents.map(agent => <i key={agent} style={{ background: agentColors[agent] ?? "#758799" }} title={agent} />)}{run.nodeCount} agents</span><span>{cost(run.usage.costUsd)}</span></div><div className="run-list-bottom"><span>{statusLabels[run.status]}</span><span>{new Date(run.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span></div></button>)}{initialLoading && <div className="sidebar-loading">正在连接…</div>}{!initialLoading && !runs.length && <div className="sidebar-loading">创建第一个 Run 开始协作</div>}</nav>
      <div className="sidebar-footer"><button className={`sidebar-nav ${page === "agents" ? "selected" : ""}`} onClick={() => setPage("agents")}><Icon name="agents" />Agents<span className="nav-count">{agents.filter(agent => agent.status === "ready").length}</span></button><button className={`sidebar-nav ${page === "settings" ? "selected" : ""}`} onClick={() => setPage("settings")}><Icon name="settings" />设置</button><div className="sidebar-bottom"><span className="local-indicator"><i />{client.demo ? "Demo workspace" : "Local daemon"}</span><button className="icon-button" title={theme === "dark" ? "切换为浅色" : "切换为深色"} onClick={() => setTheme(current => current === "dark" ? "light" : "dark")}><Icon name={theme === "dark" ? "sun" : "moon"} size={16} /></button></div></div>
    </aside>
    <main className="main-shell">
      {client.demo && <div className="demo-banner"><span className="demo-tag">DEMO</span><span>浏览器内实时模拟 · 尝试处理授权、查看委派结果，或给任意节点发消息</span><span className="demo-local">无服务端连接</span></div>}
      {(error || state.error) && <div className={`global-error ${state.connection === "reconnecting" && !error ? "reconnect-warning" : ""}`} role="alert"><span>{error ?? state.error}</span><div>{state.connection === "offline" && runId && <button className="text-button" onClick={() => { void store.open(runId); }}>重试</button>}{error && <button className="icon-button" title="关闭提示" onClick={() => setError(null)}><Icon name="close" size={14} /></button>}</div></div>}
      {page === "agents" ? <AgentsPage agents={agents} refreshing={refreshing} refresh={() => { void refreshAgents(); }} /> : page === "settings" ? <SettingsPage policy={defaults} setPolicy={saveDefaults} theme={theme} setTheme={setTheme} agents={agents} /> : snapshot ? <>
        <header className="run-header"><div className="run-breadcrumb">Workspace <Icon name="chevron" size={12} /><span>{snapshot.run.cwd.split("/").filter(Boolean).at(-1)}</span><span className={`connection-indicator ${state.connection}`}>{state.connection === "live" ? "● Live" : state.connection === "reconnecting" ? "◌ 重连中" : "○ 离线"}</span></div><div className="run-title-row"><div><h1>{snapshot.run.title}<Status status={snapshot.run.status} /></h1><div className="run-cwd">{snapshot.run.cwd}</div></div><div className="run-header-actions"><Toggle label="autoApprove" checked={snapshot.run.policy.autoApprove} disabled={busy} onChange={value => { void action(() => client.patchRun(snapshot.run.id, { policy: { autoApprove: value } })); }} /><button className="button cancel-run" disabled={busy || terminal(snapshot.run.status)} onClick={() => { void action(() => client.cancelRun(snapshot.run.id)); }}><Icon name="stop" size={13} />取消 Run</button></div></div>
          <div className="run-stats"><div><strong>{active}<span> / {snapshot.nodes.length}</span></strong><span>活跃节点</span></div><div><strong>{tokens(snapshot.run.usage.inputTokens + snapshot.run.usage.outputTokens)}</strong><span>tokens <small>· {tokens(snapshot.run.usage.cachedInputTokens)} cached</small></span></div><div><strong>{cost(snapshot.run.usage.costUsd)}</strong><span>累计费用</span></div><div><strong>{duration(snapshot.run.createdAt, snapshot.run.endedAt ?? now)}</strong><span>运行时间</span></div><div className="stats-permissions"><strong className={permissions ? "amber-text" : ""}>{permissions.toString().padStart(2, "0")}</strong><span>待处理授权</span></div></div>
        </header>
        <div className="view-tabs" role="tablist" aria-label="Run 视图">{([{ id: "topology", label: "拓扑图", icon: "graph" }, { id: "timeline", label: "时间线", icon: "timeline" }, { id: "transcript", label: "会话", icon: "chat" }] as const).map(entry => <button key={entry.id} role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}><Icon name={entry.icon} size={16} />{entry.label}</button>)}<span className="tab-end-label">{snapshot.delegations.length} delegations · {snapshot.turns.length} turns</span></div>
        <div className="workspace-body"><section className="view-panel" role="tabpanel" aria-label={tab === "topology" ? "拓扑图" : tab === "timeline" ? "时间线" : "会话"}><Suspense fallback={<Empty><div className="loading-orbit" />正在加载视图…</Empty>}>{tab === "topology" ? <Topology snapshot={snapshot} selected={inspected} now={now} inspect={setInspected} decide={decide} busy={busy} /> : tab === "timeline" ? <Timeline key={snapshot.run.id} snapshot={snapshot} now={now} inspect={setInspected} /> : <Transcript snapshot={snapshot} store={store} items={state.items} itemStatus={state.itemStatus} nodeId={conversation || snapshot.run.rootNodeId} setNodeId={setConversation} send={send} busy={busy} />}</Suspense></section>
          {inspected && <Inspector snapshot={snapshot} nodeId={inspected} now={now} close={() => setInspected(null)} converse={id => { setConversation(id); setTab("transcript"); setInspected(null); }} cancel={id => { void action(() => client.cancelNode(id)); }} decide={decide} busy={busy} store={store} items={state.items} />}
        </div>
      </> : <Empty>{initialLoading || state.connection === "loading" && runId ? <><div className="loading-orbit" />正在加载 workspace…</> : <><div className="welcome-mark">b↗</div><h1>从一个目标开始协作</h1><p>让你本机的 agent 自然委派，实时看到每一步。</p><button className="button primary" onClick={() => setNewRun(true)} disabled={!agents.some(agent => agent.status === "ready")}><Icon name="plus" />新建 Run</button></>}</Empty>}
    </main>
    {newRun && <NewRun agents={agents} defaults={defaults} close={() => setNewRun(false)} create={create} busy={busy} demo={client.demo} error={error} />}
  </div>;
}

function AgentsPage({ agents, refresh, refreshing }: { agents: AgentEntry[]; refresh: () => void; refreshing: boolean }) {
  return <div className="page-content"><div className="page-heading"><div><span className="eyebrow">LOCAL RUNTIME</span><h1>Agents</h1><p>baton 驱动本机已经安装的 agent，并自动注入委派能力。</p></div><button className="button" disabled={refreshing} onClick={refresh}><Icon name="refresh" size={16} />{refreshing ? "检测中…" : "重新检测"}</button></div><div className="agents-summary"><span className="green-text">● {agents.filter(agent => agent.status === "ready").length} 可用</span><span>{agents.length} detected agents</span><span>Native + ACP</span></div><div className="agents-grid">{agents.map(agent => <article key={agent.id} className="agent-catalog-card"><div className="catalog-heading"><AgentMark agent={agent.id} /><div><h2>{agent.label}</h2><span>{agent.kind} · {agent.version ?? "version unknown"}</span></div><Status status={agent.status} /></div>{agent.diagnostic && <div className="diagnostic">{agent.diagnostic}</div>}{agent.notes && <p>{agent.notes}</p>}<h4>MODELS</h4><div className="catalog-models">{agent.models.length ? agent.models.map(model => <div key={model.id}><strong>{model.label}</strong><code>{model.id}</code>{model.description && <p>{model.description}</p>}</div>) : <span className="muted">agent 未报告模型</span>}</div><h4>MODES</h4><div className="catalog-tags">{agent.modes.map(mode => <span className="tag" key={mode.id}>{mode.label}{mode.isReadOnly ? " · readonly" : mode.isUnattended ? " · unattended" : ""}</span>)}</div><div className="capabilities">{Object.entries(agent.capabilities).map(([key, value]) => <span key={key} className={value ? "enabled" : ""}>{value ? "✓" : "−"} {key}</span>)}</div><div className="catalog-checked">最近检测 {new Date(agent.checkedAt).toLocaleString("zh-CN", { hour12: false })}</div></article>)}</div></div>;
}

function SettingsPage({ policy, setPolicy, theme, setTheme, agents }: { policy: RunPolicy; setPolicy: (policy: RunPolicy) => void; theme: string; setTheme: (theme: string) => void; agents: AgentEntry[] }) {
  return <div className="page-content settings-page"><div className="page-heading"><div><span className="eyebrow">PREFERENCES</span><h1>设置</h1><p>偏好保存在此浏览器，默认策略应用到新建的 Run。</p></div><span className="saved-indicator">✓ 自动保存</span></div><section className="settings-card"><h2>外观</h2><div className="settings-row"><div><strong>主题</strong><p>选择适合当前环境的界面。</p></div><select aria-label="主题" value={theme} onChange={event => setTheme(event.target.value)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div></section><section className="settings-card"><h2>默认 Run 策略</h2><div className="settings-row"><div><strong>自动批准权限</strong><p>自动允许新 Run 中的权限请求，处理人记录为 policy。</p></div><Toggle checked={policy.autoApprove} onChange={autoApprove => setPolicy({ ...policy, autoApprove })} label="autoApprove" /></div><div className="settings-row"><div><strong>最大委派深度</strong><p>根节点深度为 0。</p></div><input aria-label="最大委派深度" type="number" min="0" max="10" value={policy.maxDepth} onChange={event => setPolicy({ ...policy, maxDepth: Math.max(0, Math.min(10, Number(event.target.value))) })} /></div><div className="settings-row"><div><strong>每个节点最大活跃子委派数</strong><p>限制同时并行的直接子任务。</p></div><input aria-label="最大活跃子委派数" type="number" min="1" max="30" value={policy.maxActiveChildren} onChange={event => setPolicy({ ...policy, maxActiveChildren: Math.max(1, Math.min(30, Number(event.target.value))) })} /></div><div className="settings-row"><div><strong>费用预算 (USD)</strong><p>超过预算后不再接受新的委派。</p></div><input aria-label="费用预算" type="number" min="0" step="0.5" placeholder="不限" value={policy.budget?.maxCostUsd ?? ""} onChange={event => setPolicy({ ...policy, budget: event.target.value ? { maxCostUsd: Math.max(0, Number(event.target.value)) } : undefined })} /></div></section><section className="settings-card"><h2>Agent profiles</h2><p className="muted">这些说明帮助协调 agent 选择合适的委派对象，由 daemon 配置提供。</p>{agents.filter(agent => agent.notes).map(agent => <div className="profile-note" key={agent.id}><AgentMark agent={agent.id} small /><strong>{agent.label}</strong><p>{agent.notes}</p></div>)}</section></div>;
}
