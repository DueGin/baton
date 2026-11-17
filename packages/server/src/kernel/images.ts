/**
 * Images inside human messages. The composer writes each image as `![name](attachment:<id>)` at
 * the cursor position; the stored user_message keeps that text. On delivery the kernel turns it
 * into ordered text/image parts for drivers with capabilities.images, or into text where each
 * marker becomes "[图片 name: /absolute/path]" so tool-using agents can still open the file.
 */
import { ATTACHMENT_URL_PREFIX } from "@baton/protocol";
import type { PromptInput, PromptPart } from "../driver/types.js";

export type MarkerSegment = { type: "text"; text: string } | { type: "attachment"; id: string; name: string };
/** A stored attachment as the kernel needs it for delivery. */
export interface AttachmentFile { path: string; mimeType: string; name?: string }
export type AttachmentLookup = (id: string) => AttachmentFile | undefined;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `![alt](attachment:id)`; alt may contain backslash escapes such as `\]`. */
const MARKER = new RegExp(`!\\[((?:\\\\.|[^\\\\\\]])*)\\]\\(${escapeRegExp(ATTACHMENT_URL_PREFIX)}([A-Za-z0-9_-]+)\\)`, "g");

export function parseAttachmentMarkers(text: string): MarkerSegment[] {
  const segments: MarkerSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    if (match.index > last) segments.push({ type: "text", text: text.slice(last, match.index) });
    segments.push({ type: "attachment", id: match[2]!, name: match[1]!.replace(/\\(.)/g, "$1").trim() });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: "text", text: text.slice(last) });
  return segments;
}

const ANY_MARKER = new RegExp(MARKER.source);
export function hasAttachmentMarkers(text: string): boolean { return ANY_MARKER.test(text); }

/** "[图片 name: /path]" — same wording the drivers use when an agent cannot take an image. */
export function attachmentNote(name: string | undefined, path: string): string { return `[图片${name ? ` ${name}` : ""}: ${path}]`; }
function missingNote(name: string | undefined, id: string): string { return `[图片${name ? ` ${name}` : ""}: 附件 ${id} 不存在]`; }

/**
 * Prompt for a driver. Text without markers is returned unchanged. With images=true markers of
 * known attachments become image parts in place; otherwise (and for unknown ids) text notes.
 */
export function attachmentPrompt(text: string, lookup: AttachmentLookup | undefined, images: boolean): PromptInput {
  if (!hasAttachmentMarkers(text)) return text;
  const parts: PromptPart[] = [];
  const pushText = (value: string): void => {
    const last = parts.at(-1);
    if (last?.type === "text") last.text += value; else if (value) parts.push({ type: "text", text: value });
  };
  for (const segment of parseAttachmentMarkers(text)) {
    if (segment.type === "text") { pushText(segment.text); continue; }
    const file = lookup?.(segment.id), name = segment.name || file?.name;
    if (!file) pushText(missingNote(name, segment.id));
    else if (images) parts.push({ type: "image", path: file.path, mimeType: file.mimeType, ...(name ? { name } : {}) });
    else pushText(attachmentNote(name, file.path));
  }
  return parts.some((part) => part.type === "image") ? parts : parts.map((part) => part.type === "text" ? part.text : "").join("");
}

/** Text-only rendering (markers → notes) for places that can only carry text, e.g. MCP tool results. */
export function attachmentText(text: string, lookup: AttachmentLookup | undefined): string {
  const input = attachmentPrompt(text, lookup, false);
  return typeof input === "string" ? input : text;
}

/** Short plain label for titles: each marker becomes "[图片 name]". */
export function attachmentLabel(text: string): string {
  if (!hasAttachmentMarkers(text)) return text;
  return parseAttachmentMarkers(text).map((segment) => segment.type === "text" ? segment.text : `[图片${segment.name ? ` ${segment.name}` : ""}]`).join("");
}
