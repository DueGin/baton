import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AgentEntry } from "@baton/protocol";
import { agentGroup, agentGroupLabels, agentReady, pickerAgents } from "../lib/agents.js";
import { AgentMark, Icon } from "./common.js";
import { useDismiss } from "../lib/dismiss.js";

export function AgentOptions({ agents, query = "", value, choose }: { agents: AgentEntry[]; query?: string; value: string; choose: (id: string) => void }) {
  const entries = pickerAgents(agents, query, value);
  return <>{entries.map(agent => <button type="button" role="option" aria-selected={value === agent.id} key={agent.id} className="agent-picker-option" disabled={!agentReady(agent)} onClick={() => { if (agentReady(agent)) choose(agent.id); }}><AgentMark agent={agent.id} small /><span><strong>{agent.label}</strong><small>{agent.kind === "acp" ? "ACP" : "Native"} · {agent.version ?? agentGroupLabels[agentGroup(agent)]}</small></span>{agentReady(agent) ? value === agent.id && <Icon name="check" size={13} /> : <small className="picker-unavailable">{agentGroupLabels[agentGroup(agent)]}</small>}</button>)}{!entries.length && <p className="muted agent-picker-empty">没有匹配的 agent</p>}</>;
}
export function AgentPicker({ agents, value, change, label = "Agent" }: { agents: AgentEntry[]; value: string; change: (id: string) => void; label?: string }) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(""); const id = useId(); const container = useRef<HTMLDivElement>(null); const panel = useRef<HTMLDivElement>(null); const search = useRef<HTMLInputElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const selected = agents.find(agent => agent.id === value); const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const element = panel.current; if (!element) return;
    // The top layer escapes the proposal table's scrolling container and stays usable in modal dialogs.
    element.showPopover?.();
    const position = () => { const rect = trigger.current?.getBoundingClientRect(); if (!rect) return; const width = Math.min(310, window.innerWidth - 24); element.style.width = `${width}px`; const height = element.getBoundingClientRect().height; element.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.left))}px`; element.style.top = `${rect.bottom + height + 6 < window.innerHeight ? rect.bottom + 6 : Math.max(12, rect.top - height - 6)}px`; };
    const resize = new ResizeObserver(position); resize.observe(element);
    position(); window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    return () => { resize.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); element.hidePopover?.(); };
  }, [open]);
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  useDismiss(open, container, reason => { if (reason === "escape") close(); else setOpen(false); });
  return <div className="searchable-agent-picker" ref={container} onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); } if (!open && event.target === trigger.current && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setQuery(""); setOpen(true); return; } if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { if (event.target === search.current && ["Home", "End"].includes(event.key)) return; const options = [...container.current!.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]; if (!options.length) return; const current = options.indexOf(document.activeElement as HTMLButtonElement); const index = event.key === "Home" ? 0 : event.key === "End" || (current < 0 && event.key === "ArrowUp") ? options.length - 1 : Math.max(0, Math.min(options.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))); event.preventDefault(); options[index]?.focus(); } }}>
    <span className="agent-picker-label">{label}</span><button ref={trigger} type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} className={`agent-picker-trigger${selected && !agentReady(selected) ? " unavailable" : ""}`} onClick={() => { setQuery(""); setOpen(value => !value); }}>{selected ? <><AgentMark agent={selected.id} small /><span>{selected.label}</span>{!agentReady(selected) && <small>不可用</small>}</> : <span>{value || "选择 agent"}</span>}<Icon name="down" size={12} /></button>
    {open && <div ref={panel} popover="manual" className="agent-picker-popover"><input ref={search} type="search" aria-label={`搜索 ${label}`} placeholder="搜索 agent 或模型…" value={query} onChange={event => setQuery(event.target.value)} /><div id={id} role="listbox" aria-label={label} className="agent-picker-options"><AgentOptions agents={agents} query={query} value={value} choose={id => { change(id); close(); }} /></div></div>}{value && !selected && <span className="error-text">未检测到 {value}</span>}
  </div>;
}
