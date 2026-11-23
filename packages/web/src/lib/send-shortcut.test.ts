import { describe, expect, it, vi } from "vitest";
import { isSendKey, shortcutLabel, SendShortcutPreferences } from "./send-shortcut.js";

const enter = { key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, keyCode: 13 };

describe("send shortcut", () => {
  it("only matches the selected chord, leaving unmodified or shifted newlines to the editor", () => {
    expect(isSendKey(enter, "enter", false)).toBe(true);
    expect(isSendKey(enter, "mod-enter", false)).toBe(false);
    expect(isSendKey({ ...enter, ctrlKey: true }, "mod-enter", false)).toBe(true);
    expect(isSendKey({ ...enter, metaKey: true }, "mod-enter", true)).toBe(true);
    expect(isSendKey({ ...enter, metaKey: true }, "mod-enter", false)).toBe(false);
    expect(isSendKey({ ...enter, ctrlKey: true }, "enter", false)).toBe(false);
    for (const preference of ["enter", "mod-enter"] as const) {
      const key = { ...enter, ctrlKey: preference === "mod-enter" };
      for (const extra of [{ shiftKey: true }, { altKey: true }, { key: "Tab" }, { isComposing: true }, { keyCode: 229 }]) {
        expect(isSendKey({ ...key, ...extra }, preference, false)).toBe(false);
      }
    }
  });
  it("labels the shortcut for the current platform", () => {
    expect(shortcutLabel("enter", true)).toBe("Enter");
    expect(shortcutLabel("mod-enter", true)).toBe("⌘ Enter");
    expect(shortcutLabel("mod-enter", false)).toBe("Ctrl Enter");
  });
  it("defaults safely and makes changes observable immediately and after reload", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const prefs = new SendShortcutPreferences(storage), notify = vi.fn(); const unsubscribe = prefs.subscribe(notify);
    expect(prefs.getSnapshot()).toBe("mod-enter"); prefs.set("enter");
    expect(notify).toHaveBeenCalledOnce(); expect(prefs.getSnapshot()).toBe("enter");
    expect(new SendShortcutPreferences(storage).getSnapshot()).toBe("enter");
    unsubscribe(); prefs.set("mod-enter"); expect(notify).toHaveBeenCalledOnce();
    values.set("baton.sendShortcut", "bogus"); expect(new SendShortcutPreferences(storage).getSnapshot()).toBe("mod-enter");
  });
});
