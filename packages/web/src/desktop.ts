/** Optional native capabilities. Ordinary browsers keep their existing behavior. */
export interface BatonDesktopBridge {
  platform: "darwin" | "win32" | "linux";
  version: string;
  pickDirectory(options?: { defaultPath?: string; title?: string }): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  setBadgeCount(count: number): void;
}
declare global { interface Window { batonDesktop?: BatonDesktopBridge } }
export function desktopBridge(): BatonDesktopBridge | undefined { return typeof window === "undefined" ? undefined : window.batonDesktop; }

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
