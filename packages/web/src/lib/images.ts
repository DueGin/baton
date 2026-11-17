import { createContext, useContext, useEffect, useState } from "react";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_TYPES, ATTACHMENT_URL_PREFIX } from "@baton/protocol";
import type { BatonClient } from "../api.js";

/** Where an image in Markdown comes from. Only these kinds are ever put into an `<img src>`. */
export type ImageSource =
  | { kind: "attachment"; id: string }
  | { kind: "local"; path: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

const ATTACHMENT_ID = /^[A-Za-z0-9_.-]{1,160}$/;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

function decode(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}
function localImage(path: string): ImageSource | null {
  return IMAGE_FILE.test(path) && !/[\u0000-\u001f\u007f]/.test(path) ? { kind: "local", path } : null;
}
/** Join a relative path onto an absolute directory, resolving `.` and `..` (never above the root). */
export function joinPath(directory: string, relative: string): string {
  const windows = WINDOWS_ABSOLUTE.test(directory);
  const separator = windows ? "\\" : "/";
  const root = windows ? directory.slice(0, 2) : "";
  const parts = (windows ? directory.slice(2) : directory).split(/[\\/]+/).filter(Boolean);
  for (const segment of relative.split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop(); else parts.push(segment);
  }
  return `${root}${separator}${parts.join(separator)}`;
}

/**
 * Classify a Markdown image URL. react-markdown hands over the URL percent-encoded (non-ASCII,
 * spaces), so local paths are decoded before they reach `/api/files/image`. Relative paths resolve
 * against `cwd` when one is known; anything that is not an attachment marker, an image file path, an
 * http(s) URL or a base64 PNG/JPEG/GIF/WebP data URL is refused (the caller shows a link instead).
 */
export function imageSource(raw: string | null | undefined, cwd?: string): ImageSource | null {
  const src = (raw ?? "").trim();
  if (!src || /[\u0000-\u001f\u007f]/.test(src)) return null;
  if (src.toLowerCase().startsWith(ATTACHMENT_URL_PREFIX)) {
    const id = src.slice(ATTACHMENT_URL_PREFIX.length);
    return ATTACHMENT_ID.test(id) ? { kind: "attachment", id } : null;
  }
  if (/^https?:\/\//i.test(src)) return /\s/.test(src) ? null : { kind: "remote", url: src };
  if (/^data:/i.test(src)) return DATA_IMAGE.test(src) ? { kind: "data", url: src } : null;
  if (/^file:/i.test(src)) {
    const match = /^file:\/\/(?:localhost)?(\/[^?#]*)$/i.exec(src);
    const path = match ? decode(match[1]!) : null;
    if (!path) return null;
    return localImage(/^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path);
  }
  // Any other scheme (javascript:, blob:, mailto:, vbscript:, …); a drive letter is not a scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !WINDOWS_ABSOLUTE.test(src)) return null;
  const path = decode(src);
  if (!path || path.startsWith("//") || path.startsWith("\\\\") || path.startsWith("~")) return null;
  if (path.startsWith("/") || WINDOWS_ABSOLUTE.test(path)) return localImage(path);
  return cwd && (cwd.startsWith("/") || WINDOWS_ABSOLUTE.test(cwd)) ? localImage(joinPath(cwd, path)) : null;
}

/** Cache key for sources that need an authenticated fetch. */
export function imageKey(source: ImageSource): string {
  return source.kind === "attachment" ? `attachment:${source.id}` : source.kind === "local" ? `file:${source.path}` : source.url;
}

interface CacheEntry { refs: number; promise: Promise<string>; url?: string; timer?: ReturnType<typeof setTimeout> }
/**
 * Object URLs for authenticated image fetches, shared per key. Mounted images hold a lease; an entry
 * nobody holds lingers briefly (scrolling, re-renders, node switches) and is then revoked.
 */
export class ImageUrlCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly linger = 60_000) {}
  acquire(key: string, load: () => Promise<Blob>): { promise: Promise<string>; release: () => void } {
    let entry = this.entries.get(key);
    if (!entry) {
      const created: CacheEntry = { refs: 0, promise: Promise.resolve("") };
      created.promise = load().then(blob => { const url = URL.createObjectURL(blob); created.url = url; return url; });
      created.promise.catch(() => { if (this.entries.get(key) === created) { clearTimeout(created.timer); this.entries.delete(key); } });
      this.entries.set(key, created); entry = created;
    }
    const held = entry;
    clearTimeout(held.timer); held.timer = undefined; held.refs++;
    let released = false;
    return {
      promise: held.promise,
      release: () => {
        if (released) return; released = true; held.refs--;
        if (held.refs <= 0 && this.entries.get(key) === held) held.timer = setTimeout(() => this.evict(key, held), this.linger);
      },
    };
  }
  /** Prime the cache with bytes already in hand (a just-uploaded image), so its message shows at once. */
  seed(key: string, blob: Blob): void {
    if (this.entries.has(key)) return;
    const url = URL.createObjectURL(blob);
    const entry: CacheEntry = { refs: 0, url, promise: Promise.resolve(url) };
    this.entries.set(key, entry); entry.timer = setTimeout(() => this.evict(key, entry), this.linger * 5);
  }
  has(key: string): boolean { return this.entries.has(key); }
  private evict(key: string, entry: CacheEntry): void {
    if (this.entries.get(key) !== entry || entry.refs > 0) return;
    this.entries.delete(key);
    if (entry.url) URL.revokeObjectURL(entry.url);
    else entry.promise.then(url => URL.revokeObjectURL(url), () => undefined);
  }
}

const caches = new WeakMap<BatonClient, ImageUrlCache>();
export function imageCache(client: BatonClient): ImageUrlCache {
  let cache = caches.get(client);
  if (!cache) { cache = new ImageUrlCache(); caches.set(client, cache); }
  return cache;
}

/** Who can fetch authenticated images, and the directory relative image paths resolve against. */
export interface ImageContextValue { client?: BatonClient; cwd?: string }
export const ImageContext = createContext<ImageContextValue>({});
export function useImageContext(): ImageContextValue { return useContext(ImageContext); }

export type ImageState = { status: "loading" } | { status: "ready"; url: string } | { status: "failed" };
/** An `<img src>` for a source: direct for http(s)/data, an object URL from a Bearer fetch otherwise. */
export function useImageUrl(source: ImageSource | null, client?: BatonClient): ImageState {
  const key = source ? imageKey(source) : "";
  const remote = source?.kind === "remote" || source?.kind === "data";
  const [loaded, setLoaded] = useState<{ key: string; state: ImageState } | null>(null);
  useEffect(() => {
    if (!source || remote || !client) return;
    const lease = imageCache(client).acquire(key, () => source.kind === "attachment" ? client.attachmentBlob(source.id) : client.localImageBlob(source.kind === "local" ? source.path : ""));
    let active = true;
    lease.promise.then(url => { if (active) setLoaded({ key, state: { status: "ready", url } }); }, () => { if (active) setLoaded({ key, state: { status: "failed" } }); });
    return () => { active = false; lease.release(); };
    // `key` identifies the source; the object itself is rebuilt on every render.
  }, [key, client, remote]);
  if (!source) return { status: "failed" };
  if (source.kind === "remote" || source.kind === "data") return { status: "ready", url: source.url };
  if (!client) return { status: "failed" };
  return loaded?.key === key ? loaded.state : { status: "loading" };
}

export const IMAGE_ACCEPT = ATTACHMENT_MIME_TYPES.join(",");
/** Why a file cannot be attached, or null when it can. */
export function attachmentProblem(file: Pick<Blob, "type" | "size">): string | null {
  if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) return "仅支持 PNG、JPEG、GIF、WebP 图片";
  if (file.size > ATTACHMENT_MAX_BYTES) return `图片超过 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB`;
  return null;
}
