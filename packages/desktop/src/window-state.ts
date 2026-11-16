export interface Bounds { x: number; y: number; width: number; height: number }
export interface WindowState { width: number; height: number; x?: number; y?: number; maximized: boolean }
export function windowState(value: unknown, displays: Bounds[]): WindowState {
  const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const width = typeof saved.width === "number" && Number.isFinite(saved.width) ? Math.max(800, Math.min(3840, saved.width)) : 1320;
  const height = typeof saved.height === "number" && Number.isFinite(saved.height) ? Math.max(600, Math.min(2160, saved.height)) : 900;
  const x = saved.x, y = saved.y;
  const visible = typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y) && displays.some(display => Math.min(x + width, display.x + display.width) - Math.max(x, display.x) >= 80 && Math.min(y + height, display.y + display.height) - Math.max(y, display.y) >= 80);
  return { width, height, ...(visible ? { x: x as number, y: y as number } : {}), maximized: saved.maximized === true };
}
