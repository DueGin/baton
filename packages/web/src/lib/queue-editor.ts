import { isSendKey, type SendShortcut, type ShortcutEvent } from "./send-shortcut.js";

export function queueEditError(text: string): string | undefined { return text.trim() ? undefined : "消息不能为空"; }
export function queueEditKey(event: ShortcutEvent, shortcut: SendShortcut): "save" | "cancel" | undefined {
  if (event.isComposing || event.keyCode === 229) return undefined;
  if (event.key === "Escape") return "cancel";
  if (isSendKey(event, shortcut)) return "save";
  return undefined;
}
