import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { NodeRecord, RunSnapshot } from "@baton/protocol";
import { displayStatus, statusLabels } from "../lib/derive.js";
import { useDismiss } from "../lib/dismiss.js";
import { moveActive, placePopover } from "../lib/listbox.js";
import { matchesSession, overflowEdges, overflows, scrollStep } from "../lib/session-tabs.js";
import { AgentMark, Icon } from "./common.js";
import { SelectListbox } from "./Select.js";
import "./session-tabs.css";

let nearestContainerSupported: boolean | undefined;
function revealTab(row: HTMLElement, tab: HTMLElement) {
  if (nearestContainerSupported === undefined) {
    nearestContainerSupported = false;
    const probe = { block: "nearest", get container() { nearestContainerSupported = true; return "nearest"; } } as const;
    document.createElement("div").scrollIntoView(probe);
  }
  if (nearestContainerSupported) {
    const options = { inline: "nearest", block: "nearest", container: "nearest" } as const;
    tab.scrollIntoView(options);
  } else {
    const viewport = row.getBoundingClientRect(), bounds = tab.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(row).scrollPaddingInlineStart) || 0;
    const before = bounds.left - viewport.left - padding, after = bounds.right - viewport.right + padding;
    if (!(before < 0 && after > 0)) row.scrollLeft += before < 0 ? before : after > 0 ? after : 0;
  }
}

function AllSessions({ nodes, snapshot, selected, select }: {
  nodes: NodeRecord[]; snapshot: RunSnapshot; selected: string; select: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [highlight, setHighlight] = useState("");
  const listId = useId();
  const options = open ? nodes.filter(node => matchesSession(node, query)).map(node => {
    const status = displayStatus(node, snapshot);
    return { value: node.id, label: node.role || node.title, description: node.role && node.role !== node.title ? node.title : undefined,
      icon: <span className="session-option-mark"><AgentMark agent={node.agentId} small /><span className={`status status-${status}`} role="img" aria-label={statusLabels[status]} title={statusLabels[status]}><i className="status-dot" /></span></span> };
  }) : [];
  const active = Math.max(0, options.findIndex(option => option.value === highlight));
  const activeId = options[active] ? `${listId}-option-${active}` : undefined;
  const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus({ preventScroll: true }); };
  const choose = (id: string) => { close(true); select(id); };
  useDismiss(open, root, reason => close(reason === "escape"));
  useLayoutEffect(() => {
    const popup = panel.current, button = trigger.current;
    if (!open || !popup || !button) return;
    popup.showPopover?.();
    const place = () => {
      const { left, top, maxHeight } = placePopover({ anchor: button.getBoundingClientRect(), viewport: { width: window.innerWidth, height: window.innerHeight }, width: popup.offsetWidth, natural: 340 });
      Object.assign(popup.style, { left: `${left}px`, top: `${top}px`, maxHeight: `${maxHeight}px` });
    };
    place(); popup.querySelector("input")?.focus({ preventScroll: true });
    const resize = new ResizeObserver(place); resize.observe(root.current!); resize.observe(popup);
    window.addEventListener("resize", place);
    return () => { resize.disconnect(); window.removeEventListener("resize", place); };
  }, [open]);
  useLayoutEffect(() => {
    const row = activeId ? document.getElementById(activeId) : null, list = row?.parentElement;
    if (!row || !list) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [activeId]);

  return <div ref={root} className="session-all" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(false); }}>
    <button ref={trigger} type="button" className="session-all-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      onClick={() => { setQuery(""); setHighlight(selected); setOpen(!open); }}>全部会话 {nodes.length}<Icon name="down" size={12} /></button>
    {open && <div ref={panel} popover="manual" className="select-popover session-all-popover">
      <input role="combobox" type="search" aria-label="筛选会话" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={activeId}
        className="select-search" placeholder="筛选会话…" value={query} onChange={event => { setQuery(event.target.value); setHighlight(""); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") { event.preventDefault(); const option = options[active]; if (option) choose(option.value); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setHighlight(options[moveActive(options, active, event.key)]?.value ?? ""); }
        }} />
      <SelectListbox id={listId} label="全部会话" options={options} value={selected} active={active} choose={option => choose(option.value)} hover={index => setHighlight(options[index]!.value)} />
      {!options.length && <div className="select-empty" role="status">没有匹配的会话</div>}
    </div>}
  </div>;
}

export function SessionTabs({ snapshot, selected, select, inspect, showTopology }: {
  snapshot: RunSnapshot; selected: string; select: (id: string) => void; inspect: (id: string) => void; showTopology: (id: string) => void;
}) {
  const nodes = [...snapshot.nodes].sort((first, second) => Number(second.id === snapshot.run.rootNodeId) - Number(first.id === snapshot.run.rootNodeId) || first.createdAt.localeCompare(second.createdAt));
  const tabs = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false), [edges, setEdges] = useState({ left: false, right: false });
  const menu = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ trigger: HTMLButtonElement; id: string; x: number; y: number } | null>(null);
  const [notice, setNotice] = useState("");
  const target = nodes.find(node => node.id === anchor?.id);
  const close = (refocus: boolean) => { setAnchor(null); if (refocus) anchor?.trigger.focus(); };
  useDismiss(Boolean(anchor), menu, reason => close(reason === "escape"));
  useLayoutEffect(() => {
    const row = tabs.current, content = track.current, host = bar.current;
    if (!row || !content || !host) return;
    const measure = () => {
      setOverflow(overflows(content.offsetWidth, host.clientWidth));
      const next = overflowEdges(row.scrollLeft, row.scrollWidth, row.clientWidth);
      setEdges(last => last.left === next.left && last.right === next.right ? last : next);
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || !overflows(row.scrollWidth, row.clientWidth)) return;
      const sides = overflowEdges(row.scrollLeft, row.scrollWidth, row.clientWidth);
      if (event.deltaY > 0 ? !sides.right : !sides.left) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? row.clientWidth : 1;
      row.scrollLeft += event.deltaY * unit;
    };
    measure();
    const resize = new ResizeObserver(measure); resize.observe(host); resize.observe(row); resize.observe(content);
    row.addEventListener("scroll", measure); row.addEventListener("wheel", wheel, { passive: false });
    return () => { resize.disconnect(); row.removeEventListener("scroll", measure); row.removeEventListener("wheel", wheel); };
  }, []);
  useLayoutEffect(() => {
    const row = tabs.current, tab = row?.querySelector<HTMLElement>(".is-selected");
    if (row && tab && overflow) revealTab(row, tab);
  }, [selected, overflow]);
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
  const page = (direction: -1 | 1) => {
    const row = tabs.current;
    if (row) row.scrollBy({ left: scrollStep(row.clientWidth, direction), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  return <div className="session-tabs-bar" ref={bar}><div className="session-tabs-window" data-left={overflow && edges.left} data-right={overflow && edges.right}>
    <div className="session-tabs" ref={tabs} role="tablist" aria-label="节点会话"><div className="session-tabs-track" role="presentation" ref={track}>
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
            if (next >= 0) { event.preventDefault(); tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true }); select(nodes[next]!.id); }
          }}><AgentMark agent={node.agentId} small /><span className="session-tab-name">{label}</span><span aria-hidden="true" className={`status status-${status}`} data-status={status}><i className="status-dot" /></span></button>
        <button type="button" className="session-tab-more" tabIndex={active ? 0 : -1} aria-label={`${label}的会话操作`} title="会话操作" aria-haspopup="menu" aria-expanded={anchor?.id === node.id}
          onClick={event => open(event.currentTarget, node.id)}>⋯</button>
      </div>;
    })}
    </div></div>
    {overflow && edges.left && <button type="button" className="icon-button session-tabs-edge before" aria-label="向左滚动会话标签" onClick={() => page(-1)}><Icon name="chevron" size={13} /></button>}
    {overflow && edges.right && <button type="button" className="icon-button session-tabs-edge after" aria-label="向右滚动会话标签" onClick={() => page(1)}><Icon name="chevron" size={13} /></button>}
  </div>{overflow && <AllSessions nodes={nodes} snapshot={snapshot} selected={selected} select={select} />}
    {notice && <span className="session-tab-notice" role="status">{notice}</span>}
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
