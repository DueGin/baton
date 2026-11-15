export type ReasoningPreference = "collapsed" | "expanded" | "streaming";
export const reasoningPreferenceKey = "baton.reasoningDisplay";
export const reasoningOptions: Array<{ value: ReasoningPreference; label: string }> = [
  { value: "collapsed", label: "折叠" }, { value: "expanded", label: "展开" }, { value: "streaming", label: "生成时展开、结束后折叠" },
];
export function readReasoningPreference(storage?: Pick<Storage, "getItem">): ReasoningPreference {
  try { const value = storage?.getItem(reasoningPreferenceKey); return value === "expanded" || value === "streaming" ? value : "collapsed"; } catch { return "collapsed"; }
}
export function reasoningOpen(preference: ReasoningPreference, streaming: boolean, override?: boolean): boolean {
  return override ?? (preference === "expanded" || preference === "streaming" && streaming);
}
/** Preferences persist; explicit block decisions last only for this page session. */
export class ReasoningPreferences {
  private state: { preference: ReasoningPreference; overrides: ReadonlyMap<string, boolean> };
  private listeners = new Set<() => void>();
  constructor(private storage?: Pick<Storage, "getItem" | "setItem">) { this.state = { preference: readReasoningPreference(storage), overrides: new Map() }; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { this.listeners.forEach(listener => listener()); }
  setPreference = (preference: ReasoningPreference): void => {
    try { this.storage?.setItem(reasoningPreferenceKey, preference); } catch { /* Private browsing may deny storage. */ }
    this.state = { ...this.state, preference }; this.notify();
  };
  setBlocks = (ids: string[], open: boolean): void => {
    const overrides = new Map(this.state.overrides); ids.forEach(id => overrides.set(id, open));
    this.state = { ...this.state, overrides }; this.notify();
  };
}
function browserStorage(): Storage | undefined { try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; } }
export const reasoningPreferences = new ReasoningPreferences(browserStorage());
export const reasoningBlockId = (nodeId: string, seq: number): string => `${nodeId}:${seq}`;
