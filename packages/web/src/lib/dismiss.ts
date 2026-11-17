import { useEffect, useRef, type RefObject } from "react";

/**
 * One rule for every dropdown in the console: a pointerdown anywhere outside closes it, and so does Escape.
 * - `<details>` menus need no code: `installMenuDismiss` watches the whole document for open ones. A `<details>`
 *   is a menu when it carries `data-menu` or a class ending in `-menu` (`project-menu`, `reasoning-bulk-menu`);
 *   inline disclosures (tool rows, reasoning blocks, 高级 sections) are left alone.
 * - Stateful popovers (agent picker, PR and background panels) call `useDismiss` with their anchor element.
 * Native `<select>` and modal `<dialog>`s already behave and are not involved.
 */
export const MENU_SELECTOR = 'details[data-menu], details[class*="-menu"]';
const OPEN_MENUS = 'details[data-menu][open], details[class*="-menu"][open]';

export type DismissReason = "pointer" | "escape";
type Container = { contains(node: Node | null): boolean };
type MenuRoot = Pick<Document, "querySelectorAll" | "activeElement" | "body">;

/** True when `target` is not inside `container` (a missing container has nothing to dismiss). */
export function isOutside(container: Container | null | undefined, target: EventTarget | null): boolean {
  return Boolean(container) && !container!.contains(target as Node | null);
}

function openMenus(root: Pick<Document, "querySelectorAll">): HTMLDetailsElement[] { return [...root.querySelectorAll<HTMLDetailsElement>(OPEN_MENUS)]; }

/** Closes every open menu the pointer landed outside of; the menu that holds the target stays open. */
export function closeMenusOutside(root: Pick<Document, "querySelectorAll">, target: EventTarget | null): number {
  const closing = openMenus(root).filter(menu => isOutside(menu, target));
  for (const menu of closing) menu.open = false;
  return closing.length;
}

/** Escape closes one menu — the innermost one holding focus, otherwise the last opened in document order — and returns focus to its summary when focus was inside it. */
export function closeMenuOnEscape(root: MenuRoot): HTMLDetailsElement | null {
  const menus = openMenus(root); const active = root.activeElement;
  const focused = active ? menus.filter(menu => menu.contains(active)).at(-1) : undefined;
  const menu = focused ?? menus.at(-1);
  if (!menu) return null;
  menu.open = false;
  if (focused || !active || active === root.body) menu.querySelector("summary")?.focus();
  return menu;
}

function escapeKey(event: KeyboardEvent): boolean { return event.key === "Escape" && !event.defaultPrevented && !event.isComposing; }

export function menuDismissHandlers(root: MenuRoot) {
  return {
    pointerdown: (event: Event) => { closeMenusOutside(root, event.target); },
    keydown: (event: KeyboardEvent) => {
      // One Escape closes one layer: a popover that already handled it wins, and the open menu stops the panel/sidebar listeners on window.
      if (!escapeKey(event)) return;
      if (closeMenuOnEscape(root)) { event.preventDefault(); event.stopPropagation(); }
    },
  };
}

type Listening = Pick<Document, "addEventListener" | "removeEventListener">;
function listen(target: Listening, handlers: { pointerdown: (event: Event) => void; keydown: (event: KeyboardEvent) => void }): () => void {
  // Capture the pointer so canvases that stop propagation (React Flow) still close menus; Escape bubbles so component handlers run first.
  target.addEventListener("pointerdown", handlers.pointerdown, true); target.addEventListener("keydown", handlers.keydown);
  return () => { target.removeEventListener("pointerdown", handlers.pointerdown, true); target.removeEventListener("keydown", handlers.keydown); };
}

/** Installs the document-wide `<details>` menu behaviour once at boot; returns the uninstaller. */
export function installMenuDismiss(root: MenuRoot & Listening = document): () => void { return listen(root, menuDismissHandlers(root)); }

export function dismissHandlers(container: () => Container | null | undefined, dismiss: (reason: DismissReason) => void, ignore: () => boolean = () => false) {
  return {
    pointerdown: (event: Event) => { if (!ignore() && isOutside(container(), event.target)) dismiss("pointer"); },
    keydown: (event: KeyboardEvent) => { if (!escapeKey(event) || ignore()) return; event.preventDefault(); event.stopPropagation(); dismiss("escape"); },
  };
}

/** While `open`, closes a popover on a pointerdown outside `inside` and on an Escape nobody else handled. `ignore` pauses it (e.g. a confirm dialog on top). */
export function useDismiss(open: boolean, inside: RefObject<HTMLElement | null>, dismiss: (reason: DismissReason) => void, ignore?: () => boolean): void {
  const latest = useRef({ dismiss, ignore });
  useEffect(() => { latest.current = { dismiss, ignore }; });
  useEffect(() => {
    if (!open) return;
    return listen(document, dismissHandlers(() => inside.current, reason => latest.current.dismiss(reason), () => latest.current.ignore?.() ?? false));
  }, [open, inside]);
}
