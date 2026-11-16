import { describe, expect, it } from "vitest";
import { AgentCardPreferences, agentCardPreferenceKey, readAgentCardPreference } from "./agent-card-preferences.js";

describe("agent message disclosure preferences", () => {
  it("defaults collapsed and persists the Settings default across reload", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const store = new AgentCardPreferences(storage); expect(store.isOpen("n:1")).toBe(false);
    store.setDefault(true); expect(store.isOpen("n:1")).toBe(true); expect(values.get(agentCardPreferenceKey)).toBe("true");
    expect(new AgentCardPreferences(storage).isOpen("n:1")).toBe(true);
    store.setDefault(false); expect(new AgentCardPreferences(storage).isOpen("n:1")).toBe(false);
    expect(readAgentCardPreference({ getItem: () => "bad" })).toBe(false);
    expect(readAgentCardPreference({ getItem: () => { throw new Error("denied"); } })).toBe(false);
  });
  it("remembers manual choices across views for this page, overriding changes to the default", () => {
    const store = new AgentCardPreferences(); let changes = 0; const unsubscribe = store.subscribe(() => changes++);
    store.toggle("n:1"); expect(store.isOpen("n:1")).toBe(true); expect(store.isOpen("other:1")).toBe(false);
    store.setDefault(true); store.toggle("n:1"); expect(store.isOpen("n:1")).toBe(false); expect(store.isOpen("other:1")).toBe(true);
    store.setDefault(false); expect(store.isOpen("n:1")).toBe(false);
    expect(new AgentCardPreferences().getSnapshot().overrides.size).toBe(0); expect(changes).toBe(4); unsubscribe();
  });
});
