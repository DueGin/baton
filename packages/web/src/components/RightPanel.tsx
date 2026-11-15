import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { clampPanelWidth, panelDefaultWidth, panelMaxWidth, readPanelWidth, savePanelWidth } from "../lib/panel-width.js";
export function RightPanel({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState(() => readPanelWidth(localStorage)); const [viewport, setViewport] = useState(window.innerWidth);
  const panel = useRef<HTMLDivElement>(null); const dragging = useRef(false); const width = clampPanelWidth(preference, viewport);
  useEffect(() => { savePanelWidth(localStorage, preference); }, [preference]);
  useEffect(() => { const resize = () => setViewport(window.innerWidth); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const max = panelMaxWidth(viewport); const min = Math.min(280, max);
  return <div ref={panel} className="resizable-right-panel" style={{ "--right-panel-width": `${width}px` } as CSSProperties}>
    <div className="right-panel-resizer" role="separator" aria-label="调整详情侧栏宽度" aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} tabIndex={0} title="拖动调整宽度；双击恢复 320px；方向键微调"
      onDoubleClick={() => setPreference(panelDefaultWidth)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); setPreference(event.key === "Home" ? min : event.key === "End" ? max : clampPanelWidth(width + (event.key === "ArrowLeft" ? 1 : -1) * (event.shiftKey ? 40 : 10), viewport)); } }}
      onPointerDown={event => { if (event.button !== 0) return; dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
      onPointerMove={event => { if (dragging.current) setPreference(clampPanelWidth((panel.current?.getBoundingClientRect().right ?? viewport) - event.clientX, viewport)); }}
      onPointerUp={event => { dragging.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragging.current = false; }} />
    {children}
  </div>;
}
