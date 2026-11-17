import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { closeMenuOnEscape, closeMenusOutside, dismissHandlers, installMenuDismiss, isOutside, menuDismissHandlers } from "./dismiss.js";
import { ReasoningControls } from "../components/ReasoningControls.js";

/** A tiny DOM stand-in whose querySelectorAll really evaluates `tag[attr]` / `tag[attr*="x"]` selector lists. */
class FakeElement {
  parent: FakeElement | null = null; children: FakeElement[] = []; open = false;
  constructor(readonly tag: string, readonly attributes: Record<string, string> = {}, readonly doc?: FakeDocument) {}
  append(...children: FakeElement[]): this { for (const child of children) { child.parent = this; this.children.push(child); } return this; }
  contains(node: unknown): boolean { for (let current = node as FakeElement | null; current; current = current.parent) if (current === this) return true; return false; }
  descendants(): FakeElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(selector: string): FakeElement | null { return this.descendants().find(element => element.tag === selector) ?? null; }
  focus(): void { root.activeElement = this; }
  matches(selector: string): boolean {
    return selector.split(",").some(part => {
      const [, tag, rest] = /^\s*(\w+)(.*)$/.exec(part)!;
      if (tag !== this.tag) return false;
      return [...rest!.matchAll(/\[([\w-]+)(?:\*="([^"]*)")?\]/g)].every(([, name, fragment]) => name === "open" ? this.open : fragment === undefined ? name! in this.attributes : (this.attributes[name!] ?? "").includes(fragment));
    });
  }
}
class FakeDocument {
  body = new FakeElement("body"); activeElement: FakeElement | null = this.body;
  querySelectorAll(selector: string): FakeElement[] { return this.body.descendants().filter(element => element.matches(selector)); }
}
let root = new FakeDocument();
function menu(className: string, extra: Record<string, string> = {}) {
  const summary = new FakeElement("summary"); const item = new FakeElement("button");
  const details = new FakeElement("details", { class: className, ...extra }).append(summary, new FakeElement("div").append(item));
  details.open = true; return { details, summary, item };
}
function page() {
  root = new FakeDocument();
  const project = menu("project-menu"); const bulk = menu("reasoning-bulk-menu"); const marked = menu("anything", { "data-menu": "" });
  const disclosure = menu("tool-row tool-completed"); const textarea = new FakeElement("textarea");
  root.body.append(project.details, bulk.details, marked.details, disclosure.details, textarea);
  return { project, bulk, marked, disclosure, textarea, doc: root as unknown as Document };
}
const key = (init: Partial<KeyboardEvent> = {}) => ({ key: "Escape", defaultPrevented: false, isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...init }) as unknown as KeyboardEvent;

describe("close on outside click", () => {
  it("knows inside from outside", () => {
    const { project, bulk } = page();
    expect(isOutside(project.details, project.item)).toBe(false);
    expect(isOutside(project.details, bulk.item)).toBe(true);
    expect(isOutside(null, bulk.item)).toBe(false);
  });
  it("closes every open menu except the one that was clicked, and never touches inline disclosures", () => {
    const { project, bulk, marked, disclosure, doc } = page();
    expect(closeMenusOutside(doc, project.item)).toBe(2);
    expect([project.details.open, bulk.details.open, marked.details.open, disclosure.details.open]).toEqual([true, false, false, true]);
    expect(closeMenusOutside(doc, root.body)).toBe(1);
    expect(project.details.open).toBe(false); expect(disclosure.details.open).toBe(true);
    expect(closeMenusOutside(doc, root.body)).toBe(0);
  });
  it("Escape closes the menu holding focus first and returns focus to its summary", () => {
    const { project, bulk, marked, doc } = page();
    project.item.focus();
    expect(closeMenuOnEscape(doc)).toBe(project.details as unknown as HTMLDetailsElement);
    expect(project.details.open).toBe(false); expect(root.activeElement).toBe(project.summary); expect(bulk.details.open).toBe(true);
    root.activeElement = root.body;
    closeMenuOnEscape(doc);
    expect(marked.details.open).toBe(false); expect(root.activeElement).toBe(marked.summary);
  });
  it("Escape with focus elsewhere closes the last menu without stealing focus", () => {
    const { bulk, marked, textarea, doc } = page();
    root.activeElement = textarea;
    closeMenuOnEscape(doc);
    expect(marked.details.open).toBe(false); expect(bulk.details.open).toBe(true); expect(root.activeElement).toBe(textarea);
  });
  it("the document handler swallows only the Escape that closed a menu", () => {
    const { project, bulk, marked, doc } = page();
    const handlers = menuDismissHandlers(doc);
    const handled = key(); handlers.keydown(handled);
    expect(marked.details.open).toBe(false); expect(handled.preventDefault).toHaveBeenCalled(); expect(handled.stopPropagation).toHaveBeenCalled();
    for (const ignored of [key({ defaultPrevented: true }), key({ isComposing: true }), key({ key: "Enter" })]) { handlers.keydown(ignored); expect(ignored.preventDefault).not.toHaveBeenCalled(); }
    expect(bulk.details.open).toBe(true);
    handlers.pointerdown({ target: root.body } as unknown as Event);
    expect(project.details.open).toBe(false); expect(bulk.details.open).toBe(false);
    const nothingOpen = key(); handlers.keydown(nothingOpen);
    expect(nothingOpen.stopPropagation).not.toHaveBeenCalled();
  });
  it("installs one capture-phase pointer listener and an Escape listener, and removes them", () => {
    const { doc } = page(); const target = new EventTarget();
    const added = vi.spyOn(target, "addEventListener"); const removed = vi.spyOn(target, "removeEventListener");
    const uninstall = installMenuDismiss(Object.assign(doc, { addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target) }));
    expect(added.mock.calls.map(([type, , options]) => [type, options])).toEqual([["pointerdown", true], ["keydown", undefined]]);
    uninstall();
    expect(removed.mock.calls.map(([type]) => type)).toEqual(["pointerdown", "keydown"]);
  });
  it("stateful popovers dismiss on an outside pointer or an unhandled Escape, unless paused", () => {
    const { project, bulk } = page(); const dismiss = vi.fn(); let paused = false;
    const handlers = dismissHandlers(() => project.details, dismiss, () => paused);
    handlers.pointerdown({ target: project.item } as unknown as Event); expect(dismiss).not.toHaveBeenCalled();
    handlers.pointerdown({ target: bulk.item } as unknown as Event); expect(dismiss).toHaveBeenLastCalledWith("pointer");
    const escape = key(); handlers.keydown(escape); expect(dismiss).toHaveBeenLastCalledWith("escape"); expect(escape.preventDefault).toHaveBeenCalled();
    dismiss.mockClear(); handlers.keydown(key({ defaultPrevented: true })); handlers.keydown(key({ key: "a" }));
    paused = true; handlers.pointerdown({ target: bulk.item } as unknown as Event); handlers.keydown(key());
    expect(dismiss).not.toHaveBeenCalled();
  });
  it("marks the console's details menus so the document handler picks them up", () => {
    expect(renderToStaticMarkup(<ReasoningControls rows={[]} />)).toContain('<details class="reasoning-bulk-menu" data-menu="true">');
  });
});
