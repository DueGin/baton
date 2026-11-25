import type { NodeRecord } from "@baton/protocol";
import { optionMatches } from "./listbox.js";

export function overflows(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > 1;
}

export function overflowEdges(scrollLeft: number, scrollWidth: number, clientWidth: number) {
  const max = Math.max(0, scrollWidth - clientWidth);
  const left = Math.max(0, Math.min(scrollLeft, max));
  return { left: left > 1, right: max - left > 1 };
}

export function scrollStep(clientWidth: number, direction: -1 | 1): number {
  return direction * Math.round(clientWidth * 0.8);
}

export function matchesSession(node: Pick<NodeRecord, "id" | "title" | "role" | "agentId">, query: string): boolean {
  return optionMatches({ value: node.id, label: node.role || node.title, description: node.title, keywords: node.agentId }, query);
}
