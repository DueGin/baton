import { useEffect, useId, useRef, useState, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import type { ColorTheme } from "../lib/theme.js";
import { renderReadyDiagram, namespaceSvg } from "../lib/mermaid.js";
import { CopyButton } from "./CopyButton.js";

export function MermaidBlock({ code, complete, stable, theme }: { code: string; complete: boolean; stable: boolean; theme: ColorTheme }) {
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const modal = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState<{ code: string; theme: ColorTheme; svg?: string; error?: string }>();
  const [source, setSource] = useState(false); const [fullscreen, setFullscreen] = useState(false); const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const rendering = renderReadyDiagram(code, theme, complete, stable ? 500 : 0);
    if (!rendering) return;
    let active = true;
    void rendering.then(svg => { if (active) setRendered({ code, theme, svg: namespaceSvg(svg, instanceId) }); }).catch((cause: unknown) => { if (active) setRendered({ code, theme, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; };
  }, [code, complete, stable, theme, instanceId]);
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
      if (event.key === "Tab") {
        const elements = modal.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        const first = elements?.[0]; const last = elements?.[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", close); return () => { document.removeEventListener("keydown", close); previous?.focus(); };
  }, [fullscreen]);
  const current = complete && stable && rendered?.code === code && rendered.theme === theme ? rendered : undefined;
  const image = (large = false) => <div className={`mermaid-svg${large ? " mermaid-svg-large" : ""}`} style={large ? { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` } : undefined}
    // Only sanitized SVG returned by renderDiagram may enter this sink.
    dangerouslySetInnerHTML={{ __html: large ? namespaceSvg(current?.svg ?? "", `${instanceId}-fullscreen`) : current?.svg ?? "" }} />;
  const wheel = (event: WheelEvent) => { setZoom(value => Math.max(.2, Math.min(4, value * (event.deltaY > 0 ? .9 : 1.1)))); };
  return <div className="code-block mermaid-block"><div className="code-language"><span>mermaid</span><div className="diagram-toolbar"><button type="button" className="text-button" onClick={() => setSource(value => !value)}>{source ? "图" : "源码"}</button><button type="button" className="text-button" disabled={!current?.svg} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); setFullscreen(true); }}>全屏</button><CopyButton text={code} /></div></div>
    {current?.svg && !source ? image() : <><pre><code>{code}</code></pre>{!current?.error && !source && <div className="diagram-pending">{complete ? "图表生成中…" : "图表生成中 · 等待代码围栏闭合"}</div>}</>}
    {current?.error && <div className="diagram-error" role="status">图表无法生成：{current.error}</div>}
    {fullscreen && createPortal(<div className="diagram-modal-backdrop" role="dialog" aria-modal="true" aria-label="Mermaid 全屏图表"><div className="diagram-modal" ref={modal}><div className="diagram-modal-toolbar"><strong>Mermaid</strong><button className="button small" onClick={() => setZoom(value => Math.max(.2, value - .2))}>−</button><span>{Math.round(zoom * 100)}%</span><button className="button small" onClick={() => setZoom(value => Math.min(4, value + .2))}>＋</button><button className="button small" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>重置</button><CopyButton text={code} /><button className="button small" autoFocus onClick={() => setFullscreen(false)}>关闭 Esc</button></div><div className="diagram-pan" onWheel={wheel} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setPan(value => ({ x: value.x + event.movementX, y: value.y + event.movementY })); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>{image(true)}</div></div></div>, document.body)}
  </div>;
}
