export const panelWidthKey = "baton.rightPanelWidth";
export const panelDefaultWidth = 320;
export function panelMaxWidth(viewport: number): number { return Math.max(0, Math.min(720, Math.floor(viewport * .6))); }
export function clampPanelWidth(width: number, viewport: number): number {
  const max = panelMaxWidth(viewport); const min = Math.min(280, max);
  return Math.round(Math.max(min, Math.min(max, Number.isFinite(width) ? width : panelDefaultWidth)));
}
export function readPanelWidth(storage: Pick<Storage, "getItem">): number {
  try { const value = storage.getItem(panelWidthKey); const width = value === null ? panelDefaultWidth : Number(value); return Math.max(280, Math.min(720, Number.isFinite(width) ? width : panelDefaultWidth)); } catch { return panelDefaultWidth; }
}
export function savePanelWidth(storage: Pick<Storage, "setItem">, width: number): void { try { storage.setItem(panelWidthKey, String(Math.max(280, Math.min(720, Number.isFinite(width) ? width : panelDefaultWidth)))); } catch { /* Storage may be disabled. */ } }
