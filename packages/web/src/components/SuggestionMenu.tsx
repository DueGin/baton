import { useLayoutEffect, useRef } from "react";
import { placePopover } from "../lib/listbox.js";
import type { SuggestionSession, SuggestionState } from "../lib/composer-suggest.js";
import { SelectListbox } from "./Select.js";

type CaretBounds = Pick<DOMRect, "top" | "bottom" | "left" | "right">;
const optionId = (id: string, index: number) => `${id}-option-${index}`;

export function suggestionAria(id: string, state: SuggestionState | null) {
  return { "aria-expanded": !!state, "aria-controls": state ? id : undefined,
    "aria-activedescendant": state && state.active >= 0 ? optionId(id, state.active) : undefined };
}

export function SuggestionMenu({ id, state, session, caret, accept }: {
  id: string; state: SuggestionState; session: SuggestionSession; caret: () => CaretBounds | null; accept: (index: number) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef(caret); anchor.current = caret;
  const place = useRef(() => {});
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    element.showPopover?.();
    place.current = () => {
      const bounds = anchor.current();
      if (!bounds) { element.style.visibility = "hidden"; return; }
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const list = document.getElementById(id);
      const natural = element.offsetHeight + (list ? list.scrollHeight - list.clientHeight : 0);
      const placement = placePopover({ anchor: bounds, viewport, natural, width: element.offsetWidth, maxHeight: 260 });
      element.style.visibility = "";
      element.style.maxHeight = `${placement.maxHeight}px`;
      element.style.left = `${placement.left}px`;
      element.style.top = `${placement.top}px`;
    };
    const scrolled = (event: Event) => { if (!(event.target instanceof Node && element.contains(event.target))) place.current(); };
    window.addEventListener("resize", place.current);
    window.addEventListener("scroll", scrolled, true);
    return () => { window.removeEventListener("resize", place.current); window.removeEventListener("scroll", scrolled, true); };
  }, [id]);

  useLayoutEffect(() => {
    place.current();
    const list = document.getElementById(id), row = document.getElementById(optionId(id, state.active));
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  });

  return <div className="select-popover suggestion-popover" ref={panel} popover="manual"
    onMouseDown={event => event.preventDefault()} onClick={event => event.preventDefault()}>
    <SelectListbox id={id} label={state.match.kind === "command" ? "命令补全" : "文件补全"}
      options={state.options} value={state.options[state.active]?.value ?? ""} active={state.active}
      choose={option => accept(state.options.indexOf(option))} hover={index => session.activate(index)} />
    {!state.options.length && <div className="suggestion-status" role="status">{state.loading ? "加载中…" : "无匹配"}</div>}
  </div>;
}
