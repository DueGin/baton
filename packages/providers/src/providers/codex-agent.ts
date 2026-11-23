// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/codex-app-server-agent.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import pino from "pino";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentClient, AgentPersistenceHandle, AgentPromptInput, AgentRewindPoint, AgentSessionConfig, AgentSlashCommand, AgentUsage, ClientOptions, ProviderCatalog, ToolCallTimelineItem } from "../agent-sdk-types.js";
import { OrderedTasks, imageFileExists, imageMarkdown, imageNote, promptText, saveProviderImages, type ProviderImage } from "../images.js";
import { ProviderSession, record, text } from "../session.js";
import { externalEnv, spawnProcess } from "../process.js";
import { CodexAppServerClient, CodexAppServerRpcError } from "./codex/app-server-transport.js";
import { CodexAppServerStartupCoordinator } from "./codex/app-server-startup.js";
import { listCodexTurns, parseCodexRewindPoint, revertCodexConversation } from "./codex/rewind.js";
import { mapCodexToolCallFromThreadItem, splitCodexMcpToolResultImages } from "./codex/tool-call-mapper.js";
import { CodexSlashCommands } from "./codex/slash-commands.js";
import { COMMAND_TIMEOUT_MS } from "./slash-commands.js";
const startup = new CodexAppServerStartupCoordinator();
/** Text items plus `localImage` items at their position (Paseo codexAppServerTurnInputFromPrompt). */
export async function codexTurnInput(prompt: AgentPromptInput, expand?: CodexSlashCommands["expand"]): Promise<Array<Record<string, unknown>>> {
    if (typeof prompt === "string")
        return expand ? expand(prompt) : [{ type: "text", text: prompt }];
    const input: Array<Record<string, unknown>> = [];
    for (const part of prompt) {
        if (part.type === "text") {
            if (part.text) {
                input.push(...(expand ? await expand(part.text) : [{ type: "text", text: part.text }]));
                expand = undefined;
            }
        }
        else if (await imageFileExists(part.path))
            input.push({ type: "localImage", path: part.path });
        else
            input.push({ type: "text", text: imageNote(part) });
    }
    return input.length ? input : [{ type: "text", text: "" }];
}
/** Generated image payloads: a saved file, or a result string/object (base64, data: URI, path). */
function codexGeneratedImage(item: Record<string, unknown>): ProviderImage | null {
    const saved = text(item.savedPath ?? item.saved_path);
    if (saved)
        return { path: saved, name: "生成的图片" };
    const result = item.result;
    if (typeof result === "string") {
        const value = result.trim();
        return value.toLowerCase().startsWith("data:image/") || (/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(value) && value.length > 64) ? { data: value, name: "生成的图片" } : null;
    }
    const object = record(result);
    const path = text(object.path ?? object.savedPath ?? object.saved_path), data = text(object.data), mimeType = text(object.mimeType ?? object.mime_type) || null;
    return path ? { path, mimeType, name: "生成的图片" } : data ? { data, mimeType, name: "生成的图片" } : null;
}
const MODES = [
    { id: "default", label: "Default", description: "Workspace write with approval requests" },
    { id: "read-only", label: "Read only", isReadOnly: true },
    { id: "full-access", label: "Full access", isUnattended: true },
];
export class CodexAppServerAgentClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = { steer: true, resume: true, reasoning: true, mcp: true, images: true };
    constructor(private options: ClientOptions) { }
    async createSession(config: AgentSessionConfig): Promise<CodexSession> { return CodexSession.open(this.options, config); }
    async resumeSession(handle: AgentPersistenceHandle, config: AgentSessionConfig): Promise<CodexSession> { return CodexSession.open(this.options, config, handle); }
    async listCommands(cwd: string): Promise<AgentSlashCommand[]> { return new CodexSlashCommands(cwd, externalEnv(this.options.env)).list(); }
    async fetchCatalog(): Promise<ProviderCatalog> {
        await mkdir(this.options.home, { recursive: true });
        const cwd = await mkdtemp(join(this.options.home, "catalog-codex-"));
        let client: CodexAppServerClient | undefined;
        try {
            client = await connect(this.options, { cwd });
            const models: ProviderCatalog["models"] = [];
            let cursor: string | null = null;
            const cursors = new Set<string>();
            do {
                const response = record(await client.request("model/list", { cursor, limit: 100, includeHidden: false }, this.options.timeoutMs ?? 10000));
                for (const model of Array.isArray(response.data) ? response.data.map(record) : [])
                    models.push({
                        id: text(model.id), label: text(model.displayName) || text(model.model) || text(model.id), description: text(model.description), isDefault: model.isDefault === true,
                        thinkingOptions: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map(record).map(effort => ({ id: text(effort.reasoningEffort), label: text(effort.reasoningEffort), isDefault: effort.reasoningEffort === model.defaultReasoningEffort })),
                    });
                cursor = text(response.nextCursor) || null;
                if (cursor && cursors.has(cursor))
                    throw new Error("Codex model catalog repeated a pagination cursor");
                if (cursor)
                    cursors.add(cursor);
            } while (cursor);
            return { models, modes: MODES, defaultModeId: "default" };
        }
        finally {
            await client?.dispose();
            await rm(cwd, { recursive: true, force: true });
        }
    }
}
async function connect(options: ClientOptions, config: AgentSessionConfig): Promise<CodexAppServerClient> {
    const logger = options.logger ?? pino({ enabled: false });
    const { client } = await startup.start({
        stateDirKey: config.env?.CODEX_HOME ?? options.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? "default", logger,
        spawn: () => spawnProcess(options.command[0]!, [...options.command.slice(1), "app-server"], { cwd: config.cwd, envOverlay: { ...options.env, ...config.env } }),
        createClient: child => new CodexAppServerClient(child, logger),
        initializeParams: { clientInfo: { name: "baton", version: "0.1.0" }, capabilities: { experimentalApi: true } },
    });
    return client;
}
class CodexSession extends ProviderSession {
    supportsLongToolCalls(): boolean { return !!this.config.mcpServers?.baton; }
    processIds(): number[] { return this.client?.processIds() ?? []; }
    private client!: CodexAppServerClient;
    private commands!: CodexSlashCommands;
    private nativeTurn: string | null = null;
    private usage?: AgentUsage;
    private seenText = new Set<string>();
    private canceling = false;
    private terminalIds = new Set<string>();
    private previousUsage: AgentUsage = {};
    private totalUsage: AgentUsage = {};
    private options!: ClientOptions;
    /** Keeps notification order while an image is being stored. */
    private inbound = new OrderedTasks();
    /** Native turn ids of the current thread, in order; null until read (resumed threads). */
    private threadTurns: string[] | null = [];
    private turnPoint: AgentRewindPoint | null = null;
    private constructor(config: AgentSessionConfig) { super("codex", config); }
    static async open(options: ClientOptions, config: AgentSessionConfig, handle?: AgentPersistenceHandle): Promise<CodexSession> {
        const session = new CodexSession(config);
        session.options = options;
        if (config.modeId && !["default", "read-only", "full-access", "bypass"].includes(config.modeId))
            throw new Error(`Unsupported Codex mode ${config.modeId}`);
        try {
            session.client = await connect(options, config);
            session.commands = new CodexSlashCommands(config.cwd, externalEnv(options.env, config.env), session.client, Math.min(options.timeoutMs ?? COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MS));
            session.client.setNotificationHandler((method, params) => session.inbound.run(() => session.notification(method, record(params))));
            session.client.setUnexpectedTerminationHandler(error => session.processExited(error.message));
            for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/mcpToolCall/requestApproval", "item/tool/requestUserInput", "tool/requestUserInput", "mcpServer/elicitation/request"])
                session.client.setRequestHandler(method, params => session.permission(method, record(params)));
            const mcpServers = Object.fromEntries(Object.entries(config.mcpServers ?? {}).map(([name, server]) => [name, { ...(server.type === "stdio" ? { command: server.command, args: server.args, env: server.env } : { url: server.url, http_headers: server.headers }), ...(name === "baton" ? { tool_timeout_sec: Math.ceil(Number(config.env?.MCP_TOOL_TIMEOUT ?? 3660000) / 1000) } : {}) }]));
            const full = config.modeId === "full-access" || config.modeId === "bypass";
            const params = {
                cwd: config.cwd, ...(config.model ? { model: config.model } : {}),
                approvalPolicy: full ? "never" : "on-request", sandbox: full ? "danger-full-access" : config.modeId === "read-only" ? "read-only" : "workspace-write",
                ...(config.systemPrompt ? { developerInstructions: config.systemPrompt } : {}),
                config: { mcp_servers: mcpServers }, ...(handle ? { threadId: handle.sessionId } : {}),
            };
            const response = record(await session.client.request(handle ? "thread/resume" : "thread/start", params, options.timeoutMs ?? 30000));
            const id = text(record(response.thread).id);
            if (!id)
                throw new Error("Codex did not return thread id");
            session.identify(id);
            if (handle) session.threadTurns = null;
            session.config.model = text(response.model) || config.model;
            session.config.modeId ??= "default";
            return session;
        }
        catch (error) {
            await session.client?.dispose();
            throw error;
        }
    }
    private rememberTurn(id: string): void { if (id && this.threadTurns && this.threadTurns.at(-1) !== id) this.threadTurns.push(id); }
    async listCommands(): Promise<AgentSlashCommand[]> { return this.commands.list(); }
    rewindPoint(): AgentRewindPoint | null { return this.turnPoint; }
    async rewindConversation(value: AgentRewindPoint): Promise<void> {
        if (this.activeTurn) throw new Error("Cannot rewind the Codex conversation while a turn is active");
        const point = parseCodexRewindPoint(value);
        const thread = await revertCodexConversation(this.client, point, { cwd: this.config.cwd, ...(this.config.model ? { model: this.config.model } : {}) });
        // The host closes this session and resumes the new thread (or starts a fresh one) for the next message.
        this.sessionId = thread; this.threadTurns = null;
    }
    protected async launchTurn(prompt: AgentPromptInput): Promise<void> {
        if (this.threadTurns === null && this.sessionId) this.threadTurns = await listCodexTurns(this.client, this.sessionId).catch(() => null);
        this.turnPoint = this.sessionId && this.threadTurns ? { threadId: this.sessionId, turnId: this.threadTurns.at(-1) ?? null, index: this.threadTurns.length - 1 } : null;
        const input = await codexTurnInput(prompt, value => this.commands.expand(value));
        this.canceling = false;
        this.nativeTurn = null;
        this.usage = undefined;
        this.previousUsage = { ...this.totalUsage };
        this.terminalIds.clear();
        this.seenText.clear();
        const turnId = this.activeTurn;
        const result = record(await this.client.request("turn/start", { threadId: this.sessionId, input, ...(this.config.model ? { model: this.config.model } : {}), ...(this.config.thinking ? { effort: this.config.thinking } : {}), cwd: this.config.cwd }, 90000));
        if (this.activeTurn === turnId)
            this.nativeTurn = text(record(result.turn).id) || this.nativeTurn;
        if (this.nativeTurn) this.rememberTurn(this.nativeTurn);
    }
    async steerActiveTurn(prompt: AgentPromptInput): Promise<boolean> {
        const turnId = this.activeTurn, expectedTurnId = this.nativeTurn;
        if (!turnId || !expectedTurnId)
            return false;
        try {
            const input = await codexTurnInput(prompt, value => this.commands.expand(value));
            if (this.activeTurn !== turnId || this.nativeTurn !== expectedTurnId)
                return false;
            await this.client.request("turn/steer", { threadId: this.sessionId, expectedTurnId, input }, 10000);
            this.timeline({ type: "user_message", text: promptText(prompt) });
            return true;
        }
        catch (error) {
            if (error instanceof CodexAppServerRpcError && (error.code === -32601 || error.code === -32602))
                return false;
            throw error;
        }
    }
    private notification(method: string, params: Record<string, unknown>): void | Promise<void> {
        if (this.closed)
            return;
        if (params.threadId && params.threadId !== this.sessionId && this.sessionId)
            return;
        if (method === "thread/tokenUsage/updated" && !this.activeTurn) {
            const total = record(record(params.tokenUsage).total);
            this.totalUsage = { ...(typeof total.inputTokens === "number" ? { inputTokens: total.inputTokens } : {}), ...(typeof total.outputTokens === "number" ? { outputTokens: total.outputTokens } : {}), ...(typeof total.cachedInputTokens === "number" ? { cachedInputTokens: total.cachedInputTokens } : {}) };
            return;
        }
        const turn = record(params.turn);
        if (method === "turn/started") {
            if (this.activeTurn) {
                this.nativeTurn = text(turn.id);
                this.rememberTurn(this.nativeTurn);
            }
            return;
        }
        if (method === "turn/completed") {
            if (this.nativeTurn && turn.id !== this.nativeTurn)
                return;
            const status = turn.status;
            this.nativeTurn = null;
            this.finish(this.canceling || status === "interrupted" ? "canceled" : status === "failed" ? "failed" : "completed", text(record(turn.error).message) || undefined, this.usage);
            return;
        }
        if (!this.activeTurn)
            return;
        if (params.turnId && this.nativeTurn && params.turnId !== this.nativeTurn)
            return;
        if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
            const type = method === "item/agentMessage/delta" ? "assistant_message" : "reasoning";
            this.seenText.add(`${type}:${text(params.itemId)}`);
            this.timeline({ type, text: text(params.delta) });
            return;
        }
        if (method === "item/started" || method === "item/completed") {
            const item = record(params.item);
            const handled = this.itemImages(method, item);
            if (handled !== false)
                return handled === true ? undefined : handled;
            if (item.type === "commandExecution" && typeof item.processId === "string") {
                if (method === "item/started")
                    this.terminalIds.add(item.processId);
                if (method === "item/completed" && item.status === "completed")
                    this.terminalIds.delete(item.processId);
            }
            if (item.type === "agentMessage" && method === "item/completed" && !this.seenText.has(`assistant_message:${text(item.id)}`))
                this.timeline({ type: "assistant_message", text: text(item.text), messageId: text(item.id) });
            else if (item.type === "reasoning" && method === "item/completed" && !this.seenText.has(`reasoning:${text(item.id)}`)) {
                const summary = Array.isArray(item.summary) ? item.summary.filter(s => typeof s === "string").join("\n") : "";
                if (summary)
                    this.timeline({ type: "reasoning", text: summary });
            }
            else {
                const tool = mapCodexToolCallFromThreadItem(item, { cwd: this.config.cwd });
                if (tool)
                    this.timeline(method === "item/started" ? { ...tool, status: "running", error: null } : tool);
            }
            return;
        }
        if (method === "thread/tokenUsage/updated") {
            const tokenUsage = record(params.tokenUsage), total = record(tokenUsage.total);
            this.usage = {
                ...(typeof total.inputTokens === "number" ? { inputTokens: total.inputTokens } : {}),
                ...(typeof total.cachedInputTokens === "number" ? { cachedInputTokens: total.cachedInputTokens } : {}),
                ...(typeof total.outputTokens === "number" ? { outputTokens: total.outputTokens } : {}),
                ...(typeof tokenUsage.modelContextWindow === "number" ? { contextWindowMaxTokens: tokenUsage.modelContextWindow } : {}),
                ...(typeof record(tokenUsage.last).totalTokens === "number" ? { contextWindowUsedTokens: record(tokenUsage.last).totalTokens as number } : {}),
            };
            this.totalUsage = { ...this.usage };
            for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"] as const)
                if (this.usage[key] !== undefined)
                    this.usage[key] = Math.max(0, this.usage[key]! - (this.previousUsage[key] ?? 0));
            this.emit({ type: "usage_updated", turnId: this.activeTurn, usage: this.usage });
        }
        if (method === "error" && params.willRetry !== true)
            this.finish("failed", text(record(params.error).message) || "Codex error");
    }
    /** Image-bearing items (MCP image results, view_image, image generation): true when handled
     * synchronously, a promise while an image is stored, false for every other item. */
    private itemImages(method: string, item: Record<string, unknown>): boolean | Promise<void> {
        const save = this.options.saveImage, id = text(item.id);
        if (item.type === "imageGeneration" || item.type === "ImageGeneration") {
            const input = { prompt: text(item.revisedPrompt ?? item.revised_prompt) || undefined };
            const running: ToolCallTimelineItem = { type: "tool_call", callId: id, name: "image_generation", status: "running", error: null, detail: { type: "unknown", input, output: null } };
            if (method === "item/started") {
                this.timeline(running);
                return true;
            }
            if (item.status === "failed") {
                this.timeline({ ...running, status: "failed", error: item.failure ?? item.error ?? "Image generation failed" });
                return true;
            }
            const image = codexGeneratedImage(item);
            return saveProviderImages(save, image ? [image] : []).then(([ref]) => {
                if (this.closed || !this.activeTurn)
                    return;
                const path = image && "path" in image ? image.path : undefined;
                this.timeline({ ...running, status: "completed", detail: { type: "unknown", input, output: ref ? { attachment: ref.id } : path ? { path } : null } });
                // Unstored but saved by Codex: a local-path image the console serves via /api/files/image.
                this.timeline({ type: "assistant_message", text: ref ? imageMarkdown(ref, "生成的图片") : path ? `\n\n![生成的图片](${encodeURI(path)})\n\n` : "\n\n[图片生成完成，但无法保存输出文件]\n\n" });
            });
        }
        if (method !== "item/completed" || !save)
            return false;
        if ((item.type === "imageView" || item.type === "ImageView") && text(item.path)) {
            return saveProviderImages(save, [{ path: text(item.path) }]).then(images => {
                if (!this.closed && this.activeTurn)
                    this.timeline({ type: "tool_call", callId: id, name: "view_image", status: "completed", error: null, detail: { type: "read", filePath: text(item.path) }, ...(images.length ? { images } : {}) });
            });
        }
        if (item.type !== "mcpToolCall")
            return false;
        const found = splitCodexMcpToolResultImages(item.result ?? null).images;
        if (!found.length)
            return false;
        return saveProviderImages(save, found).then(images => {
            const tool = mapCodexToolCallFromThreadItem(item, { cwd: this.config.cwd });
            if (tool && !this.closed && this.activeTurn)
                this.timeline(images.length ? { ...tool, images } : tool);
        });
    }
    private async permission(method: string, params: Record<string, unknown>): Promise<unknown> {
        const id = `permission-${text(params.approvalId) || text(params.itemId) || crypto.randomUUID()}`;
        const question = method === "item/tool/requestUserInput" || method === "tool/requestUserInput";
        const elicitation = method === "mcpServer/elicitation/request";
        const response = await this.ask({ id, name: question ? "request_user_input" : elicitation ? "mcp_elicitation" : method.includes("fileChange") ? "file_change" : "command_execution", kind: question || elicitation ? "question" : "tool", description: text(params.reason), input: params, ...(params.command ? { detail: { type: "shell", command: text(params.command), cwd: text(params.cwd) } as const } : {}) });
        if (elicitation) return { action: response.behavior === "allow" ? "accept" : "decline", content: response.behavior === "allow" ? response.updatedInput ?? {} : null, _meta: null };
        if (question)
            return { answers: response.behavior === "allow" ? response.updatedInput?.answers ?? {} : {} };
        if (method === "item/permissions/requestApproval")
            return { permissions: response.behavior === "allow" ? params.permissions : {}, scope: "turn" };
        if (method === "item/mcpToolCall/requestApproval")
            return { decision: response.behavior === "allow" ? "accept" : "decline" };
        return { decision: response.behavior === "allow" ? "accept" : response.interrupt ? "cancel" : "decline" };
    }
    async interrupt(): Promise<void> {
        if (!this.activeTurn)
            return;
        this.canceling = true;
        this.clearPermissions();
        try {
            if (!this.nativeTurn)
                throw new Error("No native turn id");
            await this.client.request("turn/interrupt", { threadId: this.sessionId, turnId: this.nativeTurn }, 2500);
            await this.waitForTurn();
            // Codex turn/interrupt leaves terminal children alive; terminate only this turn's ids.
            await Promise.all([...this.terminalIds].map(processId => this.client.request("thread/backgroundTerminals/terminate", { threadId: this.sessionId, processId }, 2000)));
            this.terminalIds.clear();
        }
        catch {
            await this.close();
        }
    }
    async close(): Promise<void> {
        this.closed = true;
        this.finish("canceled");
        await this.client.dispose();
    }
}
