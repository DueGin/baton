import type { ReactNode } from "react";

/** One entry of the console's shared dropdown (`Select`, and the agent and model pickers built on it). */
export interface SelectOption {
  value: string;
  /** Shown in the list and on the trigger; type-ahead and search match it. */
  label: string;
  /** Secondary text under the label (model id, agent kind and version, …). */
  description?: string;
  /** Short note at the right edge of the row (默认, 未安装, 不在列表中). */
  hint?: string;
  /** Leading icon, e.g. an agent mark. */
  icon?: ReactNode;
  disabled?: boolean;
  /** Shown on the trigger, in amber, while this option is the value: the value needs attention (不可用, 不在列表中). */
  warning?: string;
  /** Extra text the search matches (an agent's model ids, notes, …). */
  keywords?: string;
  /** Stays listed whatever the search is (an action such as 自定义…, or the current value). */
  pinned?: boolean;
  /** Draws a separator above the row. */
  separated?: boolean;
  /** Indentation level for tree-shaped lists (the conversation node selector). */
  depth?: number;
}

/** A saved value none of the options carry (an old preset, a changed catalog) stays listed — marked — instead of vanishing. */
export function keepUnlisted(options: SelectOption[], value: string | undefined, note = "不在列表中"): SelectOption[] {
  return !value || options.some(option => option.value === value) ? options : [...options, { value, label: value, hint: note, warning: note, pinned: true, separated: true }];
}

/** Lists longer than this get a search box. */
export const SEARCH_THRESHOLD = 8;
/** Keys typed within this window extend one type-ahead search. */
export const TYPE_AHEAD_MS = 600;

const haystack = (option: SelectOption): string => [option.label, option.description, option.value, option.hint, option.keywords].filter(Boolean).join(" ").toLowerCase();

/** Every whitespace-separated word of `query` occurs in the option's label, description, value, hint or keywords. */
export function optionMatches(option: SelectOption, query: string): boolean {
  const text = haystack(option);
  return query.trim().toLowerCase().split(/\s+/).every(word => text.includes(word));
}

/** The options a search shows: the matches plus the pinned rows, in their original order. */
export function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  if (!query.trim()) return options;
  return options.filter(option => option.pinned || optionMatches(option, query));
}

/** The first enabled index at or after `from` walking by `step`, or -1. */
export function enabledIndex(options: SelectOption[], from: number, step: 1 | -1): number {
  for (let index = from; index >= 0 && index < options.length; index += step) if (!options[index]!.disabled) return index;
  return -1;
}

export type NavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";
export const navigationKeys: readonly string[] = ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"];
const PAGE = 8;

/** Moves the active row for a navigation key, skipping disabled rows and stopping at the ends (no wrap-around). */
export function moveActive(options: SelectOption[], current: number, key: NavigationKey): number {
  const last = options.length - 1;
  const first = enabledIndex(options, 0, 1); const final = enabledIndex(options, last, -1);
  if (first < 0) return -1;
  if (key === "Home") return first;
  if (key === "End") return final;
  if (current < 0 || current > last) return key === "ArrowUp" || key === "PageUp" ? final : first;
  const down = key === "ArrowDown" || key === "PageDown";
  const distance = key === "PageDown" || key === "PageUp" ? PAGE : 1;
  const target = Math.max(0, Math.min(last, current + (down ? distance : -distance)));
  const found = enabledIndex(options, target, down ? 1 : -1);
  if (found >= 0) return found;
  // Nothing enabled beyond the target: stay on the nearest enabled row in that direction (or where we are).
  const back = enabledIndex(options, target, down ? -1 : 1);
  return back >= 0 && (down ? back >= current : back <= current) ? back : current;
}

/** Where the active row starts when the list opens: the selected value if it can be chosen, else the first enabled row. */
export function initialActive(options: SelectOption[], value: string): number {
  const selected = options.findIndex(option => option.value === value && !option.disabled);
  return selected >= 0 ? selected : enabledIndex(options, 0, 1);
}

/**
 * Type-ahead: the next enabled row whose label starts with `typed`. Repeating one character ("ddd") cycles through the
 * rows starting with it; a longer prefix may stay on the current row while it still matches.
 */
export function typeAhead(options: SelectOption[], typed: string, current: number): number {
  const needle = typed.toLowerCase(); if (!needle || !options.length) return -1;
  const repeated = [...needle].every(character => character === needle[0]);
  const prefix = repeated ? needle[0]! : needle;
  const start = repeated ? current + 1 : Math.max(0, current);
  for (let offset = 0; offset < options.length; offset++) {
    const index = (start + offset + options.length) % options.length; const option = options[index]!;
    if (!option.disabled && option.label.toLowerCase().startsWith(prefix)) return index;
  }
  return -1;
}

/** A printable key that should feed type-ahead or the search box (not a shortcut). */
export function isTypeAheadKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** The list's width range: never narrower than its trigger (or `minWidth`), never wider than `maxWidth` or the viewport. */
export function popoverWidths(anchorWidth: number, viewportWidth: number, { minWidth = 0, maxWidth = 420, margin = 10 }: { minWidth?: number; maxWidth?: number; margin?: number } = {}): { min: number; max: number } {
  const max = Math.min(maxWidth, Math.max(0, viewportWidth - margin * 2));
  return { min: Math.min(max, Math.max(anchorWidth, minWidth)), max };
}

export interface PopoverPlacement { top: number; left: number; maxHeight: number; side: "bottom" | "top" }

/**
 * Places a list under its trigger, or above it when it does not fit below and there is more room above, inside the
 * viewport with a margin. `natural` is the list's full content height and `width` its rendered width.
 */
export function placePopover({ anchor, viewport, natural, width, maxHeight = 340, gap = 4, margin = 10 }: { anchor: { top: number; bottom: number; left: number }; viewport: { width: number; height: number }; natural: number; width: number; maxHeight?: number; gap?: number; margin?: number }): PopoverPlacement {
  const wanted = Math.min(natural, maxHeight);
  const below = viewport.height - anchor.bottom - gap - margin; const above = anchor.top - gap - margin;
  const side = below >= wanted || below >= above ? "bottom" : "top";
  // Squeezed against the viewport edge, still show a few rows (the page can scroll).
  const height = Math.max(Math.min(wanted, side === "bottom" ? below : above), Math.min(wanted, 96));
  const left = Math.max(margin, Math.min(viewport.width - width - margin, anchor.left));
  return { side, left, maxHeight: height, top: side === "bottom" ? anchor.bottom + gap : Math.max(margin, anchor.top - gap - height) };
}
