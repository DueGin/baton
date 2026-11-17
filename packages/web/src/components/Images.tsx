import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AttachmentRef } from "@baton/protocol";
import { imageSource, useImageContext, useImageUrl, type ImageSource } from "../lib/images.js";
import { safeLink } from "../lib/markdown.js";

/** Full-size view; Esc, a click anywhere or the close button dismisses it and focus returns. */
export function ImageLightbox({ url, alt, close }: { url: string; alt: string; close: () => void }) {
  const overlay = useRef<HTMLDivElement>(null);
  const latestClose = useRef(close); latestClose.current = close;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); latestClose.current(); } };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); previous?.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<div ref={overlay} className="image-lightbox" role="dialog" aria-modal="true" aria-label={alt ? `图片：${alt}` : "图片预览"} tabIndex={-1} onClick={event => { event.stopPropagation(); close(); }}>
    <img src={url} alt={alt} referrerPolicy="no-referrer" />
    {alt && <span className="image-lightbox-caption">{alt}</span>}
    <button type="button" className="image-lightbox-close" aria-label="关闭预览">×</button>
  </div>, document.body);
}

/** A clickable thumbnail; while an authenticated fetch is in flight it reserves the space. */
export function ImageThumb({ source, alt, fallback, width, height, className = "" }: { source: ImageSource; alt: string; fallback: ReactNode; width?: number; height?: number; className?: string }) {
  const { client } = useImageContext();
  const state = useImageUrl(source, client);
  const [broken, setBroken] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const ratio = width && height ? { aspectRatio: `${width} / ${height}` } : undefined;
  if (state.status === "failed" || (state.status === "ready" && broken === state.url)) return <>{fallback}</>;
  if (state.status === "loading") return <span className={`image-thumb is-loading ${className}`} style={ratio} role="img" aria-label={`${alt || "图片"}（加载中）`} />;
  return <>
    <button type="button" className={`image-thumb ${className}`} title={alt || "查看图片"} aria-label={`查看图片${alt ? `：${alt}` : ""}`} onClick={() => setOpen(true)}>
      <img src={state.url} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" width={width} height={height} onError={() => setBroken(state.url)} />
    </button>
    {open && <ImageLightbox url={state.url} alt={alt} close={() => setOpen(false)} />}
  </>;
}

/** The fallback is the pre-image behaviour: http(s) images become a link, everything else its alt text. */
function imageFallback(src: string | undefined, alt: string): ReactNode {
  const link = src ? safeLink(src) : undefined;
  return link ? <a href={link} target="_blank" rel="noopener noreferrer">{alt || "图片"}</a> : <span className="image-fallback" title={alt || undefined}>{alt || "图片"}</span>;
}

/** `img` for parsed Markdown image nodes only; raw HTML never reaches this. */
export function MarkdownImage({ src, alt = "", cwd }: { src?: string; alt?: string; cwd?: string }) {
  const context = useImageContext();
  const source = imageSource(src, cwd ?? context.cwd);
  const fallback = imageFallback(src, alt);
  return source ? <ImageThumb source={source} alt={alt} fallback={fallback} className="markdown-image" /> : <>{fallback}</>;
}

/** Screenshots and image reads a tool returned, shown under its row even while the row is collapsed. */
export function ToolImages({ images }: { images: AttachmentRef[] }) {
  return <div className="tool-images" aria-label="工具返回的图片">{images.map(image => <ImageThumb key={image.id} source={{ kind: "attachment", id: image.id }} alt={image.name ?? "图片"} width={image.width} height={image.height} className="tool-image" fallback={<span className="image-fallback">{image.name ?? "图片"}</span>} />)}</div>;
}
