/**
 * Image attachments: BATON_HOME/attachments/<id>.<ext> plus a metadata row in the store, deduped
 * by sha256. Uploads (POST /api/attachments) are strict about their declared type; images agents
 * return are stored under the type their bytes actually have.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_TYPES, type AttachmentRecord, type AttachmentRef } from "@baton/protocol";
import type { Store } from "../store/index.js";

export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];
export class AttachmentError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const EXTENSIONS: Record<AttachmentMimeType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
/** File extensions GET /api/files/image serves. */
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const ID = /^att_[A-Za-z0-9_-]{8,64}$/;

export function isAttachmentMimeType(value: string): value is AttachmentMimeType { return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(value); }

/** The image type the bytes start with (magic numbers), if it is one baton stores. */
export function sniffImage(bytes: Uint8Array): AttachmentMimeType | undefined {
  const at = (offset: number, ...values: number[]): boolean => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

/** Pixel size from the image header when it is cheap to read; undefined otherwise. */
export function imageSize(bytes: Uint8Array, type: AttachmentMimeType): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const valid = (width: number, height: number): { width: number; height: number } | undefined => width > 0 && height > 0 ? { width, height } : undefined;
  try {
    if (type === "image/png") return bytes.length >= 24 ? valid(view.getUint32(16), view.getUint32(20)) : undefined;
    if (type === "image/gif") return bytes.length >= 10 ? valid(view.getUint16(6, true), view.getUint16(8, true)) : undefined;
    if (type === "image/webp") {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8 " && bytes.length >= 30) return valid(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
      if (chunk === "VP8L" && bytes.length >= 25) {
        const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!];
        return valid(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
      }
      if (chunk === "VP8X" && bytes.length >= 30) return valid(1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)));
      return undefined;
    }
    // JPEG: walk segments to the first start-of-frame marker.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = view.getUint16(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return valid(view.getUint16(offset + 7), view.getUint16(offset + 5));
      if (length < 2) return undefined;
      offset += 2 + length;
    }
  } catch { /* truncated header */ }
  return undefined;
}

/** Decodes base64 or a `data:<type>;base64,` URI. */
function decode(data: Uint8Array | string): Buffer {
  if (typeof data !== "string") return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const comma = data.startsWith("data:") ? data.indexOf(",") : -1;
  return Buffer.from(comma >= 0 && comma < 256 ? data.slice(comma + 1) : data, "base64");
}

function cleanName(name: string | undefined): string | undefined {
  const value = name === undefined ? "" : basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return value || undefined;
}

export class Attachments {
  constructor(private readonly store: Store, readonly dir: string) {}
  /** Upload path: the declared type must be allowed and match the bytes. */
  async save(data: Uint8Array, mimeType: string, name?: string): Promise<AttachmentRecord> {
    const type = mimeType.split(";")[0]!.trim().toLowerCase();
    if (data.byteLength > ATTACHMENT_MAX_BYTES) throw new AttachmentError(413, `Attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
    if (!isAttachmentMimeType(type)) throw new AttachmentError(415, `Unsupported attachment type: ${type || "none"}; expected ${ATTACHMENT_MIME_TYPES.join(", ")}`);
    if (!data.byteLength) throw new AttachmentError(400, "Attachment body is empty");
    if (sniffImage(data) !== type) throw new AttachmentError(415, `Attachment content is not ${type}`);
    return this.put(Buffer.from(data.buffer, data.byteOffset, data.byteLength), type, name);
  }
  /** Agent output path (drivers' saveImage): stores the bytes under their real image type. */
  async saveImage(data: Uint8Array | string, _mimeType: string, name?: string): Promise<AttachmentRef> {
    const bytes = decode(data);
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new AttachmentError(413, `Image exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
    const type = sniffImage(bytes);
    if (!type) throw new AttachmentError(415, "Not a PNG, JPEG, GIF or WebP image");
    const { size: _size, createdAt: _created, ...ref } = await this.put(bytes, type, name);
    return ref;
  }
  get(id: string): AttachmentRecord | undefined { return ID.test(id) ? this.store.attachment(id) : undefined; }
  path(ref: Pick<AttachmentRef, "id" | "mimeType">): string { return join(this.dir, `${ref.id}.${EXTENSIONS[ref.mimeType as AttachmentMimeType] ?? "bin"}`); }
  /** Record and bytes, or undefined when the id is unknown or its file is gone. */
  async read(id: string): Promise<{ record: AttachmentRecord; bytes: Buffer } | undefined> {
    const record = this.get(id);
    if (!record) return undefined;
    try { return { record, bytes: await readFile(this.path(record)) }; } catch { return undefined; }
  }
  private async put(bytes: Buffer, type: AttachmentMimeType, name?: string): Promise<AttachmentRecord> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.store.attachmentBySha(sha256);
    if (existing && await this.present(existing)) return existing;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const size = imageSize(bytes, type), clean = cleanName(name);
    const record: AttachmentRecord = existing ?? { id: `att_${randomBytes(12).toString("base64url")}`, mimeType: type, ...(clean ? { name: clean } : {}), ...(size ?? {}), size: bytes.byteLength, createdAt: new Date().toISOString() };
    const file = this.path(record), temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, file);
    // A concurrent save of the same bytes may have won the row; keep the stored record.
    const stored = this.store.insertAttachment(record, sha256);
    if (stored.id !== record.id) await rm(file, { force: true });
    return stored;
  }
  private async present(record: AttachmentRecord): Promise<boolean> {
    try { return (await stat(this.path(record))).isFile(); } catch { return false; }
  }
}

/**
 * A local image file for GET /api/files/image: absolute path, resolved through symlinks, a regular
 * file with an image extension, at most ATTACHMENT_MAX_BYTES, whose bytes are an allowed image.
 * Undefined for anything else (the route answers 404).
 */
export async function readLocalImage(path: string): Promise<{ bytes: Buffer; mimeType: AttachmentMimeType; path: string } | undefined> {
  if (!isAbsolute(path) || path.includes("\0")) return undefined;
  let real: string;
  try { real = await realpath(path); } catch { return undefined; }
  if (!IMAGE_EXTENSIONS.has(extname(real).toLowerCase())) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(real, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > ATTACHMENT_MAX_BYTES || info.size === 0) return undefined;
    const bytes = await handle.readFile();
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) return undefined;
    const mimeType = sniffImage(bytes);
    return mimeType ? { bytes, mimeType, path: real } : undefined;
  } catch { return undefined; } finally { await handle?.close(); }
}
