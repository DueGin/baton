/**
 * Image prompt parts and agent image output for baton drivers. Conversion choices follow Paseo's
 * provider-image-output.ts and the per-provider prompt converters @63ea3e5 (Apache-2.0,
 * Mohamed Boudra); modified for baton: images arrive as stored files and leave through a
 * host-supplied SaveImage service instead of a temp directory.
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentImageRef, AgentPromptInput, AgentPromptPart, SaveImage } from "./agent-sdk-types.js";

export type ImagePart = Extract<AgentPromptPart, { type: "image" }>;

/** What an agent without image input gets for an attached image: its local path, so tools can open it. */
export function imageNote(part: Pick<ImagePart, "path" | "name">): string {
    return `[图片${part.name ? ` ${part.name}` : ""}: ${part.path}]`;
}

/** Plain-text rendering of a prompt; images become `render(part)` (default: the path note). */
export function promptText(prompt: AgentPromptInput, render: (part: ImagePart, index: number) => string = imageNote): string {
    if (typeof prompt === "string")
        return prompt;
    let index = 0;
    return prompt.map(part => part.type === "text" ? part.text : render(part, index++)).join("");
}

export function promptImages(prompt: AgentPromptInput): ImagePart[] {
    return typeof prompt === "string" ? [] : prompt.filter((part): part is ImagePart => part.type === "image");
}

/** Reads an image part as base64. Null when the file is missing, unreadable or larger than maxBytes. */
export async function readPromptImage(part: ImagePart, maxBytes = Number.POSITIVE_INFINITY): Promise<{ data: string; mimeType: string } | null> {
    try {
        const info = await stat(part.path);
        if (!info.isFile() || info.size > maxBytes)
            return null;
        return { data: (await readFile(part.path)).toString("base64"), mimeType: part.mimeType };
    }
    catch {
        return null;
    }
}

export async function imageFileExists(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    }
    catch {
        return false;
    }
}

/** An image an agent produced: inline base64 (or a data: URI) or a local file. */
export type ProviderImage = { data: string; mimeType?: string | null; name?: string } | { path: string; mimeType?: string | null; name?: string };

/** Stores each image through the host; images that cannot be stored are skipped (never throws). */
export async function saveProviderImages(save: SaveImage | undefined, images: ProviderImage[]): Promise<AgentImageRef[]> {
    if (!save)
        return [];
    const refs: AgentImageRef[] = [];
    for (const image of images) {
        try {
            if ("path" in image) {
                const info = await stat(image.path);
                if (!info.isFile())
                    continue;
                refs.push(await save(await readFile(image.path), image.mimeType ?? "", image.name ?? basename(image.path)));
            }
            else
                refs.push(await save(image.data, image.mimeType ?? "", image.name));
        }
        catch {
            /* not an image the host accepts (type, size, unreadable) */
        }
    }
    return refs;
}

/** Markdown an assistant message uses to show a stored image (rendered by the console). */
export function imageMarkdown(ref: AgentImageRef, alt = "图片"): string {
    return `\n\n![${alt.replace(/[\\\]]/g, match => `\\${match}`)}](attachment:${ref.id})\n\n`;
}

/**
 * Image blocks inside a tool result, in the shapes providers use: Anthropic
 * `{type:"image", source:{type:"base64", media_type, data}}`, MCP/ACP/Pi `{type:"image", data, mimeType}`
 * and Claude Code's Read result `{type:"image", file:{base64, type}}`. Searches nested values.
 */
export function findImageBlocks(value: unknown, depth = 0): Array<{ data: string; mimeType: string | null }> {
    if (depth > 6 || value === null || typeof value !== "object")
        return [];
    if (Array.isArray(value))
        return value.flatMap(child => findImageBlocks(child, depth + 1));
    const object = value as Record<string, unknown>;
    if (object.type === "image") {
        const source = object.source && typeof object.source === "object" ? object.source as Record<string, unknown> : undefined;
        const file = object.file && typeof object.file === "object" ? object.file as Record<string, unknown> : undefined;
        if (source && typeof source.data === "string")
            return [{ data: source.data, mimeType: typeof source.media_type === "string" ? source.media_type : null }];
        if (typeof object.data === "string")
            return [{ data: object.data, mimeType: typeof object.mimeType === "string" ? object.mimeType : typeof object.mime_type === "string" ? object.mime_type : null }];
        if (file && typeof file.base64 === "string")
            return [{ data: file.base64, mimeType: typeof file.type === "string" ? file.type : null }];
    }
    return Object.values(object).flatMap(child => findImageBlocks(child, depth + 1));
}

/**
 * Runs tasks in arrival order. A task runs synchronously while nothing is pending, so a session's
 * event order and timing stay unchanged until one task (an image save) turns asynchronous; later
 * tasks then wait for it.
 */
export class OrderedTasks {
    private tail?: Promise<void>;
    run(task: () => void | Promise<void>): void {
        if (this.tail) {
            this.track(this.tail.then(task));
            return;
        }
        const result = task();
        if (result)
            this.track(result);
    }
    /** Resolves when every task queued so far has settled. */
    idle(): Promise<void> { return this.tail ?? Promise.resolve(); }
    private track(promise: Promise<void>): void {
        const tail: Promise<void> = promise.catch(() => { }).then(() => { if (this.tail === tail)
            this.tail = undefined; });
        this.tail = tail;
    }
}
