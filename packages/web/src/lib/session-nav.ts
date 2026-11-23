import { createContext, useContext } from "react";
import type { RunSnapshot } from "@baton/protocol";
import type { AgentSessionEntry } from "@baton/protocol";

/** Where a card points when it names a session in another run (an incoming <baton-message>, or send_message). */
export interface SessionRef { run: string; node?: string; project?: string; title?: string }
export interface SessionNav {
  /** Jump to a session: its run, project and node (messages between sessions, DESIGN §4.16). */
  open(ref: SessionRef): void;
  /** Runs other than the open one, so a card can show the sender's agent, role and status. */
  refs(snapshot: RunSnapshot | undefined): ReadonlyMap<string, RunSnapshot>;
  inspect?(nodeId: string): void;
}
const SessionNavContext = createContext<SessionNav | null>(null);
export const SessionNavProvider = SessionNavContext.Provider;
export function useSessionNav(): SessionNav | null { return useContext(SessionNavContext); }
/** The directory row for a session (agent, role, status), from the open run's snapshot or another one in `refs`. */
export function sessionEntry(nodeId: string, snapshot: RunSnapshot | undefined, refs: ReadonlyMap<string, RunSnapshot>): AgentSessionEntry | undefined {
  const sources = snapshot ? [snapshot, ...refs.values()] : [...refs.values()];
  for (const source of sources) {
    const node = source.nodes.find(entry => entry.id === nodeId);
    if (!node) continue;
    return { agentId: node.id, agent: node.agentId, ...(node.model ? { model: node.model } : {}), ...(node.role ? { role: node.role } : {}), title: node.title, status: node.status, run: { id: source.run.id, title: source.run.title, status: source.run.status }, updatedAt: node.updatedAt };
  }
  return undefined;
}
