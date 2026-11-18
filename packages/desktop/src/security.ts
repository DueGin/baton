import { isAbsolute } from "node:path";

export function externalUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Invalid URL");
  const url = new URL(value);
  if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.username || url.password) throw new Error("URL scheme is not allowed");
  return url.href;
}

export function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 32_768 || value.includes("\0") || !isAbsolute(value)) throw new Error("An absolute path is required");
  return value;
}

export function directoryOptions(value: unknown): { defaultPath?: string; title?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid directory options");
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some(key => key !== "title" && key !== "defaultPath")) throw new Error("Unknown directory option");
  if (options.title !== undefined && (typeof options.title !== "string" || options.title.length > 200 || options.title.includes("\0"))) throw new Error("Invalid title");
  return { ...(options.defaultPath === undefined ? {} : { defaultPath: absolutePath(options.defaultPath) }), ...(options.title === undefined ? {} : { title: options.title as string }) };
}

/** Routes are data from the daemon, never arbitrary navigation targets or script. */
export function notificationRoute(value: unknown): string | null {
  if (value === "/inbox") return value;
  if (typeof value !== "string" || !/^\/runs\/[a-zA-Z0-9_-]+(?:\?node=[a-zA-Z0-9_-]+)?$/u.test(value)) return null;
  return value;
}

export function badgeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid badge count");
  return Math.min(9999, value);
}

export type WindowTheme = "system" | "light" | "dark";
export interface WindowChrome { theme: WindowTheme; background: string; foreground: string }
const hexColor = /^#[0-9a-f]{6}$/iu;
/** The console's theme choice and the colours behind the window controls (DESIGN §4.12). */
export function windowChrome(value: unknown): WindowChrome {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid window chrome");
  const { theme, background, foreground, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || (theme !== "system" && theme !== "light" && theme !== "dark") || typeof background !== "string" || !hexColor.test(background) || typeof foreground !== "string" || !hexColor.test(foreground)) throw new Error("Invalid window chrome");
  return { theme, background: background.toLowerCase(), foreground: foreground.toLowerCase() };
}
