import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BatonClient } from "../api.js";
import { readSettingsSection, saveSettingsSection, SettingsContent, SettingsSidebar, settingsGroups, type SettingsContentProps } from "./Settings.js";
import { Sidebar } from "./Sidebar.js";

const noop = (): undefined => undefined;
const memory = (initial: Record<string, string> = {}) => { const values = new Map(Object.entries(initial)); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
const content = (patch: Partial<SettingsContentProps>): SettingsContentProps => ({
  section: "general", client: {} as BatonClient, demo: true, theme: "light", setTheme: noop, notifications: false, notificationPermission: "default", toggleNotifications: noop,
  policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false }, setPolicy: noop, agents: [], refreshing: false, refreshAgents: noop,
  runs: [], rules: [], busy: false, createRule: async () => true, removeRule: noop, ...patch,
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("settings navigation", () => {
  it("remembers the chosen category and falls back to 通用", () => {
    const storage = memory();
    expect(readSettingsSection(storage)).toBe("general");
    saveSettingsSection(storage, "github");
    expect(readSettingsSection(storage)).toBe("github");
    expect(readSettingsSection(memory({ "baton.settingsSection": "agents-old" }))).toBe("general");
  });
  it("lists every category in the sidebar, marks the current one and offers a way back to the conversation", () => {
    const html = renderToStaticMarkup(<SettingsSidebar section="permissions" select={noop} back={noop} />);
    expect(html).toContain('aria-label="返回对话"');
    for (const item of settingsGroups.flatMap(group => group.items)) expect(html).toContain(`title="${item.label}"`);
    expect(html).toMatch(/aria-current="page"[^>]*title="权限规则"/u);
    expect(html.match(/aria-current="page"/gu)).toHaveLength(1);
    // Icons are decorative, so a category's accessible name is just its label (the GitHub mark has its own label).
    expect(html).toContain('<span class="settings-nav-icon" aria-hidden="true">');
  });
  it("shows the workspace connection under 关于", () => {
    expect(renderToStaticMarkup(<SettingsContent {...content({ section: "about", demo: true })} />)).toContain("Demo workspace");
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:7433" } });
    const live = renderToStaticMarkup(<SettingsContent {...content({ section: "about", demo: false })} />);
    expect(live).toContain("Local daemon"); expect(live).toContain("http://127.0.0.1:7433"); expect(live).toContain('class="is-live"');
  });
  it("renders one category per page; single-card pages are marked so the card title is not repeated", () => {
    const general = renderToStaticMarkup(<SettingsContent {...content({ section: "general" })} />);
    expect(general).toContain("<h1>通用</h1>"); expect(general).toContain("外观"); expect(general).not.toContain("默认 Run 策略");
    const policy = renderToStaticMarkup(<SettingsContent {...content({ section: "policy" })} />);
    expect(policy).toContain("settings-page settings-section-policy single"); expect(policy).toContain("<h1>Run 策略</h1>"); expect(policy).toContain("最大委派深度");
  });
});

describe("workspace sidebar footer", () => {
  it("puts settings, teams and the inbox bottom-left as icon buttons, with the inbox count as a badge", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: noop, removeEventListener: noop }));
    vi.stubGlobal("localStorage", memory());
    const html = renderToStaticMarkup(<Sidebar runs={[]} runId={null} page="inbox" navigate={noop} selectRun={noop} newRun={noop} canCreate pendingCount={8} presetCount={2} theme="light" toggleTheme={noop} loading={false} projects={[]} currentProjectId={null} reveal={null} selectProject={noop} addProject={noop} mutateProject={async () => undefined} />);
    const footer = html.slice(html.indexOf('class="sidebar-footer"'), html.indexOf('class="sidebar-resizer"'));
    const labels = [...footer.matchAll(/aria-label="([^"]+)"/gu)].map(match => match[1]);
    expect(labels).toEqual(["设置", "团队", "待处理 8", "切换为深色"]);
    expect(footer).toContain('<span class="nav-badge">8</span>');
    expect(footer).toMatch(/aria-current="page"[^>]*><svg/u);
    expect(footer).not.toContain("sidebar-label");
    // Nothing above the project list links to the inbox any more, and the connection label moved into settings.
    expect(html.slice(0, html.indexOf('class="sidebar-footer"'))).not.toContain("待处理");
    expect(html).not.toContain("Local daemon"); expect(html).not.toContain("Demo workspace");
  });
});
