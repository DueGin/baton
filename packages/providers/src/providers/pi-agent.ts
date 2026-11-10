// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/pi/agent.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import pino from "pino";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentClient, AgentPersistenceHandle, AgentSessionConfig, AgentUsage, ClientOptions, ProviderCatalog } from "../agent-sdk-types.js";
import { ProviderSession, record, text, errorText } from "../session.js";
import { JsonlRpcProcess } from "./jsonl-rpc-process.js";
import { mapToolDetail, parseToolArgs, parseToolResult, splitPiToolResultImages, type PiTrackedToolCall } from "./pi/tool-call-mapper.js";
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(id => ({ id, label: id }));
function runtime(options: ClientOptions, config: AgentSessionConfig, extra: string[] = []): JsonlRpcProcess {
    return new JsonlRpcProcess({ launch: { command: options.command[0]!, args: [...options.command.slice(1), "--mode", "rpc", ...extra], cwd: config.cwd, env: { ...options.env, ...config.env } }, logger: options.logger ?? pino({ enabled: false }), diagnosticName: "Pi RPC", defaultRequestTimeoutMs: options.timeoutMs ?? 10000 });
}
export class PiRpcAgentClient implements AgentClient {
    readonly provider = "pi" as const;
    readonly capabilities = { steer: true, resume: true, reasoning: true, mcp: true };
    constructor(private options: ClientOptions) { }
    async createSession(config: AgentSessionConfig): Promise<PiSession> { return PiSession.open(this.options, config); }
    async resumeSession(handle: AgentPersistenceHandle, config: AgentSessionConfig): Promise<PiSession> { return PiSession.open(this.options, config, handle); }
    async fetchCatalog(): Promise<ProviderCatalog> {
        await mkdir(this.options.home, { recursive: true });
        const cwd = await mkdtemp(join(this.options.home, "catalog-pi-"));
        const process = runtime(this.options, { cwd }, ["--no-session"]);
        try {
            const result = record(await process.request({ type: "get_available_models" }));
            const state = record(await process.request({ type: "get_state" }));
            const commandResponse = record(await process.request({ type: "get_commands" }));
            const commands = (Array.isArray(commandResponse.commands) ? commandResponse.commands : []).map(record);
            this.capabilities.mcp = commands.some(command => command.name === "mcp" && record(command.sourceInfo).path === "builtin:mcp") || commands.some(command => /^mcp(?::\d+)?$/.test(text(command.name)) && command.source === "extension" && (!command.sourceInfo || JSON.stringify(command.sourceInfo).includes("pi-mcp-adapter")));
            const selected = record(state.model);
            return { modes: [{ id: "default", label: "Default", description: "Pi executes tools without a native approval gate", isUnattended: true }], defaultModeId: "default", models: (Array.isArray(result.models) ? result.models : []).map(record).map(model => ({ id: `${text(model.provider)}/${text(model.id)}`, label: text(model.name) || text(model.id), isDefault: model.id === selected.id && model.provider === selected.provider, ...(model.reasoning ? { thinkingOptions: THINKING } : {}) })) };
        }
        finally {
            await process.close();
            await rm(cwd, { recursive: true, force: true });
        }
    }
}
class PiSession extends ProviderSession {
    private process!: JsonlRpcProcess;
    private sessionFile?: string;
    private dir!: string;
    private tools = new Map<string, PiTrackedToolCall>();
    private streamedText = false;
    private streamedThinking = false;
    private canceling = false;
    private usage?: AgentUsage;
    private settledMessages: unknown[] = [];
    private constructor(config: AgentSessionConfig) { super("pi", config); }
    static async open(options: ClientOptions, config: AgentSessionConfig, handle?: AgentPersistenceHandle): Promise<PiSession> {
        const session = new PiSession(config);
        if (config.modeId && config.modeId !== "default")
            throw new Error(`Unsupported Pi mode ${config.modeId}`);
        if (handle && !handle.sessionFile)
            throw new Error("Pi resume requires a session file");
        await mkdir(options.home, { recursive: true });
        session.dir = await mkdtemp(join(options.home, "pi-runtime-"));
        try {
            const args = [];
            if (handle?.sessionFile)
                args.push("--session", handle.sessionFile);
            else
                args.push("--session-dir", join(options.home, "pi-sessions"));
            if (config.model)
                args.push("--model", config.model);
            if (config.thinking)
                args.push("--thinking", config.thinking);
            const mcpServers = config.mcpServers ?? {};
            let builtinServers: Record<string, unknown> = {};
            if (Object.keys(mcpServers).length) {
                const probe = runtime(options, config, ["--no-session"]);
                let commands: Record<string, unknown>[];
                try {
                    const result = record(await probe.request({ type: "get_commands" }));
                    commands = (Array.isArray(result.commands) ? result.commands : []).map(record);
                }
                finally {
                    await probe.close();
                }
                const builtin = commands.some(command => command.name === "mcp" && record(command.sourceInfo).path === "builtin:mcp");
                const adapter = commands.some(command => /^mcp(?::\d+)?$/.test(text(command.name)) && command.source === "extension" && (!command.sourceInfo || JSON.stringify(command.sourceInfo).includes("pi-mcp-adapter")));
                if (builtin) {
                    for (const [name, server] of Object.entries(mcpServers)) {
                        if (!/^[A-Za-z0-9_-]+$/.test(name) || server.type === "sse")
                            throw new Error("Pi builtin MCP requires simple server names and HTTP or stdio transport");
                    }
                    builtinServers = Object.fromEntries(Object.entries(mcpServers).map(([name, server]) => [name, server.type === "stdio" ? { command: server.command, args: server.args, env: server.env } : { url: server.url, headers: server.headers }]));
                }
                else if (adapter) {
                    const env = { ...process.env, ...options.env, ...config.env };
                    const globalPath = join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "mcp.json");
                    let global: Record<string, unknown> = {};
                    try {
                        global = record(JSON.parse(await readFile(globalPath, "utf8")));
                    }
                    catch (error) {
                        if (record(error).code !== "ENOENT")
                            throw error;
                    }
                    const servers = Object.fromEntries(Object.entries(mcpServers).map(([name, server]) => [name, server.type === "stdio" ? { command: server.command, args: server.args, env: server.env } : { url: server.url, headers: server.headers, auth: false, oauth: false }]));
                    const path = join(session.dir, "mcp.json");
                    const merged: Record<string, unknown> = { ...global, mcpServers: { ...record(global.mcpServers ?? global["mcp-servers"]), ...servers } };
                    delete merged["mcp-servers"];
                    await writeFile(path, JSON.stringify(merged), { mode: 0o600 });
                    args.push("--mcp-config", path);
                }
                else
                    throw new Error("Pi has no MCP support: enable builtin MCP or install pi-mcp-adapter");
            }
            if (config.systemPrompt || Object.keys(builtinServers).length) {
                const extensionPath = join(session.dir, "baton.mjs");
                await writeFile(extensionPath, `export default function(pi) {\nfor (const [name, config] of Object.entries(${JSON.stringify(builtinServers)})) pi.registerMcpServer(name, config);\n${config.systemPrompt ? `pi.on("before_agent_start", async event => ({ systemPrompt: event.systemPrompt + "\\n\\n" + ${JSON.stringify(config.systemPrompt)} }));` : ""}\n}`, { mode: 0o600 });
                args.push("--extension", extensionPath);
            }
            session.process = runtime(options, config, args);
            session.process.onMessage(event => session.event(event));
            session.process.onExit(exit => session.processExited(exit.error.message));
            const state = record(await session.process.request({ type: "get_state" }));
            session.sessionFile = text(state.sessionFile) || handle?.sessionFile;
            session.identify(text(state.sessionId) || handle?.sessionId || text(state.sessionFile));
            if (!session.sessionId)
                throw new Error("Pi did not return session identity");
            const model = record(state.model);
            session.config.model = model.id ? `${text(model.provider)}/${text(model.id)}` : config.model;
            session.config.modeId ??= "default";
            return session;
        }
        catch (error) {
            await session.process?.close();
            await rm(session.dir, { recursive: true, force: true });
            throw error;
        }
    }
    override getPersistence(): AgentPersistenceHandle | null { const handle = super.getPersistence(); return handle && this.sessionFile ? { ...handle, sessionFile: this.sessionFile } : null; }
    protected async launchTurn(prompt: string): Promise<void> {
        this.streamedText = false;
        this.streamedThinking = false;
        this.canceling = false;
        this.usage = undefined;
        this.settledMessages = [];
        // Pi's prompt acknowledgment may arrive only after agent_end.
        const turnId = this.activeTurn;
        void this.process.request({ type: "prompt", message: prompt }, null).then(result => {
            if (this.activeTurn === turnId && record(result).agentInvoked === false)
                this.finish("completed");
        }, error => { if (this.activeTurn === turnId)
            this.finish(this.canceling ? "canceled" : "failed", errorText(error)); });
    }
    async steerActiveTurn(prompt: string): Promise<boolean> { if (!this.activeTurn)
        return false; await this.process.request({ type: "steer", message: prompt }); this.timeline({ type: "user_message", text: prompt }); return true; }
    private event(event: Record<string, unknown>): void {
        if (!this.activeTurn || this.closed)
            return;
        if (event.type === "message_start") {
            this.streamedText = false;
            this.streamedThinking = false;
        }
        if (event.type === "message_update") {
            const delta = record(event.assistantMessageEvent);
            if (delta.type === "text_delta" || delta.type === "thinking_delta") {
                if (delta.type === "text_delta")
                    this.streamedText = true;
                else
                    this.streamedThinking = true;
                this.timeline({ type: delta.type === "text_delta" ? "assistant_message" : "reasoning", text: text(delta.delta) });
            }
        }
        if (event.type === "message_end") {
            const message = record(event.message);
            if (message.role === "assistant" && Array.isArray(message.content))
                for (const block of message.content.map(record)) {
                    if ((block.type === "text" && !this.streamedText) || (block.type === "thinking" && !this.streamedThinking))
                        this.timeline({ type: block.type === "text" ? "assistant_message" : "reasoning", text: text(block.text ?? block.thinking) });
                }
            if (message.role === "assistant")
                this.captureUsage(message);
        }
        if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
            const id = text(event.toolCallId), name = text(event.toolName);
            const call = this.tools.get(id) ?? parseToolArgs(name, event.args);
            this.tools.set(id, call);
            const result = splitPiToolResultImages(parseToolResult(event.result ?? event.partialResult)).result;
            const detail = mapToolDetail(call, result);
            let displayName = name || call.toolName;
            if (displayName === "mcp") {
              const args = record(call.args), details = record(record(result).details);
              const server = text(details.server ?? args.server), tool = text(details.tool ?? args.tool);
              if (server && tool) displayName = `${server}.${tool.startsWith(`${server}_`) ? tool.slice(server.length + 1) : tool}`;
            }
            this.timeline({ type: "tool_call", callId: id, name: displayName, detail, ...(event.isError ? { status: "failed", error: result } : { status: event.type === "tool_execution_end" ? "completed" : "running", error: null }) });
            if (event.type === "tool_execution_end")
                this.tools.delete(id);
        }
        if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(text(event.method))) {
            const id = text(event.id);
            void this.ask({ id, name: text(event.method), kind: event.method === "confirm" ? "tool" : "question", title: text(event.title), description: text(event.message), input: event }).then(response => this.process.send({ type: "extension_ui_response", id, ...(response.behavior === "allow" ? { confirmed: true, value: response.updatedInput?.value ?? response.selectedActionId } : { confirmed: false, cancelled: true }) }));
        }
        if (event.type === "agent_end") {
            this.settledMessages = Array.isArray(event.messages) ? event.messages : [];
            if (event.willRetry === undefined)
                this.complete();
        }
        if (event.type === "agent_settled")
            this.complete();
    }
    private captureUsage(message: Record<string, unknown>): void {
        const usage = record(message.usage);
        if (!Object.keys(usage).length)
            return;
        const previous = this.usage ?? {};
        this.usage = {
            inputTokens: (previous.inputTokens ?? 0) + Number(usage.input ?? usage.inputTokens ?? 0),
            outputTokens: (previous.outputTokens ?? 0) + Number(usage.output ?? usage.outputTokens ?? 0),
            cachedInputTokens: (previous.cachedInputTokens ?? 0) + Number(usage.cacheRead ?? 0),
            totalCostUsd: (previous.totalCostUsd ?? 0) + Number(record(usage.cost).total ?? 0),
        };
    }
    private complete(): void {
        const failed = this.settledMessages.map(record).find(message => message.role === "assistant" && message.stopReason === "error");
        if (!this.usage)
            for (const message of this.settledMessages.map(record))
                if (message.role === "assistant")
                    this.captureUsage(message);
        const aborted = this.settledMessages.map(record).some(message => message.stopReason === "aborted");
        this.finish(this.canceling || aborted ? "canceled" : failed ? "failed" : "completed", failed ? text(failed.errorMessage) || "Pi failed" : undefined, this.usage);
    }
    async interrupt(): Promise<void> {
        if (!this.activeTurn)
            return;
        this.canceling = true;
        this.clearPermissions();
        try {
            await this.process.requestStopWork({ type: "abort" }, 2500);
            await this.waitForTurn();
        }
        catch {
            await this.close();
        }
    }
    async close(): Promise<void> { this.closed = true; this.finish("canceled"); await this.process.close(); await rm(this.dir, { recursive: true, force: true }); }
}
