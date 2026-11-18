import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { filterOptions, initialActive, isTypeAheadKey, moveActive, navigationKeys, placePopover, popoverWidths, SEARCH_THRESHOLD, typeAhead, TYPE_AHEAD_MS, type NavigationKey, type SelectOption } from "../lib/listbox.js";
import { useDismiss } from "../lib/dismiss.js";
import { Icon } from "./common.js";

export type { SelectOption } from "../lib/listbox.js";

export interface SelectProps {
  value: string;
  options: SelectOption[];
  /** `query` is what the search box held when the row was chosen (an action row can reuse it). */
  onChange: (value: string, context: { query: string }) => void;
  /** Accessible name of the trigger and the list; a visible caption, if any, belongs to the caller. */
  label: string;
  /** Trigger text while nothing is chosen. */
  placeholder?: string;
  disabled?: boolean;
  /** A search box at the top of the list. Defaults to on for lists longer than `SEARCH_THRESHOLD`. */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  /** `ghost` has no border until hovered or open (toolbars). */
  variant?: "field" | "ghost";
  className?: string;
  /** The list is never narrower than the trigger, nor than this. */
  popoverMinWidth?: number;
  popoverMaxWidth?: number;
  title?: string;
  autoFocus?: boolean;
}

const classes = (...names: Array<string | false | undefined>): string => names.filter(Boolean).join(" ");

/** The rows of an open list. Exported so tests can render the options without opening a popover. */
export function SelectListbox({ id, label, options, value, active = -1, optionId = index => `${id}-option-${index}`, choose, hover }: { id: string; label: string; options: SelectOption[]; value: string; active?: number; optionId?: (index: number) => string; choose?: (option: SelectOption) => void; hover?: (index: number) => void }) {
  return <div id={id} role="listbox" aria-label={label} className="select-options">{options.map((option, index) => {
    const selected = option.value === value;
    return <div key={`${index}:${option.value}`} id={optionId(index)} role="option" aria-selected={selected} aria-disabled={option.disabled || undefined}
      className={classes("select-option", index === active && "is-active", option.separated && index > 0 && "is-separated", option.warning && "is-warning")}
      style={option.depth ? { "--depth": option.depth } as CSSProperties : undefined}
      onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (!option.disabled && index !== active) hover?.(index); }} onClick={() => choose?.(option)}>
      {option.icon}<span className="select-option-text"><span className="select-option-label">{option.label}</span>{option.description && <small>{option.description}</small>}</span>{option.hint && <small className="select-option-hint">{option.hint}</small>}<span className="select-option-check" aria-hidden="true">{selected && <Icon name="check" size={13} />}</span>
    </div>;
  })}</div>;
}

/**
 * The console's one dropdown: a trigger styled like a text input and a listbox popover in the top layer (so it escapes
 * scrolling tables and modal dialogs), positioned under or above the trigger. Closes on an outside pointerdown and on
 * Escape (`useDismiss`). Keyboard: ↑/↓/Home/End/PageUp/PageDown move, Enter/Space choose, letters type ahead (or go to the
 * search box of long lists), Tab closes. ARIA: `combobox` trigger, `listbox`/`option` rows, `aria-activedescendant`.
 */
export function Select({ value, options, onChange, label, placeholder = "请选择", disabled = false, searchable, searchPlaceholder = "搜索…", emptyText = "没有匹配的选项", variant = "field", className, popoverMinWidth = 0, popoverMaxWidth = 420, title, autoFocus }: SelectProps) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(""); const [active, setActive] = useState(-1);
  const id = useId(); const listId = `${id}-list`; const optionId = (index: number): string => `${id}-option-${index}`;
  const root = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null); const panel = useRef<HTMLDivElement>(null); const search = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: "", at: 0 }); const spaceChose = useRef(false); const reveal = useRef(false);
  const withSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const shown = withSearch ? filterOptions(options, query) : options;
  const selected = options.find(option => option.value === value);
  const activeId = open && active >= 0 && active < shown.length ? optionId(active) : undefined;
  // Nothing but pinned rows (自定义…, the current value) left: say so above them.
  const unmatched = shown.every(option => option.pinned) && (query.trim() !== "" || !shown.length);

  const activate = (index: number): void => { reveal.current = true; setActive(index); };
  const show = (text = "", start?: number): void => { setQuery(text); activate(start ?? initialActive(withSearch ? filterOptions(options, text) : options, value)); setOpen(true); };
  const close = (refocus: boolean): void => { setOpen(false); setQuery(""); typed.current.text = ""; if (refocus) trigger.current?.focus(); };
  const choose = (option: SelectOption | undefined): void => {
    if (!option || option.disabled) return;
    const text = query; close(true);
    if (option.value !== value) onChange(option.value, { query: text });
  };
  const typeAheadFrom = (key: string, from: number): number => {
    const now = Date.now(); const text = now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + key : key;
    typed.current = { text, at: now };
    return typeAhead(shown, text, from);
  };
  const typing = (): boolean => typed.current.text !== "" && Date.now() - typed.current.at < TYPE_AHEAD_MS;

  // Inside a <label>, the label is part of the control: clicking its caption toggles the list instead of closing and reopening it.
  const scope = useMemo(() => ({ get current(): HTMLElement | null { return root.current?.closest("label") ?? root.current; } }), []);
  useDismiss(open, scope, reason => close(reason === "escape"));

  useLayoutEffect(() => {
    if (!open) return;
    const element = panel.current; const anchor = trigger.current; if (!element || !anchor) return;
    try { element.showPopover?.(); } catch { /* already showing */ }
    const place = (): void => {
      const rect = anchor.getBoundingClientRect(); const viewport = { width: window.innerWidth, height: window.innerHeight };
      const widths = popoverWidths(rect.width, viewport.width, { minWidth: popoverMinWidth, maxWidth: popoverMaxWidth });
      element.style.minWidth = `${widths.min}px`; element.style.maxWidth = `${widths.max}px`;
      const list = element.querySelector<HTMLElement>(".select-options");
      const natural = element.offsetHeight + (list ? list.scrollHeight - list.clientHeight : 0);
      const placement = placePopover({ anchor: rect, viewport, natural, width: element.offsetWidth });
      element.style.maxHeight = `${placement.maxHeight}px`; element.style.left = `${placement.left}px`; element.style.top = `${placement.top}px`; element.dataset.side = placement.side;
    };
    // Scrolling the list itself must not re-place (and so re-measure) the popover.
    const scrolled = (event: Event): void => { if (!(event.target instanceof Node && element.contains(event.target))) place(); };
    const resize = new ResizeObserver(place); resize.observe(element); resize.observe(anchor);
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", scrolled, true);
    return () => { resize.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", scrolled, true); try { element.hidePopover?.(); } catch { /* already hidden */ } };
  }, [open, popoverMinWidth, popoverMaxWidth]);
  useEffect(() => { if (open && withSearch) search.current?.focus(); }, [open, withSearch]);
  useEffect(() => {
    // Keep the keyboard's row in view; rows the pointer hovers are already visible.
    if (!open || !activeId || !reveal.current) return;
    reveal.current = false;
    const list = panel.current?.querySelector<HTMLElement>(".select-options"); const row = document.getElementById(activeId);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [open, activeId]);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled || event.nativeEvent.isComposing) return;
    const inSearch = event.target === search.current;
    if (event.key === "Escape") { if (open) { event.preventDefault(); event.stopPropagation(); close(true); } return; }
    if (!open) {
      if (event.target !== trigger.current) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); }
      else if (event.key === "Home" || event.key === "End") { event.preventDefault(); show("", moveActive(options, -1, event.key)); }
      else if (isTypeAheadKey(event) && event.key !== " ") {
        event.preventDefault();
        if (withSearch) show(event.key);
        else { const index = typeAheadFrom(event.key, initialActive(options, value)); show("", index >= 0 ? index : undefined); }
      }
      // Enter and Space click the button, which opens the list.
      return;
    }
    if (event.key === "Tab") { close(false); return; }
    if (navigationKeys.includes(event.key)) {
      if (inSearch && (event.key === "Home" || event.key === "End")) return;
      event.preventDefault(); activate(moveActive(shown, active, event.key as NavigationKey)); return;
    }
    // Enter also must not submit the surrounding form from the search box.
    if (event.key === "Enter") { event.preventDefault(); choose(shown[active]); return; }
    if (inSearch) return;
    if (event.key === " " && !typing()) { event.preventDefault(); spaceChose.current = true; choose(shown[active]); return; }
    if (isTypeAheadKey(event)) { event.preventDefault(); const index = typeAheadFrom(event.key, active); if (index >= 0) activate(index); }
  };

  return <div ref={root} className={classes("select", className)} onKeyDown={keyDown}
    // Space chose on keydown; its keyup would click the trigger and reopen the list.
    onKeyUp={event => { if (event.key === " " && spaceChose.current) { event.preventDefault(); spaceChose.current = false; } }}
    onBlur={event => { if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(false); }}>
    <button ref={trigger} type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={withSearch ? undefined : activeId}
      className={classes("select-trigger", variant === "ghost" && "is-ghost", selected?.warning && "is-warning")} disabled={disabled} autoFocus={autoFocus}
      title={title ?? (selected ? [selected.label, selected.description].filter(Boolean).join(" · ") : value || undefined)}
      onClick={() => { if (open) close(false); else show(); }}>
      {selected?.icon}<span className={classes("select-value", !selected && !value && "is-placeholder")}>{selected?.label ?? (value || placeholder)}</span>{selected?.warning && <small className="select-warning">{selected.warning}</small>}<Icon name="down" size={12} />
    </button>
    {open && <div ref={panel} popover="manual" className="select-popover"
      // Keep focus on the trigger or the search box; and inside a <label>, a click on a row must not re-click the trigger.
      onMouseDown={event => { if (event.target !== search.current) event.preventDefault(); }} onClick={event => event.preventDefault()}>
      {withSearch && <input ref={search} type="search" className="select-search" aria-label={`搜索 ${label}`} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId} placeholder={searchPlaceholder} value={query}
        onChange={event => { const text = event.target.value; setQuery(text); activate(initialActive(filterOptions(options, text), value)); }} />}
      {unmatched && <div className="select-empty">{emptyText}</div>}
      <SelectListbox id={listId} label={label} options={shown} value={value} active={active} optionId={optionId} choose={choose} hover={setActive} />
    </div>}
  </div>;
}
