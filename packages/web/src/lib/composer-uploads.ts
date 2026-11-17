import { ATTACHMENT_URL_PREFIX } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { attachmentProblem, imageCache } from "./images.js";

/** An image pasted, dropped or picked into the composer, uploading or uploaded. */
export interface ComposerUpload {
  key: string;
  name: string;
  file: Blob;
  status: "uploading" | "ready" | "failed";
  /** Attachment id once uploaded. */
  id?: string;
  error?: string;
  /** Local object URL for the thumbnail, available immediately. */
  preview?: string;
}

/**
 * Uploads live outside the editor document so a pill keeps its state across node switches, undo and
 * redo: the node only stores `key`, and the Markdown writer looks the attachment id up here.
 */
export class ComposerUploads {
  private readonly entries = new Map<string, ComposerUpload>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private serial = 0;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = (): number => this.version;
  get(key: string | null | undefined): ComposerUpload | undefined { return key ? this.entries.get(key) : undefined; }
  start(client: BatonClient, file: Blob, name: string): string {
    const key = `upload-${Date.now().toString(36)}-${++this.serial}`;
    const preview = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
    this.entries.set(key, { key, name, file, status: "uploading", preview });
    this.changed(); void this.run(client, key);
    return key;
  }
  retry(client: BatonClient, key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.status !== "failed") return;
    this.entries.set(key, { ...entry, status: "uploading", error: undefined });
    this.changed(); void this.run(client, key);
  }
  /** The Markdown URL for an image node: its own `src`, or the attachment its upload became. */
  src(attrs: Record<string, unknown>): string | null {
    if (typeof attrs.src === "string" && attrs.src) return attrs.src;
    const id = this.get(typeof attrs.key === "string" ? attrs.key : null)?.id;
    return id ? `${ATTACHMENT_URL_PREFIX}${id}` : null;
  }
  private async run(client: BatonClient, key: string): Promise<void> {
    const entry = this.entries.get(key); if (!entry) return;
    try {
      const record = await client.uploadAttachment(entry.file, entry.name);
      // The sent message shows the same bytes at once instead of fetching them back.
      imageCache(client).seed(`attachment:${record.id}`, entry.file);
      this.entries.set(key, { ...entry, status: "ready", id: record.id, error: undefined });
    } catch (cause) {
      this.entries.set(key, { ...entry, status: "failed", error: cause instanceof Error ? cause.message : String(cause) });
    }
    this.changed();
  }
  private changed(): void { this.version++; this.listeners.forEach(listener => listener()); }
}

export const composerUploads = new ComposerUploads();

/** Clipboard screenshots arrive as "image.png"; give them a readable name for the alt text. */
export function attachmentName(file: File | Blob): string {
  const name = "name" in file && typeof file.name === "string" ? file.name.trim() : "";
  if (name && !/^image\.(png|jpe?g|gif|webp)$/i.test(name)) return name;
  const extension = /\/(png|jpeg|gif|webp)$/.exec(file.type)?.[1]?.replace("jpeg", "jpg") ?? "png";
  return `截图.${extension}`;
}

/**
 * Which pasted/dropped/picked files become images, and what to tell the user about the rest. Agents
 * without `capabilities.images` take none: the hint says so and nothing is inserted.
 */
export function acceptImages<T extends Pick<Blob, "type" | "size">>(files: readonly T[], imagesEnabled: boolean): { accepted: T[]; hint: string | null } {
  if (!files.length) return { accepted: [], hint: null };
  if (!imagesEnabled) return { accepted: [], hint: "当前 agent 不支持图片" };
  const accepted: T[] = []; let hint: string | null = null;
  for (const file of files) { const problem = attachmentProblem(file); if (problem) hint ??= problem; else accepted.push(file); }
  return { accepted, hint };
}
