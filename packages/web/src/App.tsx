import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { AnswerQuestionRequest, AgentEntry, CreateRunRequest, PermissionResponse, RunPolicy, RunSummary, TeamMember, TeamPreset, PermissionDecision, PermissionRule, CreatePermissionRuleRequest, RunSnapshot, ResolveEscalationRequest, ProjectSummary } from "@baton/protocol";
import type { BatonClient } from "./api.js";
import { InboxStore } from "./inbox-store.js";
import { Inbox } from "./components/Inbox.js";
import { PermissionRules } from "./components/PermissionRules.js";
import { AdvancedPolicy } from "./components/AdvancedPolicy.js";
import { NotificationTracker } from "./lib/notifications.js";
import { snapshotInbox } from "./lib/inbox.js";
import { RunStore, errorText } from "./store.js";
import { summarize } from "./lib/derive.js";
import { AgentMark, Empty, Icon, Status, Toggle } from "./components/common.js";
import { Transcript } from "./components/Transcript.js";
import { Inspector } from "./components/Inspector.js";
import { ProposalCard } from "./components/TeamProposal.js";
import { pendingProposals } from "./lib/teams.js";
import { RunTeam, TeamsPage } from "./components/Teams.js";
import { MemberDialog, ReassignDialog, SavePresetDialog } from "./components/TeamForms.js";
import { RunBar } from "./components/RunBar.js";
import { RightPanel } from "./components/RightPanel.js";
import { RunDetails } from "./components/RunDetails.js";
import { readRunPanel, reduceRunPanel, saveRunPanel, visibleRunPanel, type RunTab } from "./lib/run-layout.js";
import { TitleModelSettings } from "./components/TitleModelSettings.js";
import { AgentMessagePreference } from "./components/AgentMessageCard.js";
import { ReasoningControls } from "./components/ReasoningControls.js";
import { CancelRunDialog } from "./components/BackgroundProcesses.js";
import { AddProject, ProjectsEmpty } from "./components/Projects.js";
import { liveProjectSummaries, readCurrentProject, saveCurrentProject } from "./lib/projects.js";
import { NewRun } from "./components/NewRun.js";

import { Sidebar, type Page } from "./components/Sidebar.js";
const Topology = lazy(() => import("./components/Topology.js").then(module => ({ default: module.Topology })));
const Timeline = lazy(() => import("./components/Timeline.js").then(module => ({ default: module.Timeline })));
const defaultPolicy: RunPolicy = { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, teamApproval: true, mode: "dynamic", maxTeamSize: 5, stallMinutes: 10, maxRoundsPerDelegation: 3 };
function storedPolicy(): RunPolicy {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem("baton.defaults") ?? "null");
    if (typeof saved === "object" && saved) {
      const values = saved as Record<string, unknown>;
      return { maxTeamSize: typeof values.maxTeamSize === "number" ? Math.max(1, Math.min(50, values.maxTeamSize)) : 5, stallMinutes: typeof values.stallMinutes === "number" ? Math.max(1, Math.min(1440, values.stallMinutes)) : 10, maxRoundsPerDelegation: typeof values.maxRoundsPerDelegation === "number" ? Math.max(1, Math.min(100, values.maxRoundsPerDelegation)) : 3, maxDepth: typeof values.maxDepth === "number" ? Math.max(0, Math.min(10, values.maxDepth)) : 3, maxActiveChildren: typeof values.maxActiveChildren === "number" ? Math.max(1, Math.min(30, values.maxActiveChildren)) : 6, autoApprove: values.autoApprove === true, teamApproval: values.teamApproval !== false, mode: values.mode === "solo" || values.mode === "preset" ? values.mode : "dynamic", ...(typeof values.maxCostUsd === "number" && values.maxCostUsd > 0 ? { budget: { maxCostUsd: values.maxCostUsd } } : {}) };
    }
  } catch { /* Use conservative defaults for malformed settings. */ }
  return defaultPolicy;
}

export default function App({ client }: { client: BatonClient }) {
  const store = useMemo(() => new RunStore(client), [client]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const inboxStore = useMemo(() => new InboxStore(client), [client]);
  const inboxState = useSyncExternalStore(inboxStore.subscribe, inboxStore.getSnapshot);
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [inboxSnapshots, setInboxSnapshots] = useState<Record<string, RunSnapshot>>({});
  const [notifications, setNotifications] = useState(() => localStorage.getItem("baton.notifications") === "true");
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(() => typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const notices = useRef(new NotificationTracker());
  const pendingNavigation = useRef<{ runId: string; nodeId?: string } | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [projectRecords, setProjects] = useState<ProjectSummary[]>([]);
  const projects = useMemo(() => liveProjectSummaries(projectRecords, runs), [projectRecords, runs]);
  const [currentProjectId, setCurrentProjectId] = useState(() => readCurrentProject(localStorage));
  const [projectReveal, setProjectReveal] = useState<{ id: string; serial: number } | null>(null);
  const [addProject, setAddProject] = useState(false); const resumeNewRun = useRef(false);
  const rememberProject = useCallback((id: string) => { setCurrentProjectId(id); saveCurrentProject(localStorage, id); }, []);
  const selectProject = useCallback((id: string) => { rememberProject(id); setProjectReveal(current => ({ id, serial: (current?.serial ?? 0) + 1 })); }, [rememberProject]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [teamDialog, setTeamDialog] = useState<"add" | "save" | TeamMember | null>(null);
  const [reassignId, setReassignId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("inbox");
  const [tab, setTab] = useState<RunTab>("topology");
  const [panel, dispatchPanel] = useReducer(reduceRunPanel, { detailsOpen: false, nodeId: null }, () => readRunPanel(localStorage));
  const inspected = panel.nodeId;
  const rightPanel = visibleRunPanel(panel);
  const setInspected = useCallback((nodeId: string | null) => dispatchPanel({ type: "inspect", nodeId }), []);
  useEffect(() => { saveRunPanel(localStorage, panel.detailsOpen); }, [panel.detailsOpen]);
  const [conversation, setConversation] = useState("");
  const [newRun, setNewRun] = useState(false);
  const [cancelingRun, setCancelingRun] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [defaults, setDefaults] = useState(storedPolicy);
  const [theme, setTheme] = useState(() => localStorage.getItem("baton.theme") ?? "system");
  const [initialLoading, setInitialLoading] = useState(true);
  const snapshot = state.snapshot;

  const refreshProjects = useCallback(async () => { setProjects(await client.projects(true)); }, [client]);
  useEffect(() => { if ((!currentProjectId || !projects.some(project => project.id === currentProjectId)) && projects.length) { const first = projects.find(project => !project.archived); if (first) rememberProject(first.id); } }, [currentProjectId, projects, rememberProject]);
  const openNewRun = (id?: string) => { const project = projects.find(project => project.id === (id ?? currentProjectId) && !project.archived) ?? projects.find(project => !project.archived); setError(null); if (!project) { resumeNewRun.current = true; setAddProject(true); return; } rememberProject(project.id); setNewRun(true); };
  const activeProject = projects.find(project => project.id === snapshot?.run.projectId);
  useEffect(() => { inboxStore.start(); return () => inboxStore.stop(); }, [inboxStore]);
  useEffect(() => {
    if (page !== "settings") return;
    let active = true;
    void client.permissionRules().then(entries => { if (active) setRules(entries); }).catch((cause: unknown) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [client, page, inboxState.items]);
  useEffect(() => {
    let active = true;
    const ids = [...new Set(inboxState.items.map(item => item.runId))];
    void Promise.all(ids.map(async id => [id, await client.run(id)] as const)).then(entries => { if (active) setInboxSnapshots(Object.fromEntries(entries)); }).catch(() => undefined);
    return () => { active = false; };
  }, [client, inboxState.items]);
  useEffect(() => {
    if (!inboxState.loaded) return;
    notices.current.observeInbox(inboxState.items, notifications && document.hidden);
  }, [inboxState.items, inboxState.loaded, notifications]);
  useEffect(() => { notices.current.observeRuns(runs, notifications && document.hidden); }, [runs, notifications]);
  useEffect(() => {
    const timer = setInterval(() => {
      const hidden = notifications && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted";
      for (const notice of notices.current.drain(Date.now(), hidden)) {
        try { const notification = new Notification(notice.title, { body: notice.body, tag: `baton:${notice.runId}` }); notification.onclick = () => { window.focus(); setPage("inbox"); notification.close(); }; } catch { /* Browser may disable notifications independently of its permission. */ }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [notifications]);
  const toggleNotifications = async (enabled: boolean): Promise<void> => {
    if (enabled && typeof Notification !== "undefined") {
      try { const permission = await Notification.requestPermission(); setNotificationPermission(permission); enabled = permission === "granted"; } catch { enabled = false; }
    }
    setNotifications(enabled); localStorage.setItem("baton.notifications", String(enabled));
  };
  const refreshRuns = useCallback(async (): Promise<void> => {
    const entries = await client.runs(); const selected = store.getSnapshot().snapshot;
    // Preserve the selected run's live fields (including title source) across list refreshes.
    const current = selected ? entries.findIndex(entry => entry.id === selected.run.id) : -1;
    if (selected && current >= 0 && entries[current]!.updatedAt <= selected.run.updatedAt) entries[current] = summarize(selected);
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); setRuns(entries);
    setRunId(current => current ?? entries[0]?.id ?? null);
  }, [client, store]);
  useEffect(() => {
    let active = true;
    void Promise.all([refreshRuns(), refreshProjects(), client.permissionRules().then(entries => { if (active) setRules(entries); }), client.teams().then(entries => { if (active) setPresets(entries); }), client.agents().then(entries => { if (active) setAgents(entries); })]).catch((cause: unknown) => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setInitialLoading(false); });
    const timer = setInterval(() => { void Promise.all([refreshRuns(), refreshProjects()]).catch(() => undefined); }, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [client, refreshRuns, refreshProjects]);
  useEffect(() => { if (runId) { void store.open(runId); setInspected(null); setConversation(""); setTeamDialog(null); setReassignId(null); setCancelingRun(false); } return () => store.close(); }, [store, runId, setInspected]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("baton.theme", theme); }, [theme]);
  useEffect(() => { if (snapshot && pendingNavigation.current?.runId === snapshot.run.id) { setInspected(pendingNavigation.current.nodeId ?? null); pendingNavigation.current = null; } }, [snapshot, setInspected]);
  useEffect(() => { if (snapshot) { setRuns(current => current.map(entry => entry.id === snapshot.run.id ? summarize(snapshot) : entry)); setConversation(current => current || snapshot.run.rootNodeId); } }, [snapshot]);
  useEffect(() => { const handler = (event: KeyboardEvent): void => { if (event.key === "Escape" && !document.querySelector('[aria-modal="true"], dialog[open]')) dispatchPanel({ type: "close" }); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, []);

  const action = async (operation: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setError(null); setWarnings([]);
    try { await operation(); await inboxStore.refresh(); return true; } catch (cause) { setError(errorText(cause)); return false; } finally { setBusy(false); }
  };
  const decideFull = (id: string, decision: PermissionDecision): void => { void action(async () => { await client.decide(id, decision); if (decision.remember) setRules(await client.permissionRules()); }); };
  const answer = (id: string, request: AnswerQuestionRequest): void => { void action(() => client.answer(id, request)); };
  const resolve = (id: string, request: ResolveEscalationRequest): void => { void action(() => client.resolveEscalation(id, request)); };
  const openInboxItem = (id: string, nodeId?: string, proposal = false): void => { const projectId = runs.find(run => run.id === id)?.projectId; if (projectId) selectProject(projectId); pendingNavigation.current = { runId: id, nodeId }; setPage("runs"); setTab(proposal ? "team" : "topology"); if (id === runId) { setInspected(nodeId ?? null); pendingNavigation.current = null; } else setRunId(id); };
  const decide = (requestId: string, response: PermissionResponse): void => { void action(() => client.decide(requestId, { response })); };
  const create = async (request: CreateRunRequest): Promise<boolean> => {
    return action(async () => { const created = await client.createRun(request); await refreshRuns(); await refreshProjects(); selectProject(request.projectId); setRunId(created.run.id); setPage("runs"); setTab("topology"); setNewRun(false); });
  };
  const refreshAgents = async (): Promise<void> => {
    setRefreshing(true); setError(null);
    try { setAgents(await client.agents(true)); } catch (cause) { setError(errorText(cause)); } finally { setRefreshing(false); }
  };
  const saveDefaults = (policy: RunPolicy): void => { setDefaults(policy); localStorage.setItem("baton.defaults", JSON.stringify({ ...policy, maxCostUsd: policy.budget?.maxCostUsd })); };
  const proposals = pendingProposals(snapshot?.run.team);

  return <div className="app-shell">
    <Sidebar projects={projects} currentProjectId={currentProjectId} reveal={projectReveal} selectProject={rememberProject} addProject={() => { resumeNewRun.current = false; setAddProject(true); }} mutateProject={async (id, request) => { await client.patchProject(id, request); await refreshProjects(); }} runs={runs} runId={runId} page={page} navigate={setPage} selectRun={id => { const projectId = runs.find(run => run.id === id)?.projectId; if (projectId) rememberProject(projectId); setRunId(id); setPage("runs"); }} newRun={openNewRun} canCreate={agents.some(agent => agent.status === "ready" && agent.enabled)} pendingCount={inboxState.loaded ? inboxState.items.length : runs.reduce((sum, run) => sum + run.pendingTotal, 0)} agentCount={agents.filter(agent => agent.status === "ready").length} presetCount={presets.length} theme={theme} toggleTheme={() => setTheme(current => current === "dark" ? "light" : "dark")} demo={client.demo} loading={initialLoading} />
    <main className="main-shell">
      {client.demo && <div className="demo-banner"><span className="demo-tag">DEMO</span><span>浏览器内实时模拟 · 尝试处理授权、查看委派结果，或给任意节点发消息</span><span className="demo-local">无服务端连接</span></div>}
      {(error || state.error) && <div className={`global-error ${state.connection === "reconnecting" && !error ? "reconnect-warning" : ""}`} role="alert"><span>{error ?? state.error}</span><div>{state.connection === "offline" && runId && <button className="text-button" onClick={() => { void store.open(runId); }}>重试</button>}{error && <button className="icon-button" title="关闭提示" onClick={() => setError(null)}><Icon name="close" size={14} /></button>}</div></div>}
      {warnings.length > 0 && <div className="global-error reconnect-warning preset-warnings" role="status"><div><strong>预设已保存 · Agent 可用性提示</strong>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div><button className="icon-button" title="关闭提示" onClick={() => setWarnings([])}><Icon name="close" size={14} /></button></div>}
      {!initialLoading && !projects.length ? <ProjectsEmpty add={() => { resumeNewRun.current = false; setAddProject(true); }} /> : page === "inbox" ? <Inbox projects={projects} items={inboxState.items} snapshots={inboxSnapshots} busy={busy} loading={!inboxState.loaded} error={inboxState.error} refresh={() => { void inboxStore.refresh(); }} open={openInboxItem} decide={decideFull} approve={(id, proposalId) => { void action(() => client.approveTeam(id, proposalId, {})); }} answer={answer} resolve={resolve} /> : page === "agents" ? <AgentsPage agents={agents} refreshing={refreshing} refresh={() => { void refreshAgents(); }} /> : page === "teams" ? <TeamsPage presets={presets} agents={agents} busy={busy} error={error} save={(input, id) => action(async () => { const saved = id ? await client.updateTeam(id, input) : await client.createTeam(input); setWarnings(saved.warnings ?? []); setPresets(await client.teams()); })} remove={id => action(async () => { await client.deleteTeam(id); setPresets(await client.teams()); })} /> : page === "settings" ? <SettingsPage client={client} policy={defaults} setPolicy={saveDefaults} theme={theme} setTheme={setTheme} agents={agents} runs={runs} rules={rules} busy={busy} notifications={notifications} notificationPermission={notificationPermission} toggleNotifications={enabled => { void toggleNotifications(enabled); }} createRule={input => action(async () => { await client.createPermissionRule(input); setRules(await client.permissionRules()); })} removeRule={id => { void action(async () => { await client.deletePermissionRule(id); setRules(await client.permissionRules()); }); }} /> : snapshot ? <>
        <RunBar busy={busy} pause={() => { void action(async () => { await client.pauseRun(snapshot.run.id); }); }} resume={() => { void action(async () => { await client.resumeRun(snapshot.run.id); }); }} project={activeProject} openProject={() => { if (activeProject) selectProject(activeProject.id); }} key={snapshot.run.id} rename={title => action(() => client.patchRun(snapshot.run.id, { title }))} regenerate={() => action(() => client.regenerateTitle(snapshot.run.id))} snapshot={snapshot} tab={tab} setTab={setTab} detailsOpen={rightPanel === "details"} toggleDetails={() => dispatchPanel({ type: "toggle_details" })} />
        <div className="workspace-body"><section id="run-view" className="view-panel" role="tabpanel" aria-labelledby={`run-tab-${tab}`} aria-label={tab === "topology" ? "拓扑图" : tab === "timeline" ? "时间线" : tab === "team" ? "团队" : "会话"}>{(tab === "topology" || tab === "team") && proposals.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} snapshot={snapshot} agents={agents} busy={busy} error={error} approve={request => { void action(() => client.approveTeam(snapshot.run.id, proposal.id, request)); }} reject={feedback => { void action(() => client.rejectTeam(snapshot.run.id, proposal.id, { feedback })); }} />)}<Suspense fallback={<Empty><div className="loading-orbit" />正在加载视图…</Empty>}>{tab === "topology" ? <Topology answer={answer} resolve={resolve} snapshot={snapshot} selected={inspected} now={now} inspect={setInspected} decide={decide} busy={busy} reassign={id => { setError(null); setReassignId(id); }} openTeam={() => setTab("team")} /> : tab === "timeline" ? <Timeline key={snapshot.run.id} snapshot={snapshot} inspect={setInspected} /> : tab === "team" ? <RunTeam snapshot={snapshot} busy={busy} add={() => { setError(null); setTeamDialog("add"); }} replace={member => { setError(null); setTeamDialog(member); }} remove={member => { void action(() => client.removeMember(snapshot.run.id, member.id)); }} save={() => { setError(null); setTeamDialog("save"); }} inspect={setInspected} /> : <Transcript answer={answer} busy={busy} projectName={activeProject?.name} snapshot={snapshot} store={store} items={state.items} itemStatus={state.itemStatus} nodeId={conversation || snapshot.run.rootNodeId} setNodeId={setConversation} now={now} inspect={setInspected} />}</Suspense></section>
          {rightPanel && <button className="right-panel-backdrop" aria-label="关闭侧栏" onClick={() => dispatchPanel({ type: "close" })} />}
          {rightPanel && <RightPanel>{rightPanel === "inspector" && inspected ? <Inspector answer={answer} resolve={resolve} snapshot={snapshot} nodeId={inspected} now={now} close={() => dispatchPanel({ type: "close" })} back={panel.detailsOpen ? () => dispatchPanel({ type: "back_to_details" }) : undefined} converse={id => { setConversation(id); setTab("transcript"); setInspected(null); }} cancel={id => { void action(() => client.cancelNode(id)); }} decide={decide} busy={busy} store={store} items={state.items} inspect={setInspected} reassign={id => { setError(null); setReassignId(id); }} /> : rightPanel === "details" && <RunDetails project={activeProject} openProject={() => { if (activeProject) selectProject(activeProject.id); }} client={client} snapshot={snapshot} now={now} connection={state.connection} busy={busy} close={() => dispatchPanel({ type: "close" })} autoApprove={value => { void action(() => client.patchRun(snapshot.run.id, { policy: { autoApprove: value } })); }} cancel={() => { setError(null); setCancelingRun(true); }} openTeam={() => { setTab("team"); dispatchPanel({ type: "close" }); }} openPending={kind => { if (kind === "proposal") { setTab("team"); dispatchPanel({ type: "close" }); } else { const item = snapshotInbox(snapshot).find(entry => entry.kind === kind); if (item) setInspected(item.kind === "permission" ? item.permission.nodeId : item.kind === "question" ? item.question.nodeId : item.kind === "escalation" ? item.escalation.nodeId : item.proposal.nodeId); } }} />}</RightPanel>}

        </div>
      </> : <Empty>{initialLoading || state.connection === "loading" && runId ? <><div className="loading-orbit" />正在加载 workspace…</> : <><div className="welcome-mark">b↗</div><h1>从一个目标开始协作</h1><p>让你本机的 agent 自然委派，实时看到每一步。</p><button className="button primary" onClick={() => openNewRun()} disabled={!agents.some(agent => agent.status === "ready")}><Icon name="plus" />新建 Run</button></>}</Empty>}
    </main>
    {snapshot && teamDialog && (teamDialog === "save" ? <SavePresetDialog close={() => setTeamDialog(null)} busy={busy} error={error} submit={(name, description) => { void action(async () => { const saved = await client.saveTeam(snapshot.run.id, { name, description }); setWarnings(saved.warnings ?? []); setPresets(await client.teams()); setTeamDialog(null); }); }} /> : <MemberDialog agents={agents} member={teamDialog === "add" ? undefined : teamDialog} snapshot={snapshot} close={() => setTeamDialog(null)} busy={busy} error={error} submit={request => { void action(async () => { if (teamDialog === "add") { if (!("role" in request)) return; await client.addMember(snapshot.run.id, request); } else await client.replaceMember(snapshot.run.id, teamDialog.id, request); setTeamDialog(null); }); }} />)}
    {snapshot && reassignId && <ReassignDialog key={reassignId} agents={agents} snapshot={snapshot} delegationId={reassignId} busy={busy} error={error} close={() => setReassignId(null)} submit={request => { void action(async () => { await client.reassign(reassignId, request); setReassignId(null); }); }} />}
    {snapshot && cancelingRun && <CancelRunDialog snapshot={snapshot} busy={busy} error={error} close={() => { if (!busy) setCancelingRun(false); }} submit={request => { void action(async () => { await client.cancelRun(snapshot.run.id, request); setCancelingRun(false); }); }} />}
    {addProject && <AddProject client={client} close={() => setAddProject(false)} added={async project => { await refreshProjects(); setNewRun(false); selectProject(project.id); setAddProject(false); if (resumeNewRun.current) { setNewRun(true); resumeNewRun.current = false; } }} />}
    {newRun && <NewRun projects={projects} initialProjectId={currentProjectId} selectProject={rememberProject} addProject={() => { resumeNewRun.current = true; setAddProject(true); }} agents={agents} presets={presets} defaults={defaults} close={() => setNewRun(false)} create={create} busy={busy} demo={client.demo} error={error} />}
  </div>;
}

function AgentsPage({ agents, refresh, refreshing }: { agents: AgentEntry[]; refresh: () => void; refreshing: boolean }) {
  return <div className="page-content"><div className="page-heading"><div><span className="eyebrow">LOCAL RUNTIME</span><h1>Agents</h1><p>baton 驱动本机已经安装的 agent，并自动注入委派能力。</p></div><button className="button" disabled={refreshing} onClick={refresh}><Icon name="refresh" size={16} />{refreshing ? "检测中…" : "重新检测"}</button></div><div className="agents-summary"><span className="green-text">● {agents.filter(agent => agent.status === "ready").length} 可用</span><span>{agents.length} detected agents</span><span>Native + ACP</span></div><div className="agents-grid">{agents.map(agent => <article key={agent.id} className="agent-catalog-card"><div className="catalog-heading"><AgentMark agent={agent.id} /><div><h2>{agent.label}</h2><span>{agent.kind} · {agent.version ?? "version unknown"}</span></div><Status status={agent.status} /></div>{agent.diagnostic && <div className="diagnostic">{agent.diagnostic}</div>}{agent.notes && <p>{agent.notes}</p>}<h4>MODELS</h4><div className="catalog-models">{agent.models.length ? agent.models.map(model => <div key={model.id}><strong>{model.label}</strong><code>{model.id}</code>{model.description && <p>{model.description}</p>}</div>) : <span className="muted">agent 未报告模型</span>}</div><h4>MODES</h4><div className="catalog-tags">{agent.modes.map(mode => <span className="tag" key={mode.id}>{mode.label}{mode.isReadOnly ? " · readonly" : mode.isUnattended ? " · unattended" : ""}</span>)}</div><div className="capabilities">{Object.entries(agent.capabilities).map(([key, value]) => <span key={key} className={value ? "enabled" : ""}>{value ? "✓" : "−"} {key}</span>)}</div><div className="catalog-checked">最近检测 {new Date(agent.checkedAt).toLocaleString("zh-CN", { hour12: false })}</div></article>)}</div></div>;
}

function SettingsPage({ client, policy, setPolicy, theme, setTheme, agents, runs, rules, busy, notifications, notificationPermission, toggleNotifications, createRule, removeRule }: { client: BatonClient; runs: RunSummary[]; rules: PermissionRule[]; busy: boolean; notifications: boolean; notificationPermission: NotificationPermission | "unsupported"; toggleNotifications: (enabled: boolean) => void; createRule: (input: CreatePermissionRuleRequest) => Promise<boolean>; removeRule: (id: string) => void; policy: RunPolicy; setPolicy: (policy: RunPolicy) => void; theme: string; setTheme: (theme: string) => void; agents: AgentEntry[] }) {
  return <div className="page-content settings-page"><div className="page-heading"><div><span className="eyebrow">PREFERENCES</span><h1>设置</h1><p>偏好保存在此浏览器，默认策略应用到新建的 Run。</p></div><span className="saved-indicator">✓ 自动保存</span></div><section className="settings-card"><h2>外观</h2><div className="settings-row"><div><strong>主题</strong><p>选择适合当前环境的界面。</p></div><select aria-label="主题" value={theme} onChange={event => setTheme(event.target.value)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div><div className="settings-row"><div><strong>浏览器通知</strong><p>标签页隐藏时提醒新待处理事项和 Run 完成，同 Run 30 秒内合并。{notificationPermission === "denied" ? "浏览器已拒绝权限，请在站点设置中修改。" : notificationPermission === "unsupported" ? "此浏览器不支持 Notification。" : ""}</p></div><Toggle label="浏览器通知" checked={notifications} disabled={notificationPermission === "unsupported"} onChange={toggleNotifications} /></div></section><section className="settings-card"><h2>会话显示</h2><ReasoningControls settings /><AgentMessagePreference /></section><TitleModelSettings client={client} /><section className="settings-card"><h2>默认 Run 策略</h2><div className="settings-row"><div><strong>组队后需要我确认</strong><p>agent 提交名单后，批准才会启动对应委派。</p></div><Toggle checked={policy.teamApproval !== false} onChange={teamApproval => setPolicy({ ...policy, teamApproval })} label="名单确认" /></div><div className="settings-row"><div><strong>协作方式</strong><p>动态组队、预设团队或单独完成。</p></div><select aria-label="默认协作方式" value={policy.mode ?? "dynamic"} onChange={event => setPolicy({ ...policy, mode: event.target.value === "solo" ? "solo" : event.target.value === "preset" ? "preset" : "dynamic" })}><option value="dynamic">动态组队</option><option value="preset">预设团队</option><option value="solo">单独完成</option></select></div><div className="settings-row"><div><strong>自动批准权限</strong><p>自动允许新 Run 中的权限请求，处理人记录为 policy。</p></div><Toggle checked={policy.autoApprove} onChange={autoApprove => setPolicy({ ...policy, autoApprove })} label="autoApprove" /></div><div className="settings-row"><div><strong>最大委派深度</strong><p>根节点深度为 0。</p></div><input aria-label="最大委派深度" type="number" min="0" max="10" value={policy.maxDepth} onChange={event => setPolicy({ ...policy, maxDepth: Math.max(0, Math.min(10, Number(event.target.value))) })} /></div><div className="settings-row"><div><strong>每个节点最大活跃子委派数</strong><p>限制同时并行的直接子任务。</p></div><input aria-label="最大活跃子委派数" type="number" min="1" max="30" value={policy.maxActiveChildren} onChange={event => setPolicy({ ...policy, maxActiveChildren: Math.max(1, Math.min(30, Number(event.target.value))) })} /></div><div className="settings-row"><div><strong>费用预算 (USD)</strong><p>超过预算后不再接受新的委派。</p></div><input aria-label="费用预算" type="number" min="0" step="0.5" placeholder="不限" value={policy.budget?.maxCostUsd ?? ""} onChange={event => setPolicy({ ...policy, budget: event.target.value ? { maxCostUsd: Math.max(0, Number(event.target.value)) } : undefined })} /></div><AdvancedPolicy policy={policy} change={patch => setPolicy({ ...policy, ...patch })} /></section><PermissionRules rules={rules} agents={agents} runs={runs} busy={busy} create={createRule} remove={removeRule} /><section className="settings-card"><h2>Agent profiles</h2><p className="muted">这些说明帮助协调 agent 选择合适的委派对象，由 daemon 配置提供。</p>{agents.filter(agent => agent.notes).map(agent => <div className="profile-note" key={agent.id}><AgentMark agent={agent.id} small /><strong>{agent.label}</strong><p>{agent.notes}</p></div>)}</section></div>;
}
