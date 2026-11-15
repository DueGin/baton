import { describe, expect, it } from "vitest";
import { readReasoningPreference, reasoningBlockId, reasoningOpen, reasoningPreferenceKey, ReasoningPreferences } from "./reasoning.js";
describe("reasoning display preference", () => {
  it("defaults to collapsed even during streaming and persists the three choices", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const preferences = new ReasoningPreferences(storage);
    expect(preferences.getSnapshot().preference).toBe("collapsed"); expect(reasoningOpen("collapsed", true)).toBe(false);
    for (const value of ["expanded", "streaming", "collapsed"] as const) {
      preferences.setPreference(value); expect(new ReasoningPreferences(storage).getSnapshot().preference).toBe(value);
      expect(values.get(reasoningPreferenceKey)).toBe(value);
    }
    expect(reasoningOpen("streaming", true)).toBe(true); expect(reasoningOpen("streaming", false)).toBe(false); expect(reasoningOpen("expanded", false)).toBe(true);
    values.set(reasoningPreferenceKey, "bad"); expect(readReasoningPreference(storage)).toBe("collapsed");
    expect(readReasoningPreference({ getItem: () => { throw new Error("denied"); } })).toBe("collapsed");
  });
  it("keeps explicit block choices across preferences and streaming changes for this page only", () => {
    const store = new ReasoningPreferences(); const key = reasoningBlockId("node-a", 2); let changes = 0; const unsubscribe = store.subscribe(() => changes++);
    store.setBlocks([key], true); store.setPreference("collapsed");
    expect(reasoningOpen(store.getSnapshot().preference, false, store.getSnapshot().overrides.get(key))).toBe(true);
    store.setBlocks([key, reasoningBlockId("node-a", 3)], false); store.setPreference("expanded");
    expect(reasoningOpen(store.getSnapshot().preference, true, store.getSnapshot().overrides.get(key))).toBe(false);
    expect(store.getSnapshot().overrides.get(reasoningBlockId("node-b", 2))).toBeUndefined();
    expect(new ReasoningPreferences().getSnapshot().overrides.size).toBe(0);
    expect(changes).toBe(4); unsubscribe();
  });
});
