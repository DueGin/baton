import { useSyncExternalStore } from "react";
export type ColorTheme = "light" | "dark";
const listeners = new Set<() => void>();
let cleanup: (() => void) | undefined;
function getTheme(): ColorTheme {
  const selected = document.documentElement.dataset.theme;
  return selected === "dark" || (selected !== "light" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!cleanup) {
    const emit = () => listeners.forEach(callback => callback());
    const media = matchMedia("(prefers-color-scheme: dark)"); media.addEventListener("change", emit);
    const observer = new MutationObserver(emit); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    cleanup = () => { observer.disconnect(); media.removeEventListener("change", emit); cleanup = undefined; };
  }
  return () => { listeners.delete(listener); if (!listeners.size) cleanup?.(); };
}
export function useColorTheme(): ColorTheme { return useSyncExternalStore(subscribe, getTheme, () => "light"); }
