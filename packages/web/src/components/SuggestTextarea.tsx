import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentPropsWithoutRef } from "react";
import { textareaSuggestion } from "../lib/composer-markdown.js";
import { sameSuggestion, SuggestionSession, type SuggestionMatch, type SuggestionSource } from "../lib/composer-suggest.js";
import { SuggestionMenu, suggestionAria } from "./SuggestionMenu.js";

function textareaCaret(input: HTMLTextAreaElement) {
  const inputBounds = input.getBoundingClientRect();
  const mirror = document.createElement("div"), marker = document.createElement("span");
  const computed = getComputedStyle(input);
  for (const property of ["font", "line-height", "letter-spacing", "word-spacing", "text-align", "text-indent", "text-transform", "tab-size", "direction", "padding", "white-space", "word-break", "overflow-wrap"]) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }
  Object.assign(mirror.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", boxSizing: "border-box", width: `${input.clientWidth}px`, top: "0", left: "0" });
  mirror.textContent = input.value.slice(0, input.selectionStart);
  marker.textContent = input.value.slice(input.selectionStart) || "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const rect = marker.getClientRects()[0];
  mirror.remove();
  if (!rect) return null;
  const left = inputBounds.left + input.clientLeft + rect.left - input.scrollLeft;
  const top = inputBounds.top + input.clientTop + rect.top - input.scrollTop;
  const bottom = top + rect.height;
  return bottom < inputBounds.top || top > inputBounds.bottom ? null : { left, right: left, top, bottom };
}

export function SuggestTextarea({ value, setValue, source, ...props }: Omit<ComponentPropsWithoutRef<"textarea">, "value" | "onChange"> & {
  value: string; setValue: (value: string) => void; source: SuggestionSource;
}) {
  const [session] = useState(() => new SuggestionSession());
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const restoreCaret = useRef<number | null>(null);
  const detect = (element: HTMLTextAreaElement) => element.selectionStart === element.selectionEnd ? textareaSuggestion(element.value, element.selectionStart) : null;
  const sync = (element: HTMLTextAreaElement) => session.update(!composing.current && document.activeElement === element ? detect(element) : null, source);
  const replace = (match: SuggestionMatch, text: string) => {
    const element = input.current;
    if (!element || composing.current || !sameSuggestion(detect(element), match)) return;
    const next = element.value.slice(0, match.from) + text + element.value.slice(match.to);
    if (next === element.value) return;
    restoreCaret.current = match.from + text.length;
    setValue(next);
  };
  useEffect(() => session.close, [session]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    if (restoreCaret.current !== null) {
      element.setSelectionRange(restoreCaret.current, restoreCaret.current);
      restoreCaret.current = null;
    }
    sync(element);
  }, [value, source]);

  return <>
    <textarea {...props} {...suggestionAria(id, state)} ref={input} value={value}
      onChange={event => { setValue(event.currentTarget.value); sync(event.currentTarget); }}
      onFocus={event => sync(event.currentTarget)} onSelect={event => sync(event.currentTarget)}
      onBlur={() => { composing.current = false; session.update(null, source); }}
      onCompositionStart={() => { composing.current = true; session.update(null, source); }}
      onCompositionEnd={event => { composing.current = false; sync(event.currentTarget); }}
      onKeyDown={event => {
        if (!composing.current && session.keyDown(event.nativeEvent, replace)) { event.preventDefault(); event.stopPropagation(); }
      }} />
    {state && <SuggestionMenu id={id} state={state} session={session} caret={() => input.current ? textareaCaret(input.current) : null} accept={index => session.choose(index, replace)} />}
  </>;
}
