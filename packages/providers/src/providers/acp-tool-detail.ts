// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/acp-agent.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import type { ToolCallDetail } from "../agent-sdk-types.js";
import { record, text } from "../session.js";
import { deriveClaudeToolDetail } from "./claude/tool-call-detail-parser.js";
export interface TerminalSnapshot {
    command: string;
    cwd: string;
    output: string;
    exit?: {
        exitCode?: number | null;
        signal?: string | null;
    };
}
export function acpToolDetail(snapshot: Record<string, unknown>, terminals: Map<string, TerminalSnapshot> = new Map()): ToolCallDetail {
    const input = record(snapshot.rawInput), output = record(snapshot.rawOutput);
    const content = Array.isArray(snapshot.content) ? snapshot.content.map(record) : [];
    const locations = Array.isArray(snapshot.locations) ? snapshot.locations.map(record) : [];
    const rendered = content.map(part => text(record(part.content).text)).filter(Boolean).join("\n") || undefined;
    const diff = content.find(part => part.type === "diff");
    const terminalId = text(content.find(part => part.type === "terminal")?.terminalId);
    const terminal = terminals.get(terminalId);
    const path = text(locations[0]?.path) || text(input.path ?? input.filePath ?? input.file ?? input.file_path) || text(diff?.path) || text(snapshot.title);
    switch (snapshot.kind) {
        case "read": return { type: "read", filePath: path, content: rendered ?? text(output.content ?? output.text), ...(typeof input.offset === "number" ? { offset: input.offset } : {}), ...(typeof input.limit === "number" ? { limit: input.limit } : {}) };
        case "edit":
        case "delete": return { type: "edit", filePath: path, oldString: text(diff?.oldText ?? input.oldText ?? input.oldString), newString: snapshot.kind === "delete" ? "" : text(diff?.newText ?? input.newText ?? input.newString), unifiedDiff: rendered };
        case "search": return { type: "search", toolName: "search", query: text(input.query ?? input.pattern) || text(snapshot.title), content: rendered ?? text(output.content ?? output.text), filePaths: locations.map(location => text(location.path)) };
        case "execute": return { type: "shell", command: terminal?.command ?? ((Array.isArray(input.command) ? input.command.map(text).join(" ") : text(input.command)) || text(snapshot.title)), cwd: terminal?.cwd ?? text(input.cwd), output: terminal?.output ?? rendered ?? text(output.output ?? output.stdout ?? output.text), ...(terminal?.exit ? { exitCode: terminal.exit.exitCode } : typeof output.exitCode === "number" ? { exitCode: output.exitCode } : {}) };
        case "fetch": return { type: "fetch", url: text(input.url) || text(snapshot.title), prompt: text(input.prompt), result: rendered ?? text(output.result ?? output.text ?? output.content), ...(typeof output.status === "number" ? { code: output.status } : {}) };
        case "think":
        case "switch_mode": return { type: "plain_text", label: text(snapshot.title), text: rendered };
        default:
            if (terminal)
                return { type: "shell", command: terminal.command, cwd: terminal.cwd, output: terminal.output, exitCode: terminal.exit?.exitCode };
            return deriveClaudeToolDetail(text(snapshot.title), snapshot.rawInput, snapshot.rawOutput ?? rendered);
    }
}
