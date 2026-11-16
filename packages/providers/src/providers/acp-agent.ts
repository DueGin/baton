// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/acp-agent.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
// Session-free Cursor discovery and question/dialect bridging also derive from Orca
// src/main/acp @a5781b8, Copyright (c) 2026 Lovecast Inc., MIT. Modified for baton.
import { Readable, Writable } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type Client, type McpServer, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification, type CreateTerminalRequest, type TerminalOutputResponse, type TerminalExitStatus } from "@agentclientprotocol/sdk";
import type { AgentClient, AgentPersistenceHandle, AgentSessionConfig, ClientOptions, ProviderCatalog, ToolCallTimelineItem } from "../agent-sdk-types.js";
import { ProviderSession, errorText, record, text } from "../session.js";
import { spawnProcess } from "../process.js";
import { terminateWithTreeKill } from "../tree-kill.js";
import { acpToolDetail, type TerminalSnapshot } from "./acp-tool-detail.js";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { type AcpAgentSpec, modeFlags, scrubAcpEnv, staticAcpCatalog } from "../acp-spec.js";
import { externalEnv } from "../process.js";
import { acpDialect } from "./acp-dialect.js";
import { formElicitation, cursorQuestion } from "./acp-elicitation.js";
export interface AcpClientOptions extends ClientOptions { spec?: AcpAgentSpec }
export class ACPAgentClient implements AgentClient {
    readonly provider = "acp" as const;
    readonly capabilities = { steer: false, resume: true, reasoning: true, mcp: true };
    constructor(protected readonly options: AcpClientOptions) { }
    async createSession(config: AgentSessionConfig): Promise<ACPSession> { return ACPSession.open(this.options, config); }
    async resumeSession(handle: AgentPersistenceHandle, config: AgentSessionConfig): Promise<ACPSession> { return ACPSession.open(this.options, config, handle); }
    async fetchCatalog(): Promise<ProviderCatalog> {
        await mkdir(this.options.home, { recursive: true });
        const cwd = await mkdtemp(join(this.options.home, "catalog-acp-"));
        let session: ACPSession | undefined;
        try {
            // Initialize and session-free extension RPCs only. Some agents retain
            // every session forever, even when the process and cwd are removed.
            session = await ACPSession.open(this.options, { cwd }, undefined, true);
            Object.assign(this.capabilities, session.detectedCapabilities);
            return session.catalog;
        }
        finally {
            await session?.close();
            await rm(cwd, { recursive: true, force: true });
        }
    }
}
export class GenericACPAgentClient extends ACPAgentClient {
}
class ACPSession extends ProviderSession implements Client {
    supportsLongToolCalls(): boolean { return this.options.spec?.longToolCalls === true && !!this.options.spec.toolTimeout; }
    processIds(): number[] { return this.child.pid && this.child.exitCode === null && this.child.signalCode === null ? [this.child.pid] : []; }
    private child: ChildProcessWithoutNullStreams;
    private connection: ClientSideConnection;
    private stderr = "";
    private tools = new Map<string, Record<string, unknown>>();
    private firstPrompt = true;
    private canceling = false;
    private canResume = false;
    detectedCapabilities = { steer: false, resume: false, reasoning: true, mcp: false };
    private terminals = new Map<string, TerminalSnapshot & {
        child: ChildProcessWithoutNullStreams;
        truncated: boolean;
        done: Promise<TerminalExitStatus>;
    }>();
    private usage?: import("../agent-sdk-types.js").AgentUsage;
    private totalCost = 0;
    private startingCost = 0;
    catalog: ProviderCatalog = { models: [], modes: [] };
    private constructor(private options: AcpClientOptions, config: AgentSessionConfig) {
        super("acp", config);
        const knob = options.spec?.toolTimeout;
        const env = scrubAcpEnv(externalEnv(options.spec?.env, options.env, config.env, knob ? { [knob.env]: String(knob.milliseconds) } : undefined), options.spec?.scrubEnv ?? []);
        this.child = spawnProcess(options.command[0]!, options.command.slice(1), { cwd: config.cwd, env, scrubEnv: options.spec?.scrubEnv });
        this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
        this.child.on("error", error => this.processExited(error.message));
        this.child.on("close", (code, signal) => this.processExited(`ACP exited (${code ?? signal}) ${this.stderr}`));
        this.connection = new ClientSideConnection(() => this, ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout)));
        void this.connection.closed.then(() => this.processExited(`ACP disconnected ${this.stderr}`));
    }
    static async open(options: AcpClientOptions, config: AgentSessionConfig, handle?: AgentPersistenceHandle, probe = false): Promise<ACPSession> {
        const session = new ACPSession(options, config);
        try {
            await session.initialize(handle, probe);
            return session;
        }
        catch (error) {
            await session.close();
            throw error;
        }
    }
    private startupTimeoutMs(): number { return this.options.timeoutMs ?? this.options.spec?.startupTimeoutMs ?? 30000; }
    private async bounded<T>(operation: Promise<T>): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([operation, this.connection.closed.then(() => { throw new Error(`ACP disconnected ${this.stderr}`); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`ACP request timed out after ${Math.round(this.startupTimeoutMs() / 1000)}s`)), this.startupTimeoutMs()); })]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    private async initialize(handle?: AgentPersistenceHandle, probe = false): Promise<void> {
        const elicitation = this.options.spec?.elicitation ?? { form: true, url: true };
        const clientCapabilities = { fs: { readTextFile: true, writeTextFile: true }, terminal: true, elicitation: { ...(elicitation.form ? { form: {} } : {}), ...(elicitation.url ? { url: {} } : {}) } };
        // Older ACP SDK typings predate elicitation. Keep the extension additive.
        const initialized = await this.bounded(this.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "baton", version: "0.1.0" }, clientCapabilities }));
        this.canResume = initialized.agentCapabilities?.loadSession ?? false;
        this.detectedCapabilities.resume = this.canResume;
        this.detectedCapabilities.mcp = this.options.spec?.mcp.supported !== false && this.options.spec?.mcp.http !== false && (initialized.agentCapabilities?.mcpCapabilities?.http ?? false);
        this.readCatalog({ ...record(record(initialized)._meta), ...record(initialized) });
        const rpc = this.options.spec?.modelCatalogRpc ?? (this.options.spec?.modelDiscovery === "cursor" ? "cursor/list_available_models" : undefined);
        if (rpc) {
            const response = await this.bounded(this.connection.extMethod(rpc, {}));
            if (Array.isArray(response.models)) this.catalog.models = response.models.map(record).map(model => ({ id: text(model.value ?? model.modelId ?? model.id), label: text(model.name ?? model.label), thinkingOptions: flattenOptions((Array.isArray(model.configOptions) ? model.configOptions.map(record) : []).find(o => o.category === "thought_level")?.options).map(o => ({ id: text(o.value), label: text(o.name) })) }));
        }
        if (probe) return;
        if (handle && !this.canResume)
            throw new Error("ACP agent does not support loading sessions");
        const mcpServers: McpServer[] = Object.entries(this.config.mcpServers ?? {}).map(([name, config]) => config.type === "stdio"
            ? { name, command: config.command, args: config.args ?? [], env: Object.entries(config.env ?? {}).map(([name, value]) => ({ name, value })) }
            : { name, type: config.type, url: config.url, headers: Object.entries(config.headers ?? {}).map(([name, value]) => ({ name, value })) });
        for (const server of mcpServers) {
            const transport = "type" in server ? server.type : "stdio";
            if (this.options.spec && (!this.options.spec.mcp.supported || !this.options.spec.mcp[transport])) throw new Error(`ACP agent ${this.options.spec.id} does not support ${transport} MCP injection`);
            if ("type" in server && server.type === "http" && !initialized.agentCapabilities?.mcpCapabilities?.http)
                throw new Error("ACP agent does not support HTTP MCP injection");
            if ("type" in server && server.type === "sse" && !initialized.agentCapabilities?.mcpCapabilities?.sse)
                throw new Error("ACP agent does not support SSE MCP injection");
        }
        const params = { cwd: resolve(this.config.cwd), mcpServers };
        const response = handle
            ? await this.bounded(this.connection.loadSession({ ...params, sessionId: handle.sessionId }))
            : await this.bounded(this.connection.newSession(params));
        this.identify(handle?.sessionId ?? text(record(response).sessionId));
        if (!this.sessionId)
            throw new Error("ACP did not return a session id");
        this.readCatalog(record(response));
        const configOptions = Array.isArray(record(response).configOptions) ? (record(response).configOptions as unknown[]).map(record) : [];
        const modeSelector = configOptions.find(option => option.category === "mode");
        const modelSelector = configOptions.find(option => option.category === "model");
        if (this.config.modeId) {
            if (this.options.spec?.dialect === "copilot" && this.config.modeId === "allow-all") {
                await this.bounded(this.connection.setSessionMode({ sessionId: this.sessionId, modeId: "https://agentclientprotocol.com/protocol/session-modes#agent" }));
                await this.bounded(this.connection.setSessionConfigOption({ sessionId: this.sessionId, configId: "allow_all", value: "on" }));
            } else if (this.options.spec?.dialect === "copilot") {
                await this.bounded(this.connection.setSessionConfigOption({ sessionId: this.sessionId, configId: "allow_all", value: "off" }));
                await this.bounded(this.connection.setSessionMode({ sessionId: this.sessionId, modeId: this.config.modeId }));
            } else if (modeSelector && typeof modeSelector.id === "string")
                await this.bounded(this.connection.setSessionConfigOption({ sessionId: this.sessionId, configId: modeSelector.id, value: this.config.modeId }));
            else
                await this.bounded(this.connection.setSessionMode({ sessionId: this.sessionId, modeId: this.config.modeId }));
        }
        else
            this.config.modeId = this.catalog.defaultModeId ?? undefined;
        if (this.config.model) {
            if (modelSelector && typeof modelSelector.id === "string")
                await this.bounded(this.connection.setSessionConfigOption({ sessionId: this.sessionId, configId: modelSelector.id, value: this.config.model }));
            else
                await this.bounded(this.connection.unstable_setSessionModel({ sessionId: this.sessionId, modelId: this.config.model }));
        }
        else
            this.config.model = text(record(record(response).models).currentModelId) || text(modelSelector?.currentValue) || undefined;
        if (this.config.thinking) {
            const options = record(response).configOptions;
            const option = Array.isArray(options) ? options.map(record).find(o => o.category === "thought_level") : undefined;
            if (option && typeof option.id === "string")
                await this.bounded(this.connection.setSessionConfigOption({ sessionId: this.sessionId, configId: option.id, value: this.config.thinking }));
            else
                throw new Error("ACP agent did not advertise a thinking selector");
        }
    }
    override getPersistence(): AgentPersistenceHandle | null { return this.canResume ? super.getPersistence() : null; }
    private readCatalog(response: Record<string, unknown>): void {
        const modes = record(response.modes);
        const models = record(response.models);
        this.catalog = {
            modes: Array.isArray(modes.availableModes) ? modes.availableModes.map(record).map(mode => ({ id: text(mode.id), label: text(mode.name), description: text(mode.description), ...modeFlags(text(mode.id), this.options.spec?.modeMap) })) : staticAcpCatalog(this.options.spec).modes,
            models: Array.isArray(models.availableModels) ? models.availableModels.map(record).map(model => ({ id: text(model.modelId), label: text(model.name), description: text(model.description), isDefault: model.modelId === models.currentModelId })) : this.catalog.models,
            defaultModeId: text(modes.currentModeId) || null,
        };
        const configs = response.configOptions;
        if (Array.isArray(configs))
            for (const option of configs.map(record)) {
                const options = flattenOptions(option.options);
                if (option.category === "model" && !this.catalog.models.length)
                    this.catalog.models = options.map(o => ({ id: text(o.value), label: text(o.name), isDefault: o.value === option.currentValue }));
                if (option.category === "mode" && !Array.isArray(modes.availableModes)) {
                    this.catalog.modes = options.map(o => ({ id: text(o.value), label: text(o.name), ...modeFlags(text(o.value), this.options.spec?.modeMap) }));
                    this.catalog.defaultModeId = text(option.currentValue) || null;
                }
                if (option.category === "thought_level")
                    for (const model of this.catalog.models)
                        model.thinkingOptions = options.map(o => ({ id: text(o.value), label: text(o.name), isDefault: o.value === option.currentValue }));
            }
        if (this.options.spec?.dialect === "copilot") {
            this.catalog.modes = this.catalog.modes.filter(mode => !mode.id.endsWith("#autopilot") && mode.id !== "allow-all");
            this.catalog.modes.push({ id: "allow-all", label: "Allow All", isUnattended: true });
            if (this.catalog.defaultModeId?.endsWith("#autopilot")) this.catalog.defaultModeId = "https://agentclientprotocol.com/protocol/session-modes#agent";
            if (Array.isArray(configs) && configs.map(record).some(o => o.id === "allow_all" && o.currentValue === "on")) this.catalog.defaultModeId = "allow-all";
        }
    }
    protected async launchTurn(prompt: string): Promise<void> {
        this.canceling = false;
        this.usage = undefined;
        this.startingCost = this.totalCost;
        const turnId = this.activeTurn;
        const input = this.firstPrompt && this.config.systemPrompt ? `${this.config.systemPrompt}\n\n${prompt}` : prompt;
        this.firstPrompt = false;
        void this.connection.prompt({ sessionId: this.sessionId!, prompt: [{ type: "text", text: input }] }).then(response => {
            if (this.activeTurn !== turnId)
                return;
            this.finish(response.stopReason === "cancelled" || this.canceling ? "canceled" : "completed", undefined, this.usage);
        }, error => { if (this.activeTurn === turnId)
            this.finish(this.canceling ? "canceled" : "failed", errorText(error)); });
    }
    async sessionUpdate(notification: SessionNotification): Promise<void> {
        if (this.closed || (this.sessionId && notification.sessionId !== this.sessionId))
            return;
        const update = record(notification.update);
        switch (update.sessionUpdate) {
            case "agent_message_chunk":
            case "agent_thought_chunk": {
                const content = record(update.content);
                if (content.type === "text")
                    this.timeline({ type: update.sessionUpdate === "agent_message_chunk" ? "assistant_message" : "reasoning", text: text(content.text) });
                break;
            }
            case "tool_call":
            case "tool_call_update": {
                const id = text(update.toolCallId);
                const dialect = acpDialect(this.options.spec);
                const next = { ...this.tools.get(id), ...Object.fromEntries(Object.entries(update).filter(([key, value]) => value !== undefined && (!(key === "title" || key === "kind" || key === "status" || key === "content" || key === "locations") || value !== null))) };
                const merged = dialect.normalizeTool?.(next) ?? next;
                this.tools.set(id, merged);
                const name = dialect.toolName?.(merged) ?? (text(merged.title) || text(merged.kind) || "tool");
                const status = merged.status === "completed" ? "completed" : merged.status === "failed" ? "failed" : "running";
                const output = Array.isArray(merged.content) ? merged.content.map(record).map(c => text(record(c.content).text)).filter(Boolean).join("\n") : "";
                const detail = acpToolDetail(merged, this.terminals);
                const item: ToolCallTimelineItem = { type: "tool_call", callId: id, name, detail, ...(status === "failed" ? { status, error: output || "Tool failed" } : { status, error: null }) };
                this.timeline(item);
                if (status !== "running")
                    this.tools.delete(id);
                break;
            }
            case "plan": {
                if (Array.isArray(update.entries))
                    this.timeline({ type: "todo", items: update.entries.map(record).map(entry => ({ text: text(entry.content), status: entry.status === "completed" ? "completed" : entry.status === "in_progress" ? "in_progress" : "pending" })) });
                break;
            }
            case "current_mode_update":
                this.config.modeId = text(update.currentModeId);
                this.emit({ type: "mode_changed", currentModeId: this.config.modeId });
                break;
            case "config_option_update": {
                const oldModel = this.config.model, oldMode = this.config.modeId;
                this.readCatalog(update);
                for (const option of Array.isArray(update.configOptions) ? update.configOptions.map(record) : []) {
                    if (option.category === "model")
                        this.config.model = text(option.currentValue);
                    if (option.category === "mode")
                        this.config.modeId = text(option.currentValue);
                }
                if (oldModel !== this.config.model)
                    this.emit({ type: "model_changed", model: this.config.model ?? null });
                if (oldMode !== this.config.modeId)
                    this.emit({ type: "mode_changed", currentModeId: this.config.modeId ?? null });
                break;
            }
            case "usage_update": {
                const cost = record(update.cost);
                if (cost.currency === "USD" && typeof cost.amount === "number")
                    this.totalCost = cost.amount;
                this.usage = {
                    ...(typeof update.used === "number" ? { contextWindowUsedTokens: update.used } : {}), ...(typeof update.size === "number" ? { contextWindowMaxTokens: update.size } : {}), ...(cost.currency === "USD" && typeof cost.amount === "number" ? { totalCostUsd: Math.max(0, cost.amount - this.startingCost) } : {}),
                };
                this.emit({ type: "usage_updated", ...(this.activeTurn ? { turnId: this.activeTurn } : {}), usage: this.usage });
                break;
            }
        }
    }
    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === "elicitation/create" || method === "_elicitation/create") {
            if (params.mode === "url") {
                if (this.options.spec?.elicitation.url === false) return { action: "cancel" };
                const url = new URL(text(params.url));
                if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported elicitation URL protocol");
                this.timeline({ type: "notification", level: "info", message: `${text(params.message)}\n${url.href}` });
                // Merely showing a link is not consent or a completed sign-in.
                return { action: "cancel" };
            }
            if (this.options.spec?.elicitation.form === false) return { action: "cancel" };
            const form = formElicitation({ ...params, mode: "form" });
            return this.askExtensionQuestion(form);
        }
        if (this.options.spec?.dialect === "cursor" && method === "cursor/ask_question") {
            const question = cursorQuestion(params);
            return this.askExtensionQuestion(question);
        }
        if (this.options.spec?.dialect === "cursor" && ["cursor/update_todos", "cursor/task", "cursor/generate_image"].includes(method)) return {};
        throw new Error(`Unsupported ACP extension method: ${method}`);
    }
    private async askExtensionQuestion(question: import("./acp-elicitation.js").AcpQuestion): Promise<Record<string, unknown>> {
        const id = randomUUID(), name = question.request.name;
        const input = { ...question.request.input, callId: id };
        this.timeline({ type: "tool_call", callId: id, name, status: "running", error: null, detail: { type: "unknown", input, output: null } });
        try {
            const response = await this.ask({ ...question.request, id, input });
            const result = question.reply(response);
            this.timeline({ type: "tool_call", callId: id, name, status: response.behavior === "allow" ? "completed" : "canceled", error: null, detail: { type: "unknown", input, output: result } });
            return result;
        } catch (error) {
            this.timeline({ type: "tool_call", callId: id, name, status: "failed", error: errorText(error), detail: { type: "unknown", input, output: errorText(error) } });
            throw error;
        }
    }
    async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
        const message = acpDialect(this.options.spec).extensionNotification?.(method, params);
        if (message) this.timeline({ type: "notification", level: "info", message });
    }
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const call = params.toolCall;
        const id = randomUUID();
        // Cursor's legacy fallback offers question choices as allow_once entries.
        // Keep them on the human-question path so autoApprove cannot pick an answer.
        if (this.options.spec?.dialect === "cursor" && params.options.some(o => o.optionId === "__ask_question_skip__")) {
            const options = params.options.filter(o => o.optionId !== "__ask_question_skip__");
            const response = await this.ask({ id, name: "cursor_ask_question", kind: "question", input: { callId: call.toolCallId, questions: [{ id: "q1", question: call.title ?? "Choose an answer", options: options.map(o => ({ label: o.name })) }] } });
            const values = record(response.behavior === "allow" ? response.updatedInput?.answers : undefined);
            const labels = Array.isArray(values.q1) ? values.q1 : [];
            const selected = options.find(o => o.name === labels[0]);
            return { outcome: selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" } };
        }
        const dialect = acpDialect(this.options.spec), tool = dialect.normalizeTool?.(record(call)) ?? record(call);
        const description = this.options.spec?.dialect === "kimi" && Array.isArray(call.content) ? call.content.map(record).map(c => text(record(c.content).text).match(/^Requesting approval to ([\s\S]+)$/)?.[1]).find(Boolean)?.slice(0, 512) : undefined;
        const response = await this.ask({ id, name: dialect.toolName?.(tool) ?? call.title ?? "tool", kind: "tool", description, input: { ...record(call.rawInput), callId: call.toolCallId }, detail: acpToolDetail(tool, this.terminals), actions: params.options.map(option => ({ id: option.optionId, label: option.name, behavior: option.kind.startsWith("allow") ? "allow" : "deny" })) });
        const selected = params.options.find(o => o.optionId === response.selectedActionId && (o.kind.startsWith("allow") ? "allow" : "deny") === response.behavior)
            ?? params.options.find(o => response.behavior === "allow" ? o.kind === "allow_once" : o.kind === "reject_once")
            ?? params.options.find(o => response.behavior === "allow" ? o.kind.startsWith("allow") : o.kind.startsWith("reject"));
        return { outcome: selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" } };
    }
    async readTextFile(params: {
        path: string;
        line?: number | null;
        limit?: number | null;
    }): Promise<{
        content: string;
    }> {
        const content = await readFile(resolve(this.config.cwd, params.path), "utf8");
        const start = Math.max(0, (params.line ?? 1) - 1);
        return { content: content.split("\n").slice(start, params.limit ? start + params.limit : undefined).join("\n") };
    }
    async writeTextFile(params: {
        path: string;
        content: string;
    }): Promise<Record<string, never>> {
        const path = resolve(this.config.cwd, params.path);
        await mkdir(resolve(path, ".."), { recursive: true });
        await writeFile(path, params.content);
        return {};
    }
    private terminal(id: string) {
        const entry = this.terminals.get(id);
        if (!entry)
            throw new Error(`Unknown ACP terminal ${id}`);
        return entry;
    }
    async createTerminal(params: CreateTerminalRequest): Promise<{
        terminalId: string;
    }> {
        if (this.closed)
            throw new Error("ACP session closed");
        const id = randomUUID();
        const command = params.args?.length ? params.command : process.platform === "win32" ? "cmd.exe" : "/bin/sh";
        const args = params.args?.length ? params.args : process.platform === "win32" ? ["/d", "/s", "/c", params.command] : ["-c", params.command];
        const cwd = params.cwd ?? this.config.cwd;
        const child = spawnProcess(command, args, { cwd, envOverlay: { ...this.options.env, ...this.config.env, ...Object.fromEntries((params.env ?? []).map(entry => [entry.name, entry.value])) }, scrubEnv: this.options.spec?.scrubEnv });
        let settle!: (exit: TerminalExitStatus) => void;
        const done = new Promise<TerminalExitStatus>(resolve => { settle = resolve; });
        const entry = { child, command: [params.command, ...(params.args ?? [])].join(" "), cwd, output: "", truncated: false, done, exit: undefined as TerminalExitStatus | undefined };
        const limit = Math.max(0, Math.min(params.outputByteLimit ?? 1024 * 1024, 8 * 1024 * 1024));
        const append = (value: string) => {
            entry.output += value;
            if (Buffer.byteLength(entry.output) > limit) {
                const bytes = Buffer.from(entry.output);
                let start = bytes.length - limit;
                while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)
                    start++;
                entry.output = bytes.subarray(start).toString("utf8");
                entry.truncated = true;
            }
        };
        for (const stream of [child.stdout, child.stderr]) {
            const decoder = new StringDecoder("utf8");
            stream.on("data", (chunk: Buffer) => append(decoder.write(chunk)));
            stream.on("end", () => append(decoder.end()));
        }
        child.once("error", error => { append(error.message); entry.exit = { exitCode: 1 }; settle(entry.exit); });
        child.once("close", (exitCode, signal) => { entry.exit = { exitCode, signal }; settle(entry.exit); });
        this.terminals.set(id, entry);
        return { terminalId: id };
    }
    async terminalOutput(params: {
        terminalId: string;
    }): Promise<TerminalOutputResponse> { const entry = this.terminal(params.terminalId); return { output: entry.output, truncated: entry.truncated, exitStatus: entry.exit }; }
    async waitForTerminalExit(params: {
        terminalId: string;
    }): Promise<TerminalExitStatus> { return this.terminal(params.terminalId).done; }
    async killTerminal(params: {
        terminalId: string;
    }): Promise<Record<string, never>> { await terminateWithTreeKill(this.terminal(params.terminalId).child, { gracefulTimeoutMs: 500, forceTimeoutMs: 500 }); return {}; }
    async releaseTerminal(params: {
        terminalId: string;
    }): Promise<void> { await this.killTerminal(params); this.terminals.delete(params.terminalId); }
    private async stopTerminals(): Promise<void> { await Promise.all([...this.terminals.keys()].map(id => this.killTerminal({ terminalId: id }))); }
    async interrupt(): Promise<void> {
        if (!this.activeTurn)
            return;
        this.canceling = true;
        this.clearPermissions();
        try {
            await this.connection.cancel({ sessionId: this.sessionId! });
            await this.waitForTurn();
            await this.stopTerminals();
        }
        catch {
            await this.close();
        }
    }
    async close(): Promise<void> {
        await this.stopTerminals();
        if (this.closed) {
            await terminateWithTreeKill(this.child, { gracefulTimeoutMs: 500, forceTimeoutMs: 500 });
            return;
        }
        this.closed = true;
        this.finish("canceled");
        await terminateWithTreeKill(this.child, { gracefulTimeoutMs: 500, forceTimeoutMs: 500 });
    }
}
function flattenOptions(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.map(record).flatMap(option => Array.isArray(option.options) ? flattenOptions(option.options) : [option]) : [];
}
