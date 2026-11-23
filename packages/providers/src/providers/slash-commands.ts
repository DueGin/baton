import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSlashCommand } from "../agent-sdk-types.js";
import { text } from "../session.js";

export const COMMAND_TIMEOUT_MS = 5000;

export async function commandDeadline<T>(work: () => Promise<T>, fallback: T, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([work(), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs); })]);
    } catch {
        return fallback;
    } finally {
        clearTimeout(timer);
    }
}

export function normalizeCommands(commands: AgentSlashCommand[]): AgentSlashCommand[] {
    const unique = new Map<string, AgentSlashCommand>();
    for (const command of commands) {
        const name = text(command.name).trim().replace(/^\/+/, "");
        if (!name || /\s/.test(name) || unique.has(name)) continue;
        unique.set(name, { name, ...(command.kind ? { kind: command.kind } : {}), ...(command.description ? { description: command.description } : {}), ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}) });
    }
    return [...unique.values()];
}

type MarkdownKind = "command" | "skill" | "prompt";

export async function readCommandMarkdown(path: string): Promise<{ body: string; name?: string; description?: string; argumentHint?: string } | null> {
    try {
        if (!(await stat(path)).isFile()) return null;
        const markdown = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
        const header = /^---[^\S\r\n]*\r?\n([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/m.exec(markdown);
        if (!header || header.index !== 0) return { body: markdown };
        const fields = new Map<string, string>();
        const lines = (header[1] ?? "").split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const field = /^(name|description|argument-hint):\s*(.*?)\s*$/.exec(lines[index] ?? "");
            if (!field?.[1] || !field[2]) continue;
            let value = field[2];
            if (/^[|>][-+]?$/.test(value)) {
                const parts: string[] = [];
                while (/^[ \t]+\S/.test(lines[index + 1] ?? "")) parts.push((lines[++index] ?? "").trim());
                value = parts.join(value.startsWith(">") ? " " : "\n");
            } else if (value.startsWith('"') && value.endsWith('"')) {
                try { value = text(JSON.parse(value)); } catch { value = value.slice(1, -1); }
            } else if (value.startsWith("'") && value.endsWith("'")) {
                value = value.slice(1, -1).replaceAll("''", "'");
            } else {
                value = value.replace(/\s+#.*$/, "");
            }
            fields.set(field[1], value);
        }
        return { body: markdown.slice(header[0].length), name: fields.get("name"), description: fields.get("description"), argumentHint: fields.get("argument-hint") };
    } catch {
        return null;
    }
}

export async function scanCommandDirectory(dir: string, kind: MarkdownKind, namespace = ""): Promise<Array<{ command: AgentSlashCommand; path: string }>> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const commands: Array<{ command: AgentSlashCommand; path: string }> = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (kind === "command" && entry.isDirectory()) {
            commands.push(...await scanCommandDirectory(join(dir, entry.name), kind, `${namespace}${entry.name}:`));
            continue;
        }
        if (kind === "skill" ? !(entry.isDirectory() || entry.isSymbolicLink()) : !entry.name.endsWith(".md")) continue;
        const path = kind === "skill" ? join(dir, entry.name, "SKILL.md") : join(dir, entry.name);
        const markdown = await readCommandMarkdown(path);
        if (!markdown) continue;
        const name = kind === "skill" ? markdown.name || entry.name : entry.name.slice(0, -3);
        commands.push({ command: { name: `${namespace}${name}`, description: markdown.description, argumentHint: markdown.argumentHint, kind }, path });
    }
    return commands;
}
