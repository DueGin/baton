export const sidebarDefaultWidth = 260;
export const sidebarMinWidth = 200;
export const sidebarMaxWidth = 440;
export interface SidebarPreference { width: number; collapsed: boolean }
export function clampSidebarWidth(width: number): number { return Number.isFinite(width) ? Math.round(Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth, width))) : sidebarDefaultWidth; }
export function readSidebar(storage: Pick<Storage, "getItem">, narrow: boolean): SidebarPreference {
  try {
    const width = storage.getItem("baton.sidebarWidth"); const collapsed = storage.getItem("baton.sidebarCollapsed");
    return { width: width === null ? sidebarDefaultWidth : clampSidebarWidth(Number(width)), collapsed: collapsed === null ? narrow : collapsed === "true" };
  } catch { return { width: sidebarDefaultWidth, collapsed: narrow }; }
}
export function saveSidebar(storage: Pick<Storage, "setItem">, value: SidebarPreference): void {
  try { storage.setItem("baton.sidebarWidth", String(clampSidebarWidth(value.width))); storage.setItem("baton.sidebarCollapsed", String(value.collapsed)); } catch { /* Storage can be disabled. */ }
}
export function readSidebarUnreadOnly(storage: Pick<Storage, "getItem">): boolean {
  try { return storage.getItem("baton.sidebarUnreadOnly") === "true"; } catch { return false; }
}
export function saveSidebarUnreadOnly(storage: Pick<Storage, "setItem">, unreadOnly: boolean): void {
  try { storage.setItem("baton.sidebarUnreadOnly", String(unreadOnly)); } catch {}
}
export function sidebarKeyWidth(width: number, key: string, shift = false): number {
  return key === "Home" ? sidebarMinWidth : key === "End" ? sidebarMaxWidth : clampSidebarWidth(width + (key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0) * (shift ? 40 : 10));
}
