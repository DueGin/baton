import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray, type BrowserWindowConstructorOptions, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type NativeImage } from "electron";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonManager, type DaemonConnection } from "./daemon.js";
import { parseNotification, subscribe } from "./events.js";
import { loginShellEnv } from "./shell-env.js";
import { absolutePath, badgeCount, directoryOptions, externalUrl, notificationRoute, windowChrome, type WindowChrome } from "./security.js";
import { settingsPathFor, UpdateManager } from "./updater.js";
import { windowState } from "./window-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const home = resolve(process.env.BATON_HOME ?? join(homedir(), ".baton"));
// The smoke runner must isolate Chromium storage as well as daemon storage.
if (process.env.BATON_DESKTOP_USER_DATA) app.setPath("userData", resolve(process.env.BATON_DESKTOP_USER_DATA));
app.setName("baton");
if (process.platform === "win32") app.setAppUserModelId("dev.baton.app");
const smoke = process.env.BATON_DESKTOP_SMOKE === "1";
let window: BrowserWindow | null = null;
let tray: Tray | undefined;
let manager: DaemonManager;
let updater: UpdateManager;
let connection: DaemonConnection;
let streams: AbortController | undefined;
let quitting = false, checkingQuit = false;
let badge = 0;
let consoleOrigin = "";
const notifications = new Set<Notification>();
const seenNotices = new Set<string>();
const iconPath = join(app.isPackaged ? process.resourcesPath : resolve(here, ".."), "assets", "icon.png");
// No native title bar (DESIGN §4.12): the console draws to the top edge and reserves a strip this tall — its run bar's
// height — for dragging, the macOS traffic lights (top left) and the Windows window controls overlay (top right).
const TITLE_BAR_HEIGHT = 44;
/** Until the console reports its theme and colours: the last ones it reported, else the system appearance. */
let chrome: WindowChrome | undefined;
const fallbackChrome = (): Omit<WindowChrome, "theme"> => nativeTheme.shouldUseDarkColors ? { background: "#0f0f0f", foreground: "#e8e8e8" } : { background: "#f7f7f7", foreground: "#1a1a1a" };
function frameOptions(colors: Omit<WindowChrome, "theme">): BrowserWindowConstructorOptions {
  if (process.platform === "darwin") return { titleBarStyle: "hidden", trafficLightPosition: { x: 18, y: 15 } };
  if (process.platform === "win32") return { titleBarStyle: "hidden", titleBarOverlay: { color: colors.background, symbolColor: colors.foreground, height: TITLE_BAR_HEIGHT } };
  return {};
}
function applyChrome(next: WindowChrome): void {
  chrome = next; nativeTheme.themeSource = next.theme;
  if (!window || window.isDestroyed()) return;
  window.setBackgroundColor(next.background);
  if (process.platform === "win32") window.setTitleBarOverlay({ color: next.background, symbolColor: next.foreground, height: TITLE_BAR_HEIGHT });
}

function consoleUrl(route = "/"): string {
  const url = new URL(route, consoleOrigin);
  url.hash = new URLSearchParams({ token: connection.token }).toString();
  return url.href;
}
function isConsoleUrl(value: string): boolean { try { return new URL(value).origin === consoleOrigin; } catch { return false; } }
async function openExternal(value: unknown): Promise<void> { await shell.openExternal(externalUrl(value)); }
function authorize(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isConsoleUrl(event.senderFrame.url)) throw new Error("Untrusted desktop IPC sender");
}

/** Small readable count bitmap; avoids a native canvas dependency for Windows overlays. */
function overlayIcon(count: number): NativeImage {
  const size = 32, pixels = Buffer.alloc(size * size * 4);
  const set = (x: number, y: number, r: number, g: number, b: number) => { const offset = (y * size + x) * 4; pixels[offset] = b; pixels[offset + 1] = g; pixels[offset + 2] = r; pixels[offset + 3] = 255; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if ((x - 15.5) ** 2 + (y - 15.5) ** 2 < 15 ** 2) set(x, y, 206, 58, 70);
  const digits = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"];
  const text = String(Math.min(count, 99)), scale = text.length > 1 ? 3 : 4, width = text.length * 4 * scale - scale;
  for (const [index, char] of [...text].entries()) for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (digits[Number(char)]?.[y * 3 + x] === "1") for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) set(Math.floor((size - width) / 2) + index * 4 * scale + x * scale + xx, Math.floor((size - 5 * scale) / 2) + y * scale + yy, 255, 255, 255);
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}
function setBadge(value: unknown): void {
  badge = badgeCount(value);
  if (process.platform === "darwin") app.setBadgeCount(badge);
  if (process.platform === "win32") window?.setOverlayIcon(badge ? overlayIcon(badge) : null, badge ? `${badge} 个待处理事项` : "没有待处理事项");
  tray?.setToolTip(`baton${badge ? ` · ${badge} 个待处理事项` : ""}`);
}

async function showWindow(route?: string): Promise<BrowserWindow> {
  if (!window || window.isDestroyed()) {
    let saved: unknown;
    try { saved = JSON.parse(await readFile(join(app.getPath("userData"), "window-state.json"), "utf8")) as unknown; } catch { /* First launch. */ }
    const state = windowState(saved, screen.getAllDisplays().map(display => display.workArea));
    if (!chrome) { try { applyChrome(windowChrome((saved as { chrome?: unknown } | undefined)?.chrome)); } catch { /* First launch or an older state file. */ } }
    const colors = chrome ?? fallbackChrome();
    const current = new BrowserWindow({ ...state, minWidth: 800, minHeight: 600, title: "baton", show: false, backgroundColor: colors.background, icon: iconPath, ...frameOptions(colors),
      webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, additionalArguments: [`--baton-version=${app.getVersion()}`] },
    });
    window = current;
    current.removeMenu(); // Global application menu is installed below; Windows uses its window menu.
    if (process.platform !== "darwin") current.setMenu(Menu.getApplicationMenu());
    current.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url).catch(() => undefined); return { action: "deny" }; });
    current.webContents.on("will-navigate", (event, url) => { if (!isConsoleUrl(url)) { event.preventDefault(); void openExternal(url).catch(() => undefined); } });
    current.webContents.on("will-frame-navigate", event => { if (!isConsoleUrl(event.url)) event.preventDefault(); });
    current.webContents.on("will-redirect", (event, url) => { if (!isConsoleUrl(url)) event.preventDefault(); });
    current.webContents.on("will-attach-webview", event => event.preventDefault());
    current.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    current.webContents.session.setPermissionCheckHandler(() => false);
    current.webContents.on("render-process-gone", () => { if (!quitting) void current.loadURL(consoleUrl()); });
    current.once("ready-to-show", () => { if (!smoke) current.show(); });
    // macOS hides the traffic lights in full screen; the console then drops the space it keeps for them.
    const fullScreen = () => { if (!current.isDestroyed()) current.webContents.send("baton:fullscreen", current.isFullScreen()); };
    current.on("enter-full-screen", fullScreen); current.on("leave-full-screen", fullScreen); current.webContents.on("did-finish-load", fullScreen);
    current.on("close", () => {
      const bounds = current.getNormalBounds();
      const saved = JSON.stringify({ ...bounds, maximized: current.isMaximized(), ...(chrome ? { chrome } : {}) });
      void mkdir(app.getPath("userData"), { recursive: true }).then(() => writeFile(join(app.getPath("userData"), "window-state.json"), saved)).catch(console.error);
    });
    current.on("closed", () => { if (window === current) window = null; });
    if (state.maximized) current.maximize();
    await current.loadURL(consoleUrl(route));
    setBadge(badge);
  } else if (route) await window.loadURL(consoleUrl(route));
  if (!smoke) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  return window;
}

function setupMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ label: "baton", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { label: "退出 baton", accelerator: "Cmd+Q", click: () => app.quit() }] } as MenuItemConstructorOptions] : [{ label: "文件", submenu: [{ label: "打开 baton", click: () => { void showWindow(); } }, { role: "close" }, { type: "separator" }, { label: "退出", accelerator: "Ctrl+Q", click: () => app.quit() }] } as MenuItemConstructorOptions]),
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "视图", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { label: "显示 baton", click: () => { void showWindow(); } }, ...(process.platform === "darwin" ? [{ role: "front" } as MenuItemConstructorOptions] : [])] },
    { role: "help", label: "帮助", submenu: [{ label: "关于 baton", click: () => { void dialog.showMessageBox({ type: "info", title: "baton", message: `baton ${app.getVersion()}`, detail: `本地 agent 客户端\n数据目录：${home}\n${connection?.url ?? "正在连接…"}` }); } }, { label: "打开数据目录", click: () => { void shell.openPath(home); } }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (process.platform === "darwin") app.dock?.setMenu(Menu.buildFromTemplate([{ label: "打开 baton", click: () => { void showWindow(); } }]));
}

function setupIpc(): void {
  ipcMain.handle("baton:pick-directory", async (event, input: unknown) => {
    authorize(event); const options = directoryOptions(input);
    const result = await dialog.showOpenDialog(window!, { ...options, title: options.title ?? "选择项目文件夹", properties: ["openDirectory", "createDirectory"] });
    return result.canceled || !result.filePaths[0] ? null : absolutePath(result.filePaths[0]);
  });
  ipcMain.handle("baton:open-external", async (event, input: unknown) => { authorize(event); await openExternal(input); });
  ipcMain.handle("baton:show-item", (event, input: unknown) => { authorize(event); shell.showItemInFolder(absolutePath(input)); });
  ipcMain.on("baton:badge", (event, input: unknown) => { try { authorize(event); setBadge(input); } catch { /* Reject malformed fire-and-forget IPC. */ } });
  ipcMain.on("baton:window-chrome", (event, input: unknown) => { try { authorize(event); applyChrome(windowChrome(input)); } catch { /* Reject malformed fire-and-forget IPC. */ } });
  // In-app updates (DESIGN §4.15). Install hands over to the normal quit path so active runs are still confirmed.
  ipcMain.handle("baton:update-status", (event) => { authorize(event); return updater?.get() ?? null; });
  ipcMain.handle("baton:update-check", async (event) => { authorize(event); return updater?.check() ?? null; });
  ipcMain.handle("baton:update-download", async (event) => { authorize(event); return updater?.download() ?? null; });
  ipcMain.handle("baton:update-install", async (event) => { authorize(event); const status = await updater?.install(); if (updater?.get().phase === "installing") void quit(); return status ?? null; });
  ipcMain.handle("baton:update-token", async (event, input: unknown) => { authorize(event); return updater?.setToken(input) ?? { saved: false }; });
  ipcMain.handle("baton:update-reveal", (event) => { authorize(event); updater?.reveal(); });
}

function connectEvents(current: DaemonConnection): void {
  streams?.abort(); const controller = new AbortController(); streams = controller;
  let refreshing = false, refreshAgain = false;
  const refresh = async () => {
    if (refreshing) { refreshAgain = true; return; } refreshing = true;
    try {
      const response = await fetch(`${current.url}/api/inbox`, { headers: { authorization: `Bearer ${current.token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      const inbox: unknown = await response.json(); if (response.ok && Array.isArray(inbox) && !controller.signal.aborted) setBadge(inbox.length);
    } catch { /* Retried on the next event and periodic refresh. */ }
    finally { refreshing = false; if (refreshAgain) { refreshAgain = false; void refresh(); } }
  };
  void refresh();
  const timer = setInterval(() => { void refresh(); }, 30_000); controller.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  subscribe(current, "/api/inbox/events", () => { void refresh(); }, controller.signal);
  subscribe(current, "/api/notifications/events", (event, data) => {
    if (event !== "notification") return;
    const notice = parseNotification(data); if (!notice || seenNotices.has(notice.id)) return;
    seenNotices.add(notice.id); if (seenNotices.size > 1000) seenNotices.delete(seenNotices.values().next().value!);
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: notice.title, body: notice.body, icon: iconPath });
    notifications.add(notification);
    notification.on("click", () => { void showWindow(notificationRoute(notice.route) ?? "/inbox"); });
    notification.once("close", () => notifications.delete(notification));
    notification.show();
  }, controller.signal);
}

async function quit(): Promise<void> {
  if (checkingQuit) return; checkingQuit = true;
  try {
    let active: number | null = null;
    try { active = await manager?.activeRuns() ?? 0; } catch { /* Ask conservatively when daemon is unavailable. */ }
    if (!smoke && active !== 0) {
      const answer = await dialog.showMessageBox({ type: "question", title: "退出 baton", message: active === null ? "暂时无法确认是否有活跃会话，仍然退出？" : `还有 ${active} 个活跃会话，退出 baton？`, detail: manager?.owned ? "退出会停止此应用启动的 daemon 和 agent。关闭窗口可让任务继续在后台运行。" : "daemon 由外部启动，退出桌面端后会话继续运行。", buttons: ["继续运行", "退出 baton"], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return;
    }
    quitting = true; streams?.abort(); for (const notice of notifications) notice.close();
    await manager?.stop(); tray?.destroy(); app.quit();
  } finally { checkingQuit = false; }
}

async function smokeCheck(current: BrowserWindow): Promise<void> {
  const response = await fetch(`${connection.url}/api/info`, { headers: { authorization: `Bearer ${connection.token}` } });
  const info = await response.json() as { name?: string; home?: string };
  if (!response.ok || info.name !== "baton" || info.home !== home) throw new Error("Smoke: daemon info mismatch");
  // Wait for React to render and finish its initial API requests; never run this in normal app mode.
  const renderer: unknown = await current.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const check = () => {
      const root = document.getElementById('root');
      if (root?.textContent?.includes('添加项目')) resolve({ bridge: Object.keys(window.batonDesktop || {}).sort(), text: root.textContent.slice(0, 400), nodeExposed: typeof require !== 'undefined', demo: root.textContent.includes('DEMO'), version: window.batonDesktop?.version });
      else if (Date.now() > deadline) reject(new Error('Console did not render'));
      else setTimeout(check, 100);
    }; check();
  })`);
  if (!renderer || typeof renderer !== "object") throw new Error("Smoke: no renderer result");
  const result = renderer as Record<string, unknown>;
  if (result.nodeExposed || result.demo || JSON.stringify(result.bridge) !== JSON.stringify(["openExternal", "pickDirectory", "platform", "setBadgeCount", "setWindowChrome", "showItemInFolder", "updates", "version"])) throw new Error(`Smoke: invalid renderer ${JSON.stringify(result)}`);
  const rejected: unknown = await current.webContents.executeJavaScript(`window.batonDesktop.openExternal('javascript:alert(1)').then(() => false, () => true)`);
  if (rejected !== true) throw new Error("Smoke: IPC URL allowlist failed");
  // Exercise the real IPC + React + POST flow while replacing only the OS dialog interaction.
  const pickedPath = await realpath(home);
  const originalPicker = dialog.showOpenDialog;
  let pickerCalls = 0;
  dialog.showOpenDialog = async () => { pickerCalls++; return { canceled: false, filePaths: [pickedPath] }; };
  let project: unknown;
  try {
    project = await current.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '添加项目');
      if (!button) { reject(new Error('Missing Add Project')); return; }
      button.click();
      const deadline = Date.now() + 10000;
      const check = async () => {
        const response = await fetch('/api/projects', { headers: { authorization: 'Bearer ' + sessionStorage.getItem('baton.token') } });
        const projects = await response.json();
        const selected = Array.isArray(projects) ? projects.find(project => project.path === ${JSON.stringify(pickedPath)}) : null;
        if (selected) resolve(selected);
        else if (Date.now() > deadline) reject(new Error('Picker did not register project'));
        else setTimeout(check, 100);
      }; check();
    })`);
  } finally { dialog.showOpenDialog = originalPicker; }
  if (!project || typeof project !== "object" || (project as Record<string, unknown>).path !== pickedPath || (project as Record<string, unknown>).name !== basename(pickedPath) || pickerCalls !== 1) throw new Error(`Smoke: invalid native project flow ${JSON.stringify(project)}`);
  await showWindow("/inbox");
  current.close();
  const afterClose = await fetch(`${connection.url}/api/info`, { headers: { authorization: `Bearer ${connection.token}` } });
  if (!afterClose.ok) throw new Error("Smoke: closing the window stopped the daemon");
  const reopened = await showWindow("/inbox");
  const report = { ok: true, daemon: { url: connection.url, home, owned: manager.owned }, renderer, ipcAllowlist: true, nativeProjectFlow: { pickerCalls, project }, closeWindowKeptDaemon: true, route: new URL(reopened.webContents.getURL()).pathname };
  if (process.env.BATON_DESKTOP_SMOKE_REPORT) await writeFile(process.env.BATON_DESKTOP_SMOKE_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (connection) void showWindow(); });
  app.on("activate", () => { if (connection) void showWindow(); });
  app.on("window-all-closed", () => { /* Dock/tray stays available; tasks keep running. */ });
  app.on("before-quit", event => { if (!quitting) { event.preventDefault(); void quit(); } });
  void app.whenReady().then(async () => {
    setupMenu(); setupIpc();
    if (process.platform === "win32") {
      tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 }));
      tray.setToolTip("baton"); tray.on("double-click", () => { void showWindow(); });
      tray.setContextMenu(Menu.buildFromTemplate([{ label: "打开 baton", click: () => { void showWindow(); } }, { type: "separator" }, { label: "退出 baton", click: () => app.quit() }]));
    }
    const env = await loginShellEnv(process.env);
    updater = new UpdateManager(() => window, { env, settingsPath: settingsPathFor(app.getPath("userData")), quitForUpdate: () => { void quit(); } });
    manager = new DaemonManager({ home, executable: process.execPath, entry: app.isPackaged ? join(process.resourcesPath, "runtime", "packages", "server", "dist", "cli", "main.js") : resolve(here, "../../server/dist/cli/main.js"), env,
      connected: current => {
        const reconnecting = Boolean(connection); connection = current;
        const devUrl = !app.isPackaged ? process.env.BATON_DESKTOP_WEB_URL : undefined;
        if (devUrl) { const url = new URL(devUrl); if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Development web URL must be a loopback HTTP URL"); consoleOrigin = url.origin; }
        else consoleOrigin = current.url;
        connectEvents(current);
        if (reconnecting && window) void window.loadURL(consoleUrl());
      },
      failed: error => { console.error(error); window?.setTitle("baton — 正在重新连接…"); },
    });
    await manager.start(); const current = await showWindow();
    if (smoke) await smokeCheck(current);
  }).catch(async (error: unknown) => {
    console.error(error);
    if (!smoke) await dialog.showMessageBox({ type: "error", title: "baton 启动失败", message: error instanceof Error ? error.message : String(error), detail: `日志：${join(home, "desktop-daemon.log")}` });
    quitting = true; streams?.abort(); await manager?.stop(); app.exit(1);
  });
}
