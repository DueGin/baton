import light from "highlight.js/styles/github.css?inline";
import dark from "highlight.js/styles/github-dark.css?inline";
function scope(css: string, theme: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/([^{}]+)\{/g, (_match, selectors: string) => selectors.split(",").map(selector => `.theme-${theme} ${selector.trim()}`).join(",") + "{");
}
/** Theme assets are local imports; only static library CSS is inserted here. */
export const highlightStyles = scope(light, "light") + scope(dark, "dark");
