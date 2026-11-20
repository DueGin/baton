import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { PrChangeTracker } from "./lib/pull-requests.js";
import type { PullRequestRecord, AnswerQuestionRequest, AgentEntry, CreateRunRequest, PermissionResponse, RunPolicy, RunSummary, TeamMember, TeamPreset, PermissionDecision, PermissionRule, RunSnapshot, ResolveEscalationRequest, ProjectSummary } from "@baton/protocol";
import type { BatonClient } from "./api.js";
import { InboxStore } from "./inbox-store.js";
import { Inbox } from "./components/Inbox.js";
import { NotificationTracker } from "./lib/notifications.js";
import { snapshotInbox } from "./lib/inbox.js";
import { RunStore, errorText } from "./store.js";
import { summarize } from "./lib/derive.js";
import { Empty, Icon } from "./components/common.js";
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
import { CancelRunDialog } from "./components/BackgroundProcesses.js";
import { AddProject, ProjectsEmpty } from "./components/Projects.js";
import { liveProjectSummaries, readCurrentProject, saveCurrentProject } from "./lib/projects.js";
import { agentReady } from "./lib/agents.js";
import { ImageContext } from "./lib/images.js";
import { NewRun } from "./components/NewRun.js";
import { desktopBridge, desktopRoute, windowChrome } from "./desktop.js";
import { useColorTheme } from "./lib/theme.js";
import { SessionNavProvider, type SessionNav } from "./lib/session-nav.js";

import { Sidebar, type Page } from "./components/Sidebar.js";
import { readSettingsSection, saveSettingsSection, SettingsContent, SettingsSidebar, type SettingsSection } from "./components/Settings.js";
const Topology = lazy(() => import("./components/Topology.js").then(module => ({ default: module.Topology })));
const Timeline = lazy(() => import("./components/Timeline.js").then(module => ({ default: module.Timeline })));
const defaultPolicy: RunPolicy = { maxDepth: 3, maxActiveChildren: 6, autoApprove: false, teamApproval: true, mode: "dynamic", maxTeamSize: 5, stallMinutes: 10, prFeedback: "notify" };
function storedPolicy(): RunPolicy {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem("baton.defaults") ?? "null");
    if (typeof saved === "object" && saved) {
      const values = saved as Record<string, unknown>;
      return { prFeedback: values.prFeedback === "off" || values.prFeedback === "auto" ? values.prFeedback : "notify", maxTeamSize: typeof values.maxTeamSize === "number" ? Math.max(1, Math.min(50, values.maxTeamSize)) : 5, stallMinutes: typeof values.stallMinutes === "number" ? Math.max(1, Math.min(1440, values.stallMinutes)) : 10, ...(typeof values.maxRoundsPerDelegation === "number" && values.maxRoundsPerDelegation > 0 && localStorage.getItem("baton.roundsUnlimitedMigrated") !== null ? { maxRoundsPerDelegation: Math.min(100, values.maxRoundsPerDelegation) } : {}), maxDepth: typeof values.maxDepth === "number" ? Math.max(0, Math.min(10, values.maxDepth)) : 3, maxActiveChildren: typeof values.maxActiveChildren === "number" ? Math.max(1, Math.min(30, values.maxActiveChildren)) : 6, autoApprove: values.autoApprove === true, teamApproval: values.teamApproval !== false, mode: values.mode === "solo" || values.mode === "preset" ? values.mode : "dynamic", ...(typeof values.maxCostUsd === "number" && values.maxCostUsd > 0 ? { budget: { maxCostUsd: values.maxCostUsd } } : {}) };
    }
  } catch { /* Use conservative defaults for malformed settings. */ }
  return defaultPolicy;
}

export default function App({ client }: { client: BatonClient }) {
  const store = useMemo(() => new RunStore(client), [client]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const inboxStore = useMemo(() => new InboxStore(client), [client]);
  const images = useMemo(() => ({ client }), [client]);
  const inboxState = useSyncExternalStore(inboxStore.subscribe, inboxStore.getSnapshot);
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [inboxSnapshots, setInboxSnapshots] = useState<Record<string, RunSnapshot>>({});
  const [notifications, setNotifications] = useState(() => !desktopBridge() && localStorage.getItem("baton.notifications") === "true");
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(() => typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const notices = useRef(new NotificationTracker());
  const prNotices = useRef(new PrChangeTracker());
  const [allPrs, setAllPrs] = useState<PullRequestRecord[]>([]);
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() => readSettingsSection(localStorage));
  const chooseSettingsSection = (section: SettingsSection): void => { setSettingsSection(section); saveSettingsSection(localStorage, section); };
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

  useEffect(() => {
    if (!desktopBridge()) return;
    const navigate = () => {
      const route = desktopRoute(window.location.pathname, window.location.search); if (!route) return;
      setPage(route.page);
      if (route.page === "runs") { setRunId(route.runId); if (route.nodeId) { pendingNavigation.current = { runId: route.runId, nodeId: route.nodeId }; setConversation(route.nodeId); setTab("transcript"); } }
    };
    navigate(); window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);

  const refreshProjects = useCallback(async () => { setProjects(await client.projects(true)); }, [client]);
  useEffect(() => { if ((!currentProjectId || !projects.some(project => project.id === currentProjectId)) && projects.length) { const first = projects.find(project => !project.archived); if (first) rememberProject(first.id); } }, [currentProjectId, projects, rememberProject]);
  const openNewRun = (id?: string) => { const project = projects.find(project => project.id === (id ?? currentProjectId) && !project.archived) ?? projects.find(project => !project.archived); setError(null); if (!project) { resumeNewRun.current = true; setAddProject(true); return; } rememberProject(project.id); setNewRun(true); };
  const visiblePrs = useMemo(() => snapshot ? [...allPrs.filter(pr => pr.runId !== snapshot.run.id), ...(snapshot.pullRequests ?? [])] : allPrs, [allPrs, snapshot]);
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
      const hidden = !desktopBridge() && notifications && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted";
      for (const notice of notices.current.drain(Date.now(), hidden)) {
        try { const notification = new Notification(notice.title, { body: notice.body, tag: `baton:${notice.runId}` }); notification.onclick = () => { window.focus(); setPage("inbox"); notification.close(); }; } catch { /* Browser may disable notifications independently of its permission. */ }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [notifications]);
  useEffect(() => {
    let active = true;
    const refresh = () => { void client.pullRequests(undefined, "all").then(prs => { if (active) setAllPrs(prs); }).catch(() => undefined); };
    refresh(); const timer = setInterval(refresh, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [client]);
  useEffect(() => {
    const changes = prNotices.current.observe(visiblePrs);
    if (!notifications || !document.hidden || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const change of changes) {
      void client.run(change.runId).then(run => {
        if (!document.hidden || run.run.policy.prFeedback === "off") return;
        const notice = new Notification(change.title, { body: change.body, tag: `baton:pr:${change.prId}` });
        notice.onclick = () => { window.focus(); setPage("runs"); setRunId(change.runId); dispatchPanel({ type: "back_to_details" }); notice.close(); };
      }).catch(() => undefined);
    }
  }, [visiblePrs, client, notifications]);
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
  // Desktop: the native window controls and appearance follow the console's theme and what sits under the top-right corner.
  const colorTheme = useColorTheme(); const hasRunBar = page === "runs" && Boolean(snapshot);
  useEffect(() => {
    const bridge = desktopBridge(); if (!bridge?.setWindowChrome) return;
    const frame = requestAnimationFrame(() => { const chrome = windowChrome(theme); if (chrome) bridge.setWindowChrome?.(chrome); });
    return () => cancelAnimationFrame(frame);
  }, [theme, colorTheme, hasRunBar, page]);
  useEffect(() => { if (snapshot && pendingNavigation.current?.runId === snapshot.run.id) { setInspected(pendingNavigation.current.nodeId ?? null); pendingNavigation.current = null; } }, [snapshot, setInspected]);
  useEffect(() => { if (snapshot) { setRuns(current => current.map(entry => entry.id === snapshot.run.id ? summarize(snapshot) : entry)); setConversation(current => current || snapshot.run.rootNodeId); } }, [snapshot]);
  useEffect(() => { const handler = (event: KeyboardEvent): void => { if (event.key === "Escape" && !document.querySelector('[aria-modal="true"], dialog[open]')) dispatchPanel({ type: "close" }); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, []);

  const action = async (operation: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setError(null); setWarnings([]);
    try { await operation(); await inboxStore.refresh(); return true; } catch (cause) { setError(errorText(cause)); return false; } finally { setBusy(false); }
  };
  const decideFull = (id: string, decision: PermissionDecision): void => { void action(async () => { await client.decide(id, decision); if (decision.remember) setRules(await client.permissionRules()); }); };
  const answer = (id: string, request: AnswerQuestionRequest): void => { void action(() => client.answer(id, request)); };
  const decline = (id: string): void => { void action(() => client.declineQuestion(id)); };
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
  const saveDefaults = (policy: RunPolicy): void => { setDefaults(policy); localStorage.setItem("baton.defaults", JSON.stringify({ ...policy, maxCostUsd: policy.budget?.maxCostUsd })); localStorage.setItem("baton.roundsUnlimitedMigrated", "1"); };
  const proposals = pendingProposals(snapshot?.run.team);

  // Cross-run session messages (DESIGN §4.16): cards jump to the sender's run; replayed conversations read other runs' snapshots.
  const sessionRefs = useMemo(() => new Map(Object.entries(inboxSnapshots).filter(([id]) => id !== snapshot?.run.id)), [inboxSnapshots, snapshot?.run.id]);
  const sessionNav = useMemo<SessionNav>(() => ({ open: (ref) => { openInboxItem(ref.run, ref.node); }, refs: () => sessionRefs, inspect: setInspected }), [inboxSnapshots, runs, runId]);
  return <SessionNavProvider value={sessionNav}><ImageContext value={images}><div className="app-shell">
    {page === "settings" ? <SettingsSidebar section={settingsSection} select={chooseSettingsSection} back={() => setPage("runs")} /> : <Sidebar pullRequests={visiblePrs} projects={projects} currentProjectId={currentProjectId} reveal={projectReveal} selectProject={rememberProject} addProject={() => { resumeNewRun.current = false; setAddProject(true); }} mutateProject={async (id, request) => { await client.patchProject(id, request); await refreshProjects(); }} runs={runs} runId={runId} page={page} navigate={setPage} selectRun={id => { const projectId = runs.find(run => run.id === id)?.projectId; if (projectId) rememberProject(projectId); setRunId(id); setPage("runs"); }} newRun={openNewRun} canCreate={agents.some(agentReady)} pendingCount={inboxState.loaded ? inboxState.items.length : runs.reduce((sum, run) => sum + run.pendingTotal, 0)} presetCount={presets.length} theme={theme} toggleTheme={() => setTheme(current => current === "dark" ? "light" : "dark")} loading={initialLoading} />}
    <main className="main-shell">
      <div className="window-titlebar" aria-hidden="true" />
      {client.demo && <div className="demo-banner"><span className="demo-tag">DEMO</span><span>浏览器内实时模拟 · 尝试处理授权、查看委派结果，或给任意节点发消息</span><span className="demo-local">无服务端连接</span></div>}
      {(error || state.error) && <div className={`global-error ${state.connection === "reconnecting" && !error ? "reconnect-warning" : ""}`} role="alert"><span>{error ?? state.error}</span><div>{state.connection === "offline" && runId && <button className="text-button" onClick={() => { void store.open(runId); }}>重试</button>}{error && <button className="icon-button" title="关闭提示" onClick={() => setError(null)}><Icon name="close" size={14} /></button>}</div></div>}
      {warnings.length > 0 && <div className="global-error reconnect-warning preset-warnings" role="status"><div><strong>预设已保存 · Agent 可用性提示</strong>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div><button className="icon-button" title="关闭提示" onClick={() => setWarnings([])}><Icon name="close" size={14} /></button></div>}
      {page === "runs" && !initialLoading && !projects.length ? <ProjectsEmpty add={() => { resumeNewRun.current = false; setAddProject(true); }} /> : page === "inbox" ? <Inbox projects={projects} items={inboxState.items} snapshots={inboxSnapshots} busy={busy} loading={!inboxState.loaded} error={inboxState.error} refresh={() => { void inboxStore.refresh(); }} open={openInboxItem} decide={decideFull} approve={(id, proposalId) => { void action(() => client.approveTeam(id, proposalId, {})); }} answer={answer} decline={decline} resolve={resolve} /> : page === "teams" ? <TeamsPage presets={presets} agents={agents} busy={busy} error={error} save={(input, id) => action(async () => { const saved = id ? await client.updateTeam(id, input) : await client.createTeam(input); setWarnings(saved.warnings ?? []); setPresets(await client.teams()); })} remove={id => action(async () => { await client.deleteTeam(id); setPresets(await client.teams()); })} /> : page === "settings" ? <SettingsContent section={settingsSection} client={client} demo={client.demo} theme={theme} setTheme={setTheme} notifications={notifications} notificationPermission={notificationPermission} toggleNotifications={enabled => { void toggleNotifications(enabled); }} policy={defaults} setPolicy={saveDefaults} agents={agents} refreshing={refreshing} refreshAgents={() => { void refreshAgents(); }} runs={runs} rules={rules} busy={busy} createRule={input => action(async () => { await client.createPermissionRule(input); setRules(await client.permissionRules()); })} removeRule={id => { void action(async () => { await client.deletePermissionRule(id); setRules(await client.permissionRules()); }); }} /> : snapshot ? <>
        <RunBar busy={busy} pause={() => { void action(async () => { await client.pauseRun(snapshot.run.id); }); }} resume={() => { void action(async () => { await client.resumeRun(snapshot.run.id); }); }} project={activeProject} openProject={() => { if (activeProject) selectProject(activeProject.id); }} key={snapshot.run.id} rename={title => action(() => client.patchRun(snapshot.run.id, { title }))} regenerate={() => action(() => client.regenerateTitle(snapshot.run.id))} snapshot={snapshot} tab={tab} setTab={setTab} detailsOpen={rightPanel === "details"} toggleDetails={() => dispatchPanel({ type: "toggle_details" })} />
        <div className="workspace-body"><section id="run-view" className="view-panel" role="tabpanel" aria-labelledby={`run-tab-${tab}`} aria-label={tab === "topology" ? "拓扑图" : tab === "timeline" ? "时间线" : tab === "team" ? "团队" : "会话"}>{(tab === "topology" || tab === "team") && proposals.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} snapshot={snapshot} agents={agents} busy={busy} error={error} approve={request => { void action(() => client.approveTeam(snapshot.run.id, proposal.id, request)); }} reject={feedback => { void action(() => client.rejectTeam(snapshot.run.id, proposal.id, { feedback })); }} />)}<Suspense fallback={<Empty><div className="loading-orbit" />正在加载视图…</Empty>}>{tab === "topology" ? <Topology answer={answer} decline={decline} resolve={resolve} snapshot={snapshot} selected={inspected} now={now} inspect={setInspected} decide={decide} busy={busy} reassign={id => { setError(null); setReassignId(id); }} openTeam={() => setTab("team")} /> : tab === "timeline" ? <Timeline key={snapshot.run.id} snapshot={snapshot} inspect={setInspected} /> : tab === "team" ? <RunTeam snapshot={snapshot} busy={busy} add={() => { setError(null); setTeamDialog("add"); }} replace={member => { setError(null); setTeamDialog(member); }} remove={member => { void action(() => client.removeMember(snapshot.run.id, member.id)); }} save={() => { setError(null); setTeamDialog("save"); }} inspect={setInspected} /> : <Transcript refs={sessionRefs} agents={agents} stopRun={() => { void action(async () => { await client.pauseRun(snapshot.run.id); }); }} resumeRun={() => { void action(async () => { await client.resumeRun(snapshot.run.id); }); }} answer={answer} decline={decline} busy={busy} projectName={activeProject?.name} snapshot={snapshot} store={store} items={state.items} itemStatus={state.itemStatus} nodeId={conversation || snapshot.run.rootNodeId} setNodeId={setConversation} now={now} inspect={setInspected} />}</Suspense></section>
          {rightPanel && <button className="right-panel-backdrop" aria-label="关闭侧栏" onClick={() => dispatchPanel({ type: "close" })} />}
          {rightPanel && <RightPanel>{rightPanel === "inspector" && inspected ? <Inspector answer={answer} decline={decline} resolve={resolve} snapshot={snapshot} nodeId={inspected} now={now} close={() => dispatchPanel({ type: "close" })} back={panel.detailsOpen ? () => dispatchPanel({ type: "back_to_details" }) : undefined} converse={id => { setConversation(id); setTab("transcript"); setInspected(null); }} cancel={id => { void action(() => client.cancelNode(id)); }} decide={decide} busy={busy} store={store} items={state.items} inspect={setInspected} reassign={id => { setError(null); setReassignId(id); }} /> : rightPanel === "details" && <RunDetails inspect={setInspected} project={activeProject} openProject={() => { if (activeProject) selectProject(activeProject.id); }} client={client} snapshot={snapshot} now={now} connection={state.connection} busy={busy} close={() => dispatchPanel({ type: "close" })} autoApprove={value => { void action(() => client.patchRun(snapshot.run.id, { policy: { autoApprove: value } })); }} cancel={() => { setError(null); setCancelingRun(true); }} openTeam={() => { setTab("team"); dispatchPanel({ type: "close" }); }} openPending={kind => { if (kind === "proposal") { setTab("team"); dispatchPanel({ type: "close" }); } else { const item = snapshotInbox(snapshot).find(entry => entry.kind === kind); if (item) setInspected(item.kind === "permission" ? item.permission.nodeId : item.kind === "question" ? item.question.nodeId : item.kind === "escalation" ? item.escalation.nodeId : item.proposal.nodeId); } }} />}</RightPanel>}

        </div>
      </> : <Empty>{initialLoading || state.connection === "loading" && runId ? <><div className="loading-orbit" />正在加载 workspace…</> : <><div className="welcome-mark">b↗</div><h1>从一个目标开始协作</h1><p>让你本机的 agent 自然委派，实时看到每一步。</p><button className="button primary" onClick={() => openNewRun()} disabled={!agents.some(agent => agent.status === "ready")}><Icon name="plus" />新建 Run</button></>}</Empty>}
    </main>
    {snapshot && teamDialog && (teamDialog === "save" ? <SavePresetDialog close={() => setTeamDialog(null)} busy={busy} error={error} submit={(name, description) => { void action(async () => { const saved = await client.saveTeam(snapshot.run.id, { name, description }); setWarnings(saved.warnings ?? []); setPresets(await client.teams()); setTeamDialog(null); }); }} /> : <MemberDialog agents={agents} member={teamDialog === "add" ? undefined : teamDialog} snapshot={snapshot} close={() => setTeamDialog(null)} busy={busy} error={error} submit={request => { void action(async () => { if (teamDialog === "add") { if (!("role" in request)) return; await client.addMember(snapshot.run.id, request); } else await client.replaceMember(snapshot.run.id, teamDialog.id, request); setTeamDialog(null); }); }} />)}
    {snapshot && reassignId && <ReassignDialog key={reassignId} agents={agents} snapshot={snapshot} delegationId={reassignId} busy={busy} error={error} close={() => setReassignId(null)} submit={request => { void action(async () => { await client.reassign(reassignId, request); setReassignId(null); }); }} />}
    {snapshot && cancelingRun && <CancelRunDialog snapshot={snapshot} busy={busy} error={error} close={() => { if (!busy) setCancelingRun(false); }} submit={request => { void action(async () => { await client.cancelRun(snapshot.run.id, request); setCancelingRun(false); }); }} />}
    {addProject && <AddProject client={client} close={() => setAddProject(false)} added={async project => { await refreshProjects(); setNewRun(false); selectProject(project.id); setAddProject(false); if (resumeNewRun.current) { setNewRun(true); resumeNewRun.current = false; } }} />}
    {newRun && <NewRun projects={projects} initialProjectId={currentProjectId} selectProject={rememberProject} addProject={() => { resumeNewRun.current = true; setAddProject(true); }} agents={agents} presets={presets} defaults={defaults} close={() => setNewRun(false)} create={create} busy={busy} demo={client.demo} error={error} />}
  </div></ImageContext></SessionNavProvider>;
}

