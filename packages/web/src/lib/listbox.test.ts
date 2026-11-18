import { describe, expect, it } from "vitest";
import { enabledIndex, filterOptions, initialActive, searchActive, isTypeAheadKey, keepUnlisted, moveActive, optionMatches, placePopover, popoverWidths, typeAhead, type SelectOption } from "./listbox.js";

const options: SelectOption[] = [
  { value: "", label: "默认" },
  { value: "alpha", label: "Alpha", description: "first letter" },
  { value: "beta", label: "Beta", disabled: true },
  { value: "bravo", label: "Bravo", keywords: "radio code" },
  { value: "charlie", label: "Charlie" },
  { value: "delta", label: "Delta", disabled: true },
  { value: "custom", label: "自定义…", pinned: true },
];

describe("listbox helpers", () => {
  it("searches labels, descriptions, values and keywords word by word and keeps pinned rows", () => {
    expect(optionMatches(options[1]!, "first alpha")).toBe(true); expect(optionMatches(options[1]!, "first beta")).toBe(false);
    expect(filterOptions(options, "radio").map(option => option.value)).toEqual(["bravo", "custom"]);
    expect(filterOptions(options, "CHAR").map(option => option.value)).toEqual(["charlie", "custom"]);
    expect(filterOptions(options, "  ")).toBe(options);
    expect(filterOptions(options, "zzz").map(option => option.value)).toEqual(["custom"]);
  });
  it("moves the active row past disabled rows without wrapping", () => {
    expect(enabledIndex(options, 2, 1)).toBe(3); expect(enabledIndex(options, 5, -1)).toBe(4); expect(enabledIndex([{ value: "x", label: "x", disabled: true }], 0, 1)).toBe(-1);
    expect(moveActive(options, 1, "ArrowDown")).toBe(3); expect(moveActive(options, 3, "ArrowUp")).toBe(1);
    expect(moveActive(options, 4, "ArrowDown")).toBe(6); expect(moveActive(options, 6, "ArrowDown")).toBe(6); expect(moveActive(options, 0, "ArrowUp")).toBe(0);
    expect(moveActive(options, -1, "ArrowDown")).toBe(0); expect(moveActive(options, -1, "ArrowUp")).toBe(6);
    expect(moveActive(options, 3, "Home")).toBe(0); expect(moveActive(options, 0, "End")).toBe(6);
    expect(moveActive(options, 0, "PageDown")).toBe(6); expect(moveActive(options, 6, "PageUp")).toBe(0);
    expect(moveActive([{ value: "a", label: "a", disabled: true }], -1, "ArrowDown")).toBe(-1);
  });
  it("opens on the selected row, or the first enabled one when the value is disabled or missing", () => {
    expect(initialActive(options, "charlie")).toBe(4); expect(initialActive(options, "beta")).toBe(0); expect(initialActive(options, "missing")).toBe(0);
    expect(initialActive([{ value: "a", label: "a", disabled: true }, { value: "b", label: "b" }], "a")).toBe(1);
  });
  it("moves the active row to the first real match while searching, not to a pinned row", () => {
    const listed: SelectOption[] = [{ value: "", label: "默认模型", pinned: true }, { value: "claude", label: "Claude Code", pinned: true }, { value: "gemini", label: "Gemini CLI", disabled: true }, { value: "codex", label: "Codex" }];
    expect(searchActive(filterOptions(listed, "c"), "c", "claude")).toBe(1);
    expect(searchActive(filterOptions(listed, "codex"), "codex", "claude")).toBe(2);
    expect(searchActive(filterOptions(listed, "zzz"), "zzz", "claude")).toBe(1);
    expect(searchActive(listed, "", "codex")).toBe(3);
  });
  it("types ahead by prefix, cycles on a repeated letter and skips disabled rows", () => {
    expect(typeAhead(options, "b", 0)).toBe(3); expect(typeAhead(options, "bb", 3)).toBe(3); expect(typeAhead(options, "br", 0)).toBe(3);
    expect(typeAhead(options, "c", 4)).toBe(4); expect(typeAhead(options, "a", 1)).toBe(1);
    expect(typeAhead(options, "d", 0)).toBe(-1); expect(typeAhead(options, "", 0)).toBe(-1); expect(typeAhead([], "a", -1)).toBe(-1);
    const twins: SelectOption[] = [{ value: "a1", label: "Apple" }, { value: "a2", label: "Apricot" }];
    expect(typeAhead(twins, "a", 0)).toBe(1); expect(typeAhead(twins, "aa", 1)).toBe(0); expect(typeAhead(twins, "apr", 0)).toBe(1);
    expect(isTypeAheadKey({ key: "a", ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
    expect(isTypeAheadKey({ key: "a", ctrlKey: false, metaKey: true, altKey: false })).toBe(false); expect(isTypeAheadKey({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
  });
  it("keeps a saved value the options do not carry, marked instead of dropped", () => {
    expect(keepUnlisted(options, "charlie")).toBe(options); expect(keepUnlisted(options, undefined)).toBe(options); expect(keepUnlisted(options, "")).toBe(options);
    expect(keepUnlisted(options, "plan").at(-1)).toEqual({ value: "plan", label: "plan", hint: "不在列表中", warning: "不在列表中", pinned: true, separated: true });
  });
  it("places the list under the trigger, above it when there is more room there, inside the viewport", () => {
    const viewport = { width: 800, height: 600 };
    expect(popoverWidths(120, 800, { minWidth: 240 })).toEqual({ min: 240, max: 420 }); expect(popoverWidths(500, 800)).toEqual({ min: 500, max: 500 }); expect(popoverWidths(900, 800)).toEqual({ min: 780, max: 780 }); expect(popoverWidths(100, 300)).toEqual({ min: 100, max: 280 });
    expect(placePopover({ anchor: { top: 100, bottom: 134, left: 40, right: 200 }, viewport, natural: 200, width: 240 })).toEqual({ side: "bottom", top: 138, left: 40, maxHeight: 200 });
    // Near the bottom-right: above the trigger, right edges aligned.
    expect(placePopover({ anchor: { top: 500, bottom: 534, left: 600, right: 750 }, viewport, natural: 300, width: 240 })).toEqual({ side: "top", top: 196, left: 510, maxHeight: 300 });
    // Clamped into the viewport.
    expect(placePopover({ anchor: { top: 100, bottom: 134, left: 700, right: 790 }, viewport, natural: 100, width: 300 }).left).toBe(490);
    expect(placePopover({ anchor: { top: 100, bottom: 134, left: 0, right: 100 }, viewport, natural: 100, width: 300 }).left).toBe(10);
    // Taller than the room on either side: the larger side, capped, scrolling inside.
    expect(placePopover({ anchor: { top: 200, bottom: 234, left: 0, right: 150 }, viewport, natural: 900, width: 200 })).toMatchObject({ side: "bottom", top: 238, left: 10, maxHeight: 340 });
  });
});
