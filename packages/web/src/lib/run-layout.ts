import type { InboxItem, RunSnapshot } from "@baton/protocol";
import { terminal } from "./derive.js";
import { snapshotInbox } from "./inbox.js";

export type RunTab = "topology" | "timeline" | "transcript" | "team";
export const runDetailsStorageKey = "baton.runDetailsOpen";
export interface RunPanelState { detailsOpen: boolean; nodeId: string | null }
export type RunPanelAction =
  | { type: "toggle_details" }
  | { type: "inspect"; nodeId: string | null }
  | { type: "back_to_details" }
  | { type: "close" };
export function readRunPanel(storage: Pick<Storage, "getItem">): RunPanelState {
  try { return { detailsOpen: storage.getItem(runDetailsStorageKey) === "true", nodeId: null }; }
  catch { return { detailsOpen: false, nodeId: null }; }
}
export function saveRunPanel(storage: Pick<Storage, "setItem">, detailsOpen: boolean): void {
  try { storage.setItem(runDetailsStorageKey, String(detailsOpen)); } catch { /* Private browsing may deny storage. */ }
}
export function reduceRunPanel(state: RunPanelState, action: RunPanelAction): RunPanelState {
  switch (action.type) {
    case "toggle_details": return { detailsOpen: state.nodeId ? true : !state.detailsOpen, nodeId: null };
    case "inspect": return { ...state, nodeId: action.nodeId };
    case "back_to_details": return { detailsOpen: true, nodeId: null };
    case "close": return { detailsOpen: false, nodeId: null };
  }
}
export function visibleRunPanel(state: RunPanelState): "inspector" | "details" | null {
  return state.nodeId ? "inspector" : state.detailsOpen ? "details" : null;
}
export function runMetrics(snapshot: RunSnapshot) {
  const pending = snapshotInbox(snapshot);
  const pendingByKind: Record<InboxItem["kind"], number> = { permission: 0, proposal: 0, question: 0, escalation: 0 };
  for (const item of pending) pendingByKind[item.kind]++;
  return {
    activeNodes: snapshot.nodes.filter(node => !terminal(node.status) && node.status !== "idle").length,
    totalNodes: snapshot.nodes.length,
    tokens: snapshot.run.usage.inputTokens + snapshot.run.usage.outputTokens,
    pendingTotal: pending.length, pendingByKind,
    activeMembers: snapshot.run.team?.members.filter(member => member.status === "active") ?? [],
  };
}
/** The composer remains compact for short drafts and scrolls after eight lines. */
export function composerHeight(scrollHeight: number, lineHeight: number, padding = 0): number {
  const minimum = lineHeight * 2 + padding;
  return Math.round(Math.max(minimum, Math.min(scrollHeight, lineHeight * 8 + padding)));
}
