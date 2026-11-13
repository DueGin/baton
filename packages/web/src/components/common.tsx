import type { CSSProperties, ReactNode } from "react";
import type { PermissionRecord, PermissionResponse } from "@baton/protocol";
import { agentColors, statusLabels } from "../lib/derive.js";

export function AgentMark({ agent, small = false }: { agent: string; small?: boolean }) {
  return <span className={`agent-mark ${small ? "small" : ""}`} style={{ "--agent-color": agentColors[agent] ?? "#758799" } as CSSProperties}>{agent.slice(0, 1).toUpperCase()}</span>;
}
export function Status({ status, dot = true }: { status: string; dot?: boolean }) {
  return <span className={`status status-${status}`}>{dot && <i className="status-dot" />}{statusLabels[status] ?? status}</span>;
}
export function Icon({ name, size = 18 }: { name: "edit" | "panel" | "inbox" | "graph" | "timeline" | "chat" | "agents" | "settings" | "plus" | "close" | "sun" | "moon" | "arrow" | "stop" | "chevron" | "refresh" | "check"; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    edit: <><path d="m15 4 5 5-11 11H4v-5L15 4Z" /><path d="m12 7 5 5" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
    inbox: <><path d="M4 4h16l2 12v4H2v-4L4 4Z" /><path d="M2 15h6l2 3h4l2-3h6" /></>,
    graph: <><rect x="8" y="2" width="8" height="5" rx="1" /><rect x="2" y="17" width="7" height="5" rx="1" /><rect x="15" y="17" width="7" height="5" rx="1" /><path d="M12 7v5H5v5m7-5h7v5" /></>,
    timeline: <><path d="M4 4v16M9 6h10M9 12h6M9 18h12" /></>,
    chat: <path d="M21 11a9 9 0 0 1-9 9H7l-5 2 2-5v-6a9 9 0 0 1 17 0Z" />,
    agents: <><rect x="5" y="7" width="14" height="13" rx="3" /><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6M2 11v5m20-5v5" /></>,
    settings: <><path d="m9 3 1-1h4l1 3 3 1 3 3-1 3 1 3-3 3-3 1-1 3h-4l-1-3-3-1-3-3 1-3-1-3 3-3Z" /><circle cx="12" cy="12" r="3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" /></>,
    moon: <path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z" />,
    arrow: <path d="M12 20V4m-6 6 6-6 6 6" />,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    refresh: <><path d="M20 7a9 9 0 1 0 1 9M20 2v6h-6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <label className="toggle-label"><input className="toggle-input" type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} /><span className="toggle-track" />{label}</label>;
}
export function PermissionActions({ permission, decide, busy = false }: { permission: PermissionRecord; decide: (id: string, response: PermissionResponse) => void; busy?: boolean }) {
  const actions = permission.request.actions?.length ? permission.request.actions : [{ id: "allow", label: "允许", behavior: "allow" as const }, { id: "deny", label: "拒绝", behavior: "deny" as const }];
  return <div className="permission-buttons nodrag nopan" onClick={event => event.stopPropagation()}>{actions.map(action => <button key={action.id} className={`button small ${action.behavior === "allow" ? "primary" : "subtle"}`} disabled={busy} onClick={() => decide(permission.requestId, { behavior: action.behavior, selectedActionId: action.id })}>{action.label}</button>)}</div>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="empty-state">{children}</div>; }
