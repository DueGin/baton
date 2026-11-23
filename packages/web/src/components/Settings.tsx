import type { ReactNode } from "react";
import type { AgentEntry, CreatePermissionRuleRequest, PermissionRule, RunPolicy, RunSummary } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { desktopBridge } from "../desktop.js";
import { AdvancedPolicy } from "./AdvancedPolicy.js";
import { AgentMessagePreference } from "./AgentMessageCard.js";
import { AgentsPage } from "./Agents.js";
import { AgentMark, Icon, Toggle } from "./common.js";
import { ForgeIcon } from "./ForgeIcon.js";
import { GithubSettingsForm } from "./GithubSettings.js";
import { PermissionRules } from "./PermissionRules.js";
import { ReasoningControls } from "./ReasoningControls.js";
import { sendShortcuts, shortcutLabel, useSendShortcut } from "../lib/send-shortcut.js";
import { Select, type SelectOption } from "./Select.js";
import { TitleModelSettings } from "./TitleModelSettings.js";
import { UpdatesSettings } from "./UpdatesSettings.js";

export type SettingsSection = "general" | "conversation" | "agents" | "policy" | "permissions" | "title" | "github" | "updates" | "about";
type IconName = Parameters<typeof Icon>[0]["name"];
interface SectionEntry { id: SettingsSection; label: string; icon: IconName | "github" }
/** The settings sidebar: grouped categories, one page each. */
export const settingsGroups: { label: string; items: SectionEntry[] }[] = [
  { label: "偏好", items: [{ id: "general", label: "通用", icon: "settings" }, { id: "conversation", label: "会话显示", icon: "chat" }] },
  { label: "运行", items: [{ id: "agents", label: "Agents", icon: "agents" }, { id: "policy", label: "Run 策略", icon: "graph" }, { id: "permissions", label: "权限规则", icon: "shield" }] },
  { label: "集成", items: [{ id: "title", label: "标题模型", icon: "edit" }, { id: "github", label: "GitHub", icon: "github" }] },
  { label: "应用", items: [{ id: "updates", label: "更新", icon: "refresh" }, { id: "about", label: "关于", icon: "info" }] },
];
const sectionIds = new Set<string>(settingsGroups.flatMap(group => group.items.map(item => item.id)));
const sectionKey = "baton.settingsSection";
export function readSettingsSection(storage: Pick<Storage, "getItem">): SettingsSection {
  const saved = storage.getItem(sectionKey);
  return saved && sectionIds.has(saved) ? saved as SettingsSection : "general";
}
export function saveSettingsSection(storage: Pick<Storage, "setItem">, section: SettingsSection): void { storage.setItem(sectionKey, section); }

const sectionIcon = (icon: SectionEntry["icon"]): ReactNode => <span className="settings-nav-icon" aria-hidden="true">{icon === "github" ? <ForgeIcon forge="github" size={16} /> : <Icon name={icon} size={16} />}</span>;

/** Replaces the workspace navigation while settings are open; the back button returns to the conversation page. */
export function SettingsSidebar({ section, select, back }: { section: SettingsSection; select: (section: SettingsSection) => void; back: () => void }) {
  return <aside className="sidebar settings-sidebar" aria-label="设置">
    <div className="sidebar-top"><button type="button" className="settings-back" title="返回对话" aria-label="返回对话" onClick={back}><Icon name="back" size={16} /><span className="sidebar-label">返回对话</span></button></div>
    <h2 className="settings-sidebar-title">设置</h2>
    <nav className="settings-nav" aria-label="设置分类">{settingsGroups.map(group => <div className="settings-nav-group" key={group.label}>
      <span className="settings-nav-heading">{group.label}</span>
      {group.items.map(item => <button key={item.id} type="button" className={`settings-nav-item${item.id === section ? " selected" : ""}`} aria-current={item.id === section ? "page" : undefined} title={item.label} onClick={() => select(item.id)}>{sectionIcon(item.icon)}<span className="sidebar-label">{item.label}</span></button>)}
    </div>)}</nav>
  </aside>;
}

const themeOptions: SelectOption[] = [{ value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }];
const collaborationOptions: SelectOption[] = [{ value: "dynamic", label: "动态组队", description: "主导者按需求组队与调整" }, { value: "preset", label: "预设团队", description: "使用已保存的 lead 与角色" }, { value: "solo", label: "单独完成", description: "根节点独立处理，不委派" }];
const platformLabel = (platform: string): string => platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";

function SendShortcutSetting() {
  const shortcut = useSendShortcut();
  return <div className="settings-row"><div><strong>发送快捷键</strong><p>也用于保存排队消息。列表和代码块里的 Enter 保留编辑功能。</p></div>
    <Select label="发送快捷键" value={shortcut} options={[{ value: "enter", label: "Enter 发送，Shift + Enter 换行" }, { value: "mod-enter", label: `${shortcutLabel("mod-enter")} 发送，Enter 换行` }]}
      onChange={value => sendShortcuts.set(value === "enter" ? "enter" : "mod-enter")} /></div>;
}

export interface SettingsContentProps {
  section: SettingsSection;
  client: BatonClient; demo: boolean;
  theme: string; setTheme: (theme: string) => void;
  notifications: boolean; notificationPermission: NotificationPermission | "unsupported"; toggleNotifications: (enabled: boolean) => void;
  policy: RunPolicy; setPolicy: (policy: RunPolicy) => void;
  agents: AgentEntry[]; refreshing: boolean; refreshAgents: () => void;
  runs: RunSummary[]; rules: PermissionRule[]; busy: boolean; createRule: (input: CreatePermissionRuleRequest) => Promise<boolean>; removeRule: (id: string) => void;
}

/** One settings category per page. Single-card pages hide the card's own title (the page heading already says it). */
export function SettingsContent(props: SettingsContentProps) {
  const { section, policy, setPolicy } = props;
  if (section === "agents") return <AgentsPage embedded agents={props.agents} refreshing={props.refreshing} refresh={props.refreshAgents}><section className="settings-card agent-profiles"><h2>Agent profiles</h2><p className="muted">这些说明帮助协调 agent 选择合适的委派对象，由 daemon 配置提供。</p>{props.agents.filter(agent => agent.notes).map(agent => <div className="profile-note" key={agent.id}><AgentMark agent={agent.id} small /><strong>{agent.label}</strong><p>{agent.notes}</p></div>)}</section></AgentsPage>;
  const bridge = desktopBridge();
  const saved = <span className="saved-indicator">✓ 自动保存</span>;
  const page = (title: string, body: ReactNode, options: { description?: string; extra?: ReactNode; single?: boolean } = {}) => <div className={`page-content settings-page settings-section-${section}${options.single ? " single" : ""}`}>
    <div className="page-heading"><div><span className="eyebrow">SETTINGS</span><h1>{title}</h1>{options.description && <p>{options.description}</p>}</div>{options.extra}</div>
    {body}
  </div>;
  switch (section) {
    case "general": return page("通用", <section className="settings-card"><h2>外观</h2>
      <div className="settings-row"><div><strong>主题</strong><p>选择适合当前环境的界面。</p></div><Select label="主题" className="settings-select" value={props.theme} onChange={props.setTheme} options={themeOptions} /></div>
      <div className="settings-row"><div><strong>{bridge ? "由桌面端通知" : "浏览器通知"}</strong><p>{bridge ? "通知由桌面应用发送，可在系统通知设置中管理。" : "标签页隐藏时提醒新待处理事项和 Run 完成，同 Run 30 秒内合并。"}{props.notificationPermission === "denied" ? "浏览器已拒绝权限，请在站点设置中修改。" : props.notificationPermission === "unsupported" ? "此浏览器不支持 Notification。" : ""}</p></div><Toggle label="浏览器通知" checked={props.notifications} disabled={Boolean(bridge) || props.notificationPermission === "unsupported"} onChange={props.toggleNotifications} /></div>
    </section>, { description: "外观与通知。偏好保存在此浏览器。", extra: saved });
    case "conversation": return page("会话显示", <section className="settings-card"><h2>会话显示</h2><SendShortcutSetting /><ReasoningControls settings /><AgentMessagePreference /></section>, { description: "设置消息发送快捷键、思考过程和 agent 消息卡片的显示方式。", single: true });
    case "policy": return page("Run 策略", <section className="settings-card"><h2>默认 Run 策略</h2>
      <div className="settings-row"><div><strong>组队后需要我确认</strong><p>agent 提交名单后，批准才会启动对应委派。</p></div><Toggle checked={policy.teamApproval !== false} onChange={teamApproval => setPolicy({ ...policy, teamApproval })} label="名单确认" /></div>
      <div className="settings-row"><div><strong>协作方式</strong><p>动态组队、预设团队或单独完成。</p></div><Select label="默认协作方式" className="settings-select" value={policy.mode ?? "dynamic"} onChange={mode => setPolicy({ ...policy, mode: mode === "solo" ? "solo" : mode === "preset" ? "preset" : "dynamic" })} options={collaborationOptions} /></div>
      <div className="settings-row"><div><strong>自动批准权限</strong><p>自动允许新 Run 中的权限请求，处理人记录为 policy。</p></div><Toggle checked={policy.autoApprove} onChange={autoApprove => setPolicy({ ...policy, autoApprove })} label="autoApprove" /></div>
      <div className="settings-row"><div><strong>最大委派深度</strong><p>根节点深度为 0。</p></div><input aria-label="最大委派深度" type="number" min="0" max="10" value={policy.maxDepth} onChange={event => setPolicy({ ...policy, maxDepth: Math.max(0, Math.min(10, Number(event.target.value))) })} /></div>
      <div className="settings-row"><div><strong>每个节点最大活跃子委派数</strong><p>限制同时并行的直接子任务。</p></div><input aria-label="最大活跃子委派数" type="number" min="1" max="30" value={policy.maxActiveChildren} onChange={event => setPolicy({ ...policy, maxActiveChildren: Math.max(1, Math.min(30, Number(event.target.value))) })} /></div>
      <div className="settings-row"><div><strong>费用预算 (USD)</strong><p>超过预算后不再接受新的委派。</p></div><input aria-label="费用预算" type="number" min="0" step="0.5" placeholder="不限" value={policy.budget?.maxCostUsd ?? ""} onChange={event => setPolicy({ ...policy, budget: event.target.value ? { maxCostUsd: Math.max(0, Number(event.target.value)) } : undefined })} /></div>
      <AdvancedPolicy policy={policy} change={patch => setPolicy({ ...policy, ...patch })} />
    </section>, { description: "新建 Run 时默认采用的协作方式与限制。", extra: saved, single: true });
    case "permissions": return page("权限规则", <PermissionRules rules={props.rules} agents={props.agents} runs={props.runs} busy={props.busy} create={props.createRule} remove={props.removeRule} />, { single: true });
    case "title": return page("标题模型", <TitleModelSettings client={props.client} />, { single: true });
    case "github": return page("GitHub", <GithubSettingsForm client={props.client} />, { single: true });
    case "updates": return page("更新", <UpdatesSettings />, { single: true });
    case "about": return page("关于", <>
      <section className="settings-card about-settings"><h2>连接</h2>
        <div className="settings-row"><div><strong>工作区</strong><p>{props.demo ? "浏览器内实时模拟，不连接任何服务端，数据只在这个页面里。" : "通过本机的 baton 守护进程驱动 agent，只监听 127.0.0.1。"}</p></div><span className="local-indicator"><i className={props.demo ? undefined : "is-live"} />{props.demo ? "Demo workspace" : "Local daemon"}</span></div>
        {!props.demo && <div className="settings-row"><div><strong>守护进程地址</strong><p>控制台通过这个地址访问 API 和事件流。</p></div><code className="about-value">{window.location.origin}</code></div>}
        <div className="settings-row"><div><strong>运行环境</strong><p>{bridge ? "桌面应用自带并管理守护进程。" : "在浏览器中打开的控制台。"}</p></div><span className="about-value">{bridge ? `桌面应用 · ${platformLabel(bridge.platform)}` : "浏览器"}</span></div>
      </section>
      <section className="settings-card about-settings"><h2>baton</h2>
        {bridge && <div className="settings-row"><div><strong>版本</strong></div><span className="about-value">{bridge.version}</span></div>}
        <div className="settings-row"><div><strong>源代码</strong><p>Apache-2.0</p></div><a className="about-value" href="https://github.com/DueGin/baton" target="_blank" rel="noreferrer">github.com/DueGin/baton</a></div>
      </section>
    </>, { description: "版本、连接与运行环境。" });
  }
}
