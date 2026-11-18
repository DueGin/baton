/** Optional native capabilities. Ordinary browsers keep their existing behavior. */
export interface BatonDesktopBridge {
  platform: "darwin" | "win32" | "linux";
  version: string;
  pickDirectory(options?: { defaultPath?: string; title?: string }): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  setBadgeCount(count: number): void;
  /** Absent in desktop builds before the frameless window. */
  setWindowChrome?(chrome: WindowChrome): void;
  /** In-app updates (DESIGN §4.15). Absent in desktop builds before the updater and in browsers. */
  updates?: {
    status(): Promise<UpdateStatus | null>;
    check(): Promise<UpdateStatus | null>;
    download(): Promise<UpdateStatus | null>;
    install(): Promise<UpdateStatus | null>;
    setToken(token: string): Promise<{ saved: boolean }>;
    reveal(): Promise<void>;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
  };
}
export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "downloaded" | "installing" | "error";
export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  release?: { version: string; notes: string; pageUrl: string; publishedAt: string; asset: { name: string; size: number } };
  /** 0–1 while downloading. */
  progress?: number;
  received?: number;
  total?: number;
  error?: string;
  needsToken?: boolean;
  savedPath?: string;
  checkedAt?: string;
}
export interface WindowChrome { theme: "system" | "light" | "dark"; background: string; foreground: string }
declare global { interface Window { batonDesktop?: BatonDesktopBridge } }
export function desktopBridge(): BatonDesktopBridge | undefined { return typeof window === "undefined" ? undefined : window.batonDesktop; }

/**
 * The desktop window has no native title bar (DESIGN §4.12). `data-desktop` on <html> lets the stylesheet keep the top
 * strip for dragging, the macOS traffic lights and the Windows window controls.
 */
export function installDesktopChrome(): void { const bridge = desktopBridge(); if (bridge) document.documentElement.dataset.desktop = bridge.platform; }
/** "rgb(24, 24, 24)" → "#181818"; transparent colours give null. */
export function cssColorHex(value: string): string | null {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/u.exec(value.trim());
  if (!match || (match[4] !== undefined && Number(match[4]) === 0)) return null;
  return `#${match.slice(1, 4).map(channel => Math.min(255, Number(channel)).toString(16).padStart(2, "0")).join("")}`;
}
/** What the native window controls sit on: the first painted background under the top-right corner, and the text colour. */
export function windowChrome(theme: string): WindowChrome | null {
  let background: string | null = null;
  for (const element of document.elementsFromPoint(Math.max(0, window.innerWidth - 70), 20)) { background = cssColorHex(getComputedStyle(element).backgroundColor); if (background) break; }
  const foreground = cssColorHex(getComputedStyle(document.documentElement).color);
  background ??= cssColorHex(getComputedStyle(document.body).backgroundColor) ?? cssColorHex(getComputedStyle(document.documentElement).backgroundColor);
  if (!background || !foreground) return null;
  return { theme: theme === "light" || theme === "dark" ? theme : "system", background, foreground };
}

/** Covers Markdown, PR links, and localhost ports, including dynamically inserted anchors. */
export function installDesktopLinks(): void {
  const bridge = desktopBridge(); if (!bridge) return;
  const open = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]"); if (!anchor || anchor.hasAttribute("download")) return;
    let url: URL; try { url = new URL(anchor.href); } catch { return; }
    if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.origin === window.location.origin) return;
    if (event.type === "auxclick" && event.button !== 1) return;
    event.preventDefault(); event.stopPropagation();
    void bridge.openExternal(url.href).catch((error: unknown) => console.error("无法打开外部链接", error));
  };
  document.addEventListener("click", open, true); document.addEventListener("auxclick", open, true);
}

export function desktopRoute(pathname: string, search: string): { page: "inbox" } | { page: "runs"; runId: string; nodeId?: string } | null {
  if (pathname === "/inbox") return { page: "inbox" };
  const match = /^\/runs\/([a-zA-Z0-9_-]+)$/u.exec(pathname); if (!match?.[1]) return null;
  const node = new URLSearchParams(search).get("node");
  return { page: "runs", runId: match[1], ...(node && /^[a-zA-Z0-9_-]+$/u.test(node) ? { nodeId: node } : {}) };
}
