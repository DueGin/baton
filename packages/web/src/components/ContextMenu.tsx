import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { isOutside } from "../lib/dismiss.js";
import "./context-menu.css";

export type ContextMenuEntry = { label: string; action: () => void; danger?: boolean } | { separator: true };

export function contextMenuPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const inset = 4;
  return {
    left: Math.max(inset, Math.min(x, viewportWidth - width - inset)),
    top: Math.max(inset, Math.min(y, viewportHeight - height - inset)),
  };
}

export function nextMenuItem(key: string, current: number, count: number): number | undefined {
  if (!count) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return current <= 0 ? count - 1 : current - 1;
  return undefined;
}

export function ContextMenu({ x, y, label, entries, close, trigger }: {
  x: number; y: number; label: string; entries: readonly ContextMenuEntry[]; close: () => void; trigger?: HTMLElement;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  useLayoutEffect(() => { closeRef.current = close; }, [close]);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    const { left, top } = contextMenuPosition(x, y, width, height, clientWidth, clientHeight);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    (element.querySelector<HTMLElement>('[role="menuitem"]') ?? element).focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const dismiss = () => closeRef.current();
    const outside = (event: Event) => { if (isOutside(menu.current, event.target)) dismiss(); };
    const scroll = (event: Event) => { if (event.target !== window && !isOutside(menu.current, event.target)) return; dismiss(); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, []);
  const closeToTrigger = () => { close(); trigger?.focus({ preventScroll: true }); };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
      closeToTrigger();
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const current = items.findIndex(item => item === event.target);
    const next = nextMenuItem(event.key, current, items.length);
    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
  };
  const content = <div ref={menu} className="context-menu" role="menu" aria-label={label} tabIndex={-1} style={{ left: x, top: y }}
    onKeyDown={keyDown} onBlur={event => { if (isOutside(event.currentTarget, event.relatedTarget)) close(); }}
    onContextMenu={event => event.preventDefault()}>
    {entries.map((entry, index) => "separator" in entry ? <div className="context-menu-separator" key={index} role="separator" /> :
      <button key={index} type="button" role="menuitem" tabIndex={-1} className={entry.danger ? "is-danger" : undefined} onClick={() => { closeToTrigger(); entry.action(); }}>{entry.label}</button>)}
  </div>;
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
