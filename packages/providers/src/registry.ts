// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/provider-registry.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import pLimit from "p-limit";
import { z } from "zod";
import type { Logger } from "pino";
import type { AgentCapabilities, AgentClient, AgentProvider, ProviderCatalog, SaveImage } from "./agent-sdk-types.js";
import { ACPAgentClient } from "./providers/acp-agent.js";
import { ClaudeAgentClient } from "./providers/claude-agent.js";
import { CodexAppServerAgentClient } from "./providers/codex-agent.js";
import { PiRpcAgentClient } from "./providers/pi-agent.js";
import { errorText, record } from "./session.js";
import { externalEnv } from "./process.js";
import { findExecutable } from "./executable-resolution.js";
import { processLaunch } from "./windows-command.js";
import { ACP_AGENT_SPECS, AcpSpecFields, AcpAgentSpecSchema, scrubAcpEnv, versionDiagnostic, type AcpAgentSpec } from "./acp-spec.js";
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
    installHint?: string;
    homepage?: string;
    minVersion?: string;
    source?: "builtin" | "config";
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
    spec?: AcpAgentSpec;
    source?: "builtin" | "config";
}
const BUILTINS: Definition[] = [
    { id: "claude", label: "Claude Code", provider: "claude", command: ["claude"], enabled: true, source: "builtin" },
    { id: "codex", label: "Codex", provider: "codex", command: ["codex"], enabled: true, source: "builtin" },
    { id: "pi", label: "Pi", provider: "pi", command: ["pi"], enabled: true, source: "builtin" },
    ...ACP_AGENT_SPECS.map(spec => ({ id: spec.id, label: spec.label, provider: "acp" as const, command: spec.command, env: spec.env, notes: spec.notes, enabled: true, source: "builtin" as const, spec })),
];
const ModelSchema = z.object({ id: z.string(), label: z.string(), description: z.string().optional(), isDefault: z.boolean().optional(), thinkingOptions: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean().optional() })).optional() });
const ProfileSchema = z.object({ ...Object.fromEntries(Object.entries(AcpSpecFields).map(([key, schema]) => [key, schema.optional()])), extends: z.enum(["acp", "claude", "codex", "pi"]).optional(), command: z.array(z.string().min(1)).min(1).optional(), env: z.record(z.string(), z.string()).optional(), label: z.string().optional(), enabled: z.boolean().optional(), notes: z.string().optional(), models: z.array(ModelSchema).optional() }).strict();
export interface ProviderRegistryOptions {
    home: string;
    logger?: Logger;
    timeoutMs?: number;
    /** Passed to every client: stores images agents return. */
    saveImage?: SaveImage;
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
            this.cache = this.refresh(++this.generation).catch(error => BUILTINS.map(definition => this.entry(definition, errorText(error))));
        return this.cache;
    }
    private entry(definition: Definition, diagnostic?: string): DetectedAgent {
        return {
            id: definition.id, label: definition.label, kind: definition.provider === "acp" ? "acp" : "native", status: "unavailable", enabled: definition.enabled,
            command: definition.command, installHint: definition.spec?.installHint ?? `Install ${definition.label} and put ${definition.command[0]} on PATH.`, homepage: definition.spec?.homepage, minVersion: definition.spec?.minVersion, source: definition.source ?? "builtin", models: definition.models ?? [], modes: [], notes: definition.notes, checkedAt: new Date().toISOString(),
            capabilities: { steer: definition.provider !== "acp", resume: true, reasoning: true, mcp: definition.spec?.mcp.http ?? true, images: definition.provider === "acp" ? definition.spec?.images ?? false : true }, ...(diagnostic ? { diagnostic } : {}),
        };
    }
    private async definitions(): Promise<Definition[]> {
        const definitions = new Map(BUILTINS.map(definition => [definition.id, { ...definition }]));
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
            const command = profile.command ?? (previous && provider === previous.provider ? previous.command : undefined) ?? [provider === "acp" ? id : provider];
            const acpSpec = provider === "acp" ? AcpAgentSpecSchema.safeParse({
                ...(previous?.spec ?? { homepage: "https://agentclientprotocol.com", installHint: `Install ${command[0]} and configure agents.${id}.command`, mcp: { supported: true, http: true, sse: true, stdio: true } }),
                ...profile, id, label: profile.label ?? previous?.label ?? id, command,
                env: { ...previous?.spec?.env, ...profile.env },
            }) : undefined;
            definitions.set(id, { ...previous, ...profile, id, label: profile.label ?? previous?.label ?? id, provider, enabled: profile.enabled ?? previous?.enabled ?? true, command, source: "config", ...(acpSpec ? acpSpec.success ? { spec: acpSpec.data } : { configError: `Invalid ACP spec: ${acpSpec.error.message}` } : {}) });
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
                const env = scrubAcpEnv(externalEnv(definition.spec?.env, definition.env), definition.spec?.scrubEnv ?? []);
                const executable = await findExecutable(definition.command[0]!, env);
                if (!executable) throw new Error(`Executable not found: ${definition.command[0]}`);
                const command = [executable, ...definition.command.slice(1)];
                entry.command = command;
                entry.version = await probeVersion(command, env, this.options.timeoutMs ?? 5000, definition.spec?.versionArgs);
                const diagnostic = definition.spec ? versionDiagnostic(entry.version, definition.spec) : undefined;
                if (diagnostic) { entry.status = "error"; entry.diagnostic = diagnostic; return entry; }
                const options = { ...this.options, command, env: definition.env, spec: definition.spec };
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
    const name = executable.split(/[\\/]/).at(-1)?.replace(/\.(?:exe|cmd|bat)$/i, "");
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
export async function probeVersion(command: string[], env: NodeJS.ProcessEnv, timeoutMs: number, versionArgs?: string[]): Promise<string> {
    const [executable, ...args] = versionArgs ? [...versionProbeCommand(command).slice(0, -1), ...versionArgs] : versionProbeCommand(command);
    const launch = processLaunch(executable!, args, env);
    return new Promise((resolve, reject) => execFile(launch.command, launch.args, { env, windowsVerbatimArguments: launch.windowsVerbatimArguments, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error)
            reject(new Error(`Version probe failed: ${error.message}\n${stderr.trim()}`));
        else
            resolve((stdout.trim() || stderr.trim()).slice(0, 2000));
    }));
}
