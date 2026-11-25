import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useDismiss } from "../lib/dismiss.js";
import { quoteMarkdown, selectedBodyText, type QuoteSegment } from "../lib/quote.js";
import { Icon } from "./common.js";
import type { ComposerHandle } from "./composer-shell.js";
import "./selection-quote.css";

type Bounds = Pick<DOMRect, "left" | "right" | "top" | "bottom">;
const bodySelector = ".markdown, .tool-body, .agent-card-body";
const controlSelector = 'button, summary, input, select, textarea, [contenteditable], [role="button"], [role="toolbar"], .code-language';
const blockSelector = "p, pre, li, h1, h2, h3, h4, h5, h6, td, th, div, blockquote";

function* selectionSegments(scroll: HTMLElement, range: Range): Iterable<QuoteSegment<Element>> {
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      if (node instanceof Element) {
        if (node.matches(`${controlSelector}, [hidden], details:not([open])`)) return NodeFilter.FILTER_REJECT;
        return node.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let previousBody: Element | null = null, previousBlock: Element | null = null;
  for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
    const lineBreak = node instanceof HTMLBRElement;
    if (!(node instanceof Text) && !lineBreak) continue;
    const element = node instanceof Element ? node : node.parentElement;
    if (!element || element.closest(`${controlSelector}, [hidden], details:not([open])`)) continue;
    let body = element.closest(bodySelector);
    if (!body || !scroll.contains(body)) continue;
    for (let outer = body.parentElement?.closest(bodySelector); outer && scroll.contains(outer); outer = body.parentElement?.closest(bodySelector)) body = outer;
    const block = element.closest(blockSelector) ?? body;
    let separator = "";
    if (previousBody === body && previousBlock !== block) {
      const previousCell = previousBlock?.closest("td, th"), cell = block.closest("td, th");
      if (previousCell && cell && previousCell.closest("tr") === cell.closest("tr")) separator = "\t";
      else separator = previousBlock?.closest("li, tr, .diff") && block.closest("li, tr, .diff") ? "\n" : "\n\n";
    }
    const text = lineBreak ? "\n" : node.textContent ?? "";
    let start = range.startContainer === node ? range.startOffset : 0;
    if (!lineBreak && node.previousSibling instanceof HTMLBRElement && range.intersectsNode(node.previousSibling)) start = Math.max(start, /^\r?\n/.exec(text)?.[0].length ?? 0);
    const end = range.endContainer === node ? range.endOffset : text.length;
    if (start >= end) continue;
    const preserveWhitespace = lineBreak || /^(pre|pre-wrap|break-spaces)$/.test(getComputedStyle(element).whiteSpace);
    if (!preserveWhitespace && block !== previousBlock && !text.slice(start, end).trim()) continue;
    yield { text, body, start, end, separator, preserveWhitespace };
    previousBody = body;
    previousBlock = block;
  }
}

function readSelection(scroll: HTMLElement) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!scroll.contains(range.startContainer) || !scroll.contains(range.endContainer)) return null;
  const text = selectedBodyText(selectionSegments(scroll, range));
  return text.trim() ? { text, bounds: range.getBoundingClientRect() } : null;
}

export function selectionQuotePosition(bounds: Bounds, viewport: Bounds, button: Pick<DOMRect, "width" | "height">) {
  if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom || bounds.right <= viewport.left || bounds.left >= viewport.right) return null;
  const gap = 6, center = (Math.max(bounds.left, viewport.left) + Math.min(bounds.right, viewport.right)) / 2;
  const above = bounds.top - gap - button.height;
  return {
    left: Math.max(viewport.left + gap, Math.min(center - button.width / 2, viewport.right - gap - button.width)),
    top: above >= viewport.top + gap ? above : Math.min(bounds.bottom + gap, viewport.bottom - gap - button.height),
  };
}

export function SelectionQuote({ scroll, composer }: { scroll: RefObject<HTMLDivElement | null>; composer: RefObject<ComposerHandle | null> }) {
  const button = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<ReturnType<typeof readSelection>>(null);
  const hide = () => setSelection(null);
  useDismiss(Boolean(selection), button, reason => {
    if (reason === "escape" && document.activeElement === button.current) scroll.current?.focus({ preventScroll: true });
    hide();
  });

  useEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    const update = () => setSelection(readSelection(viewport));
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !viewport.contains(event.target) && event.target !== button.current) hide();
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("focusin", focus);
    viewport.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("focusin", focus);
      viewport.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [scroll]);

  useLayoutEffect(() => {
    const pill = button.current, viewport = scroll.current;
    if (!selection || !pill || !viewport) return;
    const position = selectionQuotePosition(selection.bounds, viewport.getBoundingClientRect(), pill.getBoundingClientRect());
    if (!position) return hide();
    pill.style.left = `${position.left}px`;
    pill.style.top = `${position.top}px`;
    const tabToPill = (event: KeyboardEvent) => {
      if (event.key === "Tab" && !event.defaultPrevented && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && (viewport.contains(document.activeElement) || document.activeElement === document.body)) {
        event.preventDefault();
        pill.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", tabToPill);
    return () => document.removeEventListener("keydown", tabToPill);
  }, [selection, scroll]);

  if (!selection) return null;
  return <button type="button" ref={button} className="selection-quote" aria-label="添加到对话"
    onMouseDown={event => event.preventDefault()} onClick={() => {
      if (!composer.current) return;
      document.getSelection()?.removeAllRanges();
      composer.current.insertQuote(quoteMarkdown(selection.text));
      hide();
    }}><Icon name="chat" size={14} />添加到对话</button>;
}
