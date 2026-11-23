import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RunSnapshot } from "@baton/protocol";
import { displayStatus, statusLabels } from "../lib/derive.js";
import { useDismiss } from "../lib/dismiss.js";
import { AgentMark } from "./common.js";

export function SessionTabs({ snapshot, selected, select, inspect, showTopology }: {
  snapshot: RunSnapshot; selected: string; select: (id: string) => void; inspect: (id: string) => void; showTopology: (id: string) => void;
}) {
  const nodes = [...snapshot.nodes].sort((first, second) => Number(second.id === snapshot.run.rootNodeId) - Number(first.id === snapshot.run.rootNodeId) || first.createdAt.localeCompare(second.createdAt));
  const tabs = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ trigger: HTMLButtonElement; id: string; x: number; y: number } | null>(null);
  const [notice, setNotice] = useState("");
  const target = nodes.find(node => node.id === anchor?.id);
  const close = (refocus: boolean) => { setAnchor(null); if (refocus) anchor?.trigger.focus(); };
  useDismiss(Boolean(anchor), menu, reason => close(reason === "escape"));
  useEffect(() => {
    tabs.current?.querySelector('[aria-selected="true"]')?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  useLayoutEffect(() => {
    const panel = menu.current;
    if (!anchor || !panel) return;
    const place = () => {
      panel.style.left = `${Math.max(4, Math.min(anchor.x, window.innerWidth - panel.offsetWidth - 4))}px`;
      panel.style.top = `${Math.max(4, Math.min(anchor.y, window.innerHeight - panel.offsetHeight - 4))}px`;
    };
    place(); panel.querySelector("button")?.focus();
    window.addEventListener("resize", place); return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 1800); return () => clearTimeout(timer);
  }, [notice]);
  const copy = async (id: string) => {
    close(true);
    try { await navigator.clipboard.writeText(id); setNotice("已复制"); }
    catch { setNotice("复制失败，请检查剪贴板权限"); }
  };
  const open = (trigger: HTMLButtonElement, id: string, x?: number, y?: number) => {
    const rect = trigger.getBoundingClientRect();
    setNotice(""); setAnchor({ trigger, id, x: x ?? rect.left, y: y ?? rect.bottom });
  };
  return <div className="session-tabs-bar"><div className="session-tabs" ref={tabs} role="tablist" aria-label="节点会话">
    {nodes.map((node, index) => {
      const status = displayStatus(node, snapshot), active = node.id === selected, label = node.role || node.title;
      const description = `${node.agentId} · ${node.title} · ${statusLabels[status]}`;
      return <div role="presentation" key={node.id} className={`session-tab${active ? " is-selected" : ""}${node.status === "replaced" ? " is-replaced" : ""}`}>
        <button type="button" role="tab" id={`session-tab-${node.id}`} aria-controls="session-content" aria-selected={active} tabIndex={active ? 0 : -1}
          aria-label={`${label} · ${statusLabels[status]}`} title={description} aria-haspopup="menu" onClick={() => select(node.id)}
          onContextMenu={event => { event.preventDefault(); open(event.currentTarget, node.id, event.clientX, event.clientY); }}
          onKeyDown={event => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); open(event.currentTarget, node.id); return; }
            const next = event.key === "ArrowLeft" ? (index - 1 + nodes.length) % nodes.length : event.key === "ArrowRight" ? (index + 1) % nodes.length : event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1 : -1;
            if (next >= 0) { event.preventDefault(); tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus(); select(nodes[next]!.id); }
          }}><AgentMark agent={node.agentId} small /><span className="session-tab-name">{label}</span><span aria-hidden="true" className={`status status-${status}`}><i className="status-dot" /></span></button>
        <button type="button" className="session-tab-more" tabIndex={active ? 0 : -1} aria-label={`${label}的会话操作`} title="会话操作" aria-haspopup="menu" aria-expanded={anchor?.id === node.id}
          onClick={event => open(event.currentTarget, node.id)}>⋯</button>
      </div>;
    })}
  </div>{notice && <span className="session-tab-notice" role="status">{notice}</span>}
    {anchor && target && <div ref={menu} role="menu" aria-label="会话操作" className="session-tab-menu" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(false); }}
      onKeyDown={event => {
        const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
        const index = buttons.findIndex(button => button === event.target);
        const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
        if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
      }}>
      <button type="button" role="menuitem" onClick={() => void copy(target.id)}>复制会话 ID</button>
      {target.delegationId && <button type="button" role="menuitem" onClick={() => void copy(target.delegationId!)}>复制委派 ID</button>}
      <button type="button" role="menuitem" onClick={() => { close(false); showTopology(target.id); }}>在拓扑图中查看</button>
      <button type="button" role="menuitem" onClick={() => { close(true); inspect(target.id); }}>打开详情</button>
    </div>}
  </div>;
}
