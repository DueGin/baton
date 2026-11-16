export const agentCardPreferenceKey = "baton.agentMessagesExpanded";
export function readAgentCardPreference(storage?: Pick<Storage, "getItem">): boolean {
  try { return storage?.getItem(agentCardPreferenceKey) === "true"; } catch { return false; }
}
/** The default persists across reloads; manual card choices last for this page session. */
export class AgentCardPreferences {
  private state: { defaultOpen: boolean; overrides: ReadonlyMap<string, boolean> };
  private listeners = new Set<() => void>();
  constructor(private storage?: Pick<Storage, "getItem" | "setItem">) { this.state = { defaultOpen: readAgentCardPreference(storage), overrides: new Map() }; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { this.listeners.forEach(listener => listener()); }
  isOpen = (id: string): boolean => this.state.overrides.get(id) ?? this.state.defaultOpen;
  setDefault = (value: boolean): void => {
    try { this.storage?.setItem(agentCardPreferenceKey, String(value)); } catch { /* Storage may be denied. */ }
    this.state = { ...this.state, defaultOpen: value }; this.notify();
  };
  toggle = (id: string): void => {
    const overrides = new Map(this.state.overrides); overrides.set(id, !this.isOpen(id));
    this.state = { ...this.state, overrides }; this.notify();
  };
}
function storage(): Storage | undefined { try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; } }
export const agentCardPreferences = new AgentCardPreferences(storage());
