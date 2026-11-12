import { diagramReady } from "./markdown.js";
import type { ColorTheme } from "./theme.js";
const cache = new Map<string, string>();
let serial = 0;
let queue: Promise<unknown> = Promise.resolve();
let initializedTheme: ColorTheme | undefined;
/** Mermaid mutates a singleton configuration, so renders are serialized across blocks/themes. */
export function renderDiagram(code: string, theme: ColorTheme): Promise<string> {
  const key = `${theme}\0${code}`;
  const cached = cache.get(key); if (cached) return Promise.resolve(cached);
  const task = queue.catch(() => undefined).then(async () => {
    const already = cache.get(key); if (already) return already;
    const [{ default: mermaid }, { default: purify }] = await Promise.all([import("mermaid"), import("dompurify")]);
    if (initializedTheme !== theme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default", suppressErrorRendering: true, flowchart: { htmlLabels: false } });
      initializedTheme = theme;
    }
    const id = `baton-diagram-${++serial}`;
    const { svg } = await mermaid.render(id, code);
    const clean = purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject", "script"], FORBID_ATTR: ["onload", "onclick", "onerror"], ADD_TAGS: ["style"] });
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, clean); return clean;
  });
  queue = task; return task;
}

/** Namespace cached SVG ids per mounted block, including paint servers and accessibility references. */
export function namespaceSvg(svg: string, instance: string): string {
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!);
  let result = svg;
  for (const id of [...new Set(ids)].sort((a, b) => b.length - a.length)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "g"), `${instance}-${id}`);
  }
  return result;
}

export function renderReadyDiagram(code: string, theme: ColorTheme, complete: boolean, stableForMs: number): Promise<string> | null {
  return diagramReady(complete, stableForMs) ? renderDiagram(code, theme) : null;
}
