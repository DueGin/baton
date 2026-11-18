import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { activeOutlineIndex, type OutlineItem } from "../lib/outline.js";
import { clock } from "../lib/derive.js";

const selector = (seq: number) => `[data-user-message="${seq}"]`;

/**
 * Codex-style navigation rail on the right of a conversation: one tick per message the human sent,
 * the one in view highlighted. Hover or focus previews the messages; clicking jumps to one.
 */
export function ConversationOutline({ items, scroll }: { items: OutlineItem[]; scroll: RefObject<HTMLDivElement | null> }) {
  const [active, setActive] = useState(0); const [hover, setHover] = useState<number | null>(null); const [open, setOpen] = useState(false);
  const panel = useRef<HTMLOListElement>(null); const flash = useRef<number | undefined>(undefined);
  const measure = useCallback(() => {
    const container = scroll.current; if (!container) return;
    const box = container.getBoundingClientRect();
    const tops = items.map(item => container.querySelector(selector(item.seq))?.getBoundingClientRect().top ?? Infinity);
    setActive(activeOutlineIndex(tops, box.top, box.height));
  }, [items, scroll]);
  useEffect(() => {
    const container = scroll.current; if (!container) return;
    let frame = 0; const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure(); container.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(onScroll); resize.observe(container);
    return () => { cancelAnimationFrame(frame); container.removeEventListener("scroll", onScroll); resize.disconnect(); };
  }, [measure, scroll]);
  useEffect(() => () => window.clearTimeout(flash.current), []);
  // Keep the previewed row visible in a long list.
  useEffect(() => { if (open) panel.current?.querySelector<HTMLElement>(`[data-outline-index="${hover ?? active}"]`)?.scrollIntoView({ block: "nearest" }); }, [open, hover, active]);
  if (items.length < 2) return null;
  const jump = (index: number): void => {
    const target = scroll.current?.querySelector<HTMLElement>(selector(items[index]!.seq)); if (!target) return;
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    target.classList.remove("outline-flash"); void target.offsetWidth; target.classList.add("outline-flash");
    window.clearTimeout(flash.current); flash.current = window.setTimeout(() => target.classList.remove("outline-flash"), 1600);
    setActive(index);
  };
  const shown = hover ?? active;
  return <nav className={`conversation-outline${open ? " is-open" : ""}`} aria-label="消息目录"
    onMouseEnter={() => setOpen(true)} onMouseLeave={() => { setOpen(false); setHover(null); }}
    onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setHover(null); } }}
    onKeyDown={event => { if (event.key === "Escape") { (document.activeElement as HTMLElement | null)?.blur(); setOpen(false); } }}>
    <div className="outline-rail">{items.map((item, index) => <button type="button" key={item.seq} className={`outline-tick${index === active ? " is-active" : ""}${index === hover ? " is-hover" : ""}`}
      aria-label={`跳到第 ${index + 1} 条消息：${item.preview.slice(0, 40)}`} aria-current={index === active ? "location" : undefined}
      onMouseEnter={() => setHover(index)} onFocus={() => setHover(index)} onClick={() => jump(index)}><i /></button>)}</div>
    {open && <ol className="outline-panel" ref={panel} aria-label="你发送的消息">{items.map((item, index) => <li key={item.seq}>
      <button type="button" tabIndex={-1} data-outline-index={index} className={`${index === active ? "is-active" : ""}${index === shown ? " is-shown" : ""}`} onMouseEnter={() => setHover(index)} onClick={() => jump(index)}>
        <span className="outline-number">{index + 1}</span><span className="outline-preview" title={item.preview}>{item.preview}</span><time dateTime={item.ts}>{clock(item.ts)}</time>
      </button></li>)}</ol>}
  </nav>;
}
