import { useSyncExternalStore } from "react";

export type SendShortcut = "enter" | "mod-enter";
const storageKey = "baton.sendShortcut";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

export class SendShortcutPreferences {
  private value: SendShortcut = "mod-enter";
  private listeners = new Set<() => void>();
  constructor(private storage?: StorageAccess) {
    try { if (storage?.getItem(storageKey) === "enter") this.value = "enter"; } catch { /* Storage unavailable. */ }
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(value: SendShortcut): void {
    try { this.storage?.setItem(storageKey, value); } catch { /* Keep the preference for this page. */ }
    this.sync(value);
  }
  sync(value: string | null): void {
    const next = value === "enter" ? "enter" : "mod-enter";
    if (next === this.value) return;
    this.value = next; this.listeners.forEach(listener => listener());
  }
}

function browserStorage(): Storage | undefined { try { return globalThis.localStorage; } catch { return undefined; } }
export const sendShortcuts = new SendShortcutPreferences(browserStorage());
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.storageArea === browserStorage() && (event.key === storageKey || event.key === null)) sendShortcuts.sync(event.newValue);
});
export const useSendShortcut = () => useSyncExternalStore(sendShortcuts.subscribe, sendShortcuts.getSnapshot, sendShortcuts.getSnapshot);

const appleKeyboard = () => /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.platform ?? "");
export function shortcutLabel(value: SendShortcut, apple = appleKeyboard()): string {
  return value === "enter" ? "Enter" : apple ? "⌘ Enter" : "Ctrl Enter";
}
export type ShortcutEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">;
export function isSendKey(event: ShortcutEvent, value: SendShortcut, apple = appleKeyboard()): boolean {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey) return false;
  if (value === "enter") return !event.ctrlKey && !event.metaKey;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
