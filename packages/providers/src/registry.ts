// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/provider-registry.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import which from "which";
import pLimit from "p-limit";
import { z } from "zod";
import type { Logger } from "pino";
import type { AgentCapabilities, AgentClient, AgentProvider, ProviderCatalog } from "./agent-sdk-types.js";
import { ACPAgentClient } from "./providers/acp-agent.js";
import { ClaudeAgentClient } from "./providers/claude-agent.js";
import { CodexAppServerAgentClient } from "./providers/codex-agent.js";
import { PiRpcAgentClient } from "./providers/pi-agent.js";
import { errorText, record } from "./session.js";
import { externalEnv } from "./process.js";
export interface DetectedAgent extends ProviderCatalog {
    id: string;
    label: string;
    kind: "native" | "acp";
    status: "ready" | "unavailable" | "error";
    enabled: boolean;
    command?: string[];
    version?: string;
    diagnostic?: string;
    notes?: string;
    capabilities: AgentCapabilities;
    checkedAt: string;
}
interface Definition {
    id: string;
    label: string;
    provider: AgentProvider;
    command: string[];
    env?: Record<string, string>;
    enabled: boolean;
    notes?: string;
    models?: ProviderCatalog["models"];
    configError?: string;
}
// ACP command choices also reference acpx/src/agent-registry.ts (MIT, OpenClaw Team).
const BUILTINS: Array<[
    string,
    string,
    AgentProvider,
    string[]
]> = [
    ["claude", "Claude Code", "claude", ["claude"]], ["codex", "Codex", "codex", ["codex"]], ["pi", "Pi", "pi", ["pi"]],
    ["gemini", "Gemini CLI", "acp", ["gemini", "--acp"]], ["qwen", "Qwen Code", "acp", ["qwen", "--acp"]],
    ["kimi", "Kimi Code", "acp", ["kimi", "acp"]], ["opencode", "OpenCode", "acp", ["opencode", "acp"]],
    ["copilot", "GitHub Copilot", "acp", ["copilot", "--acp", "--stdio"]], ["cursor", "Cursor", "acp", ["cursor-agent", "acp"]],
    ["goose", "Goose", "acp", ["goose", "acp"]], ["droid", "Factory Droid", "acp", ["droid", "exec", "--output-format", "acp"]],
    ["hermes", "Hermes", "acp", ["hermes", "acp"]], ["openclaw", "OpenClaw", "acp", ["openclaw", "acp"]], ["kiro", "Kiro", "acp", ["kiro-cli-chat", "acp"]],
];
const ModelSchema = z.object({ id: z.string(), label: z.string(), description: z.string().optional(), isDefault: z.boolean().optional(), thinkingOptions: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean().optional() })).optional() });
const ProfileSchema = z.object({ extends: z.enum(["acp", "claude", "codex", "pi"]).optional(), command: z.array(z.string().min(1)).min(1).optional(), env: z.record(z.string(), z.string()).optional(), label: z.string().optional(), enabled: z.boolean().optional(), notes: z.string().optional(), models: z.array(ModelSchema).optional() });
export interface ProviderRegistryOptions {
    home: string;
    logger?: Logger;
    timeoutMs?: number;
}
export class ProviderRegistry {
    private cache?: Promise<DetectedAgent[]>;
    private clients = new Map<string, AgentClient>();
    private generation = 0;
    constructor(private options: ProviderRegistryOptions) { }
    get(id: string): AgentClient | undefined { return this.clients.get(id); }
    detect(options?: {
        force?: boolean;
    }): Promise<DetectedAgent[]> {
        if (!this.cache || options?.force)
            this.cache = this.refresh(++this.generation).catch(error => BUILTINS.map(([id, label, provider, command]) => this.entry({ id, label, provider, command, enabled: true }, errorText(error))));
        return this.cache;
    }
    private entry(definition: Definition, diagnostic?: string): DetectedAgent {
        return {
            id: definition.id, label: definition.label, kind: definition.provider === "acp" ? "acp" : "native", status: "unavailable", enabled: definition.enabled,
            command: definition.command, models: definition.models ?? [], modes: [], notes: definition.notes, checkedAt: new Date().toISOString(),
            capabilities: { steer: definition.provider !== "acp", resume: true, reasoning: true, mcp: true }, ...(diagnostic ? { diagnostic } : {}),
        };
    }
    private async definitions(): Promise<Definition[]> {
        const definitions = new Map(BUILTINS.map(([id, label, provider, command]) => [id, { id, label, provider, command, enabled: true } as Definition]));
        let config: Record<string, unknown> = {};
        try {
            config = record(JSON.parse(await readFile(join(this.options.home, "config.json"), "utf8")));
        }
        catch (error) {
            if (record(error).code !== "ENOENT")
                for (const definition of definitions.values())
                    definition.configError = `Cannot read config.json: ${errorText(error)}`;
        }
        for (const [id, value] of Object.entries(record(config.agents))) {
            const parsed = ProfileSchema.safeParse(value);
            const previous = definitions.get(id);
            if (!parsed.success) {
                definitions.set(id, { ...(previous ?? { id, label: id, provider: "acp", command: [id], enabled: true }), configError: `Invalid agent profile: ${parsed.error.message}` });
                continue;
            }
            const profile = parsed.data;
            const provider = profile.extends ?? previous?.provider ?? "acp";
            definitions.set(id, { ...previous, ...profile, id, label: profile.label ?? previous?.label ?? id, provider, enabled: profile.enabled ?? previous?.enabled ?? true, command: profile.command ?? (previous && provider === previous.provider ? previous.command : undefined) ?? [provider === "acp" ? id : provider] });
        }
        return [...definitions.values()];
    }
    private async refresh(generation: number): Promise<DetectedAgent[]> {
        const definitions = await this.definitions();
        const clients = new Map<string, AgentClient>();
        const limit = pLimit(4);
        const entries = await Promise.all(definitions.map(definition => limit(async () => {
            const entry = this.entry(definition);
            try {
                if (definition.configError)
                    throw new Error(definition.configError);
                if (!definition.enabled) {
                    entry.diagnostic = "Disabled in config.json";
                    return entry;
                }
                const env = externalEnv(definition.env);
                const executable = await which(definition.command[0]!, { path: env.PATH });
                const command = [executable, ...definition.command.slice(1)];
                entry.command = command;
                entry.version = await probeVersion(command, env, this.options.timeoutMs ?? 5000);
                const options = { ...this.options, command, env: definition.env };
                const client = definition.provider === "claude" ? new ClaudeAgentClient(options) : definition.provider === "codex" ? new CodexAppServerAgentClient(options) : definition.provider === "pi" ? new PiRpcAgentClient(options) : new ACPAgentClient(options);
                const catalog = await client.fetchCatalog();
                entry.models = definition.models ?? catalog.models;
                entry.modes = catalog.modes;
                entry.defaultModeId = catalog.defaultModeId;
                entry.status = "ready";
                entry.capabilities = client.capabilities;
                clients.set(definition.id, client);
            }
            catch (error) {
                entry.diagnostic = errorText(error);
            }
            return entry;
        })));
        if (generation === this.generation)
            this.clients = clients;
        return entries;
    }
}
// Preserve package-runner prefixes for custom commands (Paseo generic ACP diagnostic behavior).
export function versionProbeCommand(command: string[]): string[] {
    const executable = command[0]!;
    const name = executable.split(/[\\/]/).at(-1);
    if (!["npx", "bunx", "pnpm", "uvx"].includes(name ?? ""))
        return [executable, "--version"];
    const prefix: string[] = [];
    for (let index = 1; index < command.length; index++) {
        const arg = command[index]!;
        prefix.push(arg);
        if (arg === "dlx")
            continue;
        if (arg === "--package" || arg === "-p") {
            if (command[index + 1])
                prefix.push(command[++index]!);
            continue;
        }
        if (!arg.startsWith("-"))
            break;
    }
    return [executable, ...prefix, "--version"];
}
export async function probeVersion(command: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
    const [executable, ...args] = versionProbeCommand(command);
    return new Promise((resolve, reject) => execFile(executable!, args, { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error)
            reject(new Error(`Version probe failed: ${error.message}\n${stderr.trim()}`));
        else
            resolve((stdout.trim() || stderr.trim()).slice(0, 2000));
    }));
}
