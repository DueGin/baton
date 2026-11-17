// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/claude/agent.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import { query, type Query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { terminateWithTreeKill } from "../tree-kill.js";
import type { AgentClient, AgentImageRef, AgentPersistenceHandle, AgentPromptInput, AgentSessionConfig, AgentUsage, ClientOptions, ProviderCatalog } from "../agent-sdk-types.js";
import { findImageBlocks, imageNote, promptText, readPromptImage, saveProviderImages } from "../images.js";
import { ProviderSession, record, text, errorText } from "../session.js";
import { externalEnv, spawnProcess } from "../process.js";
import { mapClaudeCompletedToolCall, mapClaudeFailedToolCall, mapClaudeRunningToolCall } from "./claude/tool-call-mapper.js";
export type ClaudeQueryFactory = typeof query;
type ClaudeBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } };
type ClaudeContent = string | ClaudeBlock[];
/** The Messages API caps an image at 5 MB; base64 inflates by 4/3, so stay at 3.75 MB of file.
 * Bigger files go as a path note: Claude Code's Read tool downsizes images itself. */
const CLAUDE_INLINE_IMAGE_MAX_BYTES = 3_750_000;
/** Text stays a plain string; image parts become base64 blocks at their position (Paseo toSdkUserMessage). */
export async function claudePromptContent(prompt: AgentPromptInput): Promise<ClaudeContent> {
    if (typeof prompt === "string")
        return prompt;
    const content: ClaudeBlock[] = [];
    for (const part of prompt) {
        if (part.type === "text") {
            if (part.text)
                content.push({ type: "text", text: part.text });
            continue;
        }
        const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mimeType) ? await readPromptImage(part, CLAUDE_INLINE_IMAGE_MAX_BYTES) : null;
        if (image)
            content.push({ type: "image", source: { type: "base64", media_type: image.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: image.data } });
        else
            content.push({ type: "text", text: imageNote(part) });
    }
    return content.length ? content : "";
}
const MODES = [
    { id: "default", label: "Default" }, { id: "acceptEdits", label: "Accept edits" },
    { id: "plan", label: "Plan", isReadOnly: true }, { id: "bypassPermissions", label: "Bypass permissions", isUnattended: true },
];
class PromptQueue implements AsyncIterable<SDKUserMessage> {
    private values: SDKUserMessage[] = [];
    private wake?: () => void;
    private ended = false;
    push(content: ClaudeContent, priority?: "next"): string { if (this.ended)
        throw new Error("Claude input closed"); const uuid = randomUUID(); this.values.push({ type: "user", uuid, message: { role: "user", content } as SDKUserMessage["message"], parent_tool_use_id: null, ...(priority ? { priority } : {}) }); this.wake?.(); return uuid; }
    withdraw(ids: Set<string>): Set<string> {
        const removed = new Set(this.values.flatMap(value => value.uuid && ids.has(value.uuid) ? [value.uuid] : []));
        this.values = this.values.filter(value => !value.uuid || !ids.has(value.uuid));
        return removed;
    }
    close(): void { this.ended = true; this.wake?.(); }
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
        while (!this.ended) {
            const value = this.values.shift();
            if (value) {
                yield value;
                continue;
            }
            await new Promise<void>(resolve => { this.wake = resolve; });
            this.wake = undefined;
        }
    }
}
export class ClaudeAgentClient implements AgentClient {
    readonly provider = "claude" as const;
    readonly capabilities = { steer: true, resume: true, reasoning: true, mcp: true, images: true };
    constructor(private options: ClientOptions & {
        queryFactory?: ClaudeQueryFactory;
    }) { }
    async createSession(config: AgentSessionConfig): Promise<ClaudeSession> { return new ClaudeSession(this.options, config); }
    async resumeSession(handle: AgentPersistenceHandle, config: AgentSessionConfig): Promise<ClaudeSession> { return new ClaudeSession(this.options, config, handle); }
    async fetchCatalog(): Promise<ProviderCatalog> {
        await mkdir(this.options.home, { recursive: true });
        const cwd = await mkdtemp(join(this.options.home, "catalog-claude-"));
        let session: ClaudeSession | undefined;
        try {
            session = new ClaudeSession(this.options, { cwd });
            const models = await session.models(this.options.timeoutMs ?? 10000);
            return { modes: MODES, defaultModeId: "default", models: models.map(model => ({ id: model.value, label: model.displayName, description: model.description, thinkingOptions: model.supportedEffortLevels?.map(id => ({ id, label: id })) })) };
        }
        finally {
            await session?.close();
            await rm(cwd, { recursive: true, force: true });
        }
    }
}
class ClaudeSession extends ProviderSession {
    supportsLongToolCalls(): boolean { return Number(this.config.env?.MCP_TOOL_TIMEOUT ?? 0) >= 3600000; }
    processIds(): number[] { return this.child?.pid && this.child.exitCode === null && this.child.signalCode === null ? [this.child.pid] : []; }
    private query: Query;
    private child?: ChildProcessWithoutNullStreams;
    private closing?: Promise<void>;
    private queue = new PromptQueue();
    private abort = new AbortController();
    private canceling = false;
    private unstartedMessages = new Set<string>();
    private sawText = false;
    private streamedBlocks = new Set<string>();
    private cumulativeCost = 0;
    private cumulativeModelUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    private tools = new Map<string, {
        name: string;
        input: unknown;
    }>();
    constructor(private options: ClientOptions & {
        queryFactory?: ClaudeQueryFactory;
    }, config: AgentSessionConfig, handle?: AgentPersistenceHandle) {
        super("claude", config);
        if (handle)
            this.sessionId = handle.sessionId;
        const permissionMode = config.modeId ?? "default";
        if (!["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"].includes(permissionMode))
            throw new Error(`Unsupported Claude mode ${permissionMode}`);
        const sdkOptions: Options = {
            cwd: config.cwd, ...(config.model ? { model: config.model } : {}),
            pathToClaudeCodeExecutable: options.command[0],
            env: externalEnv(options.env, config.env), settingSources: ["user", "project", "local"],
            abortController: this.abort, includePartialMessages: true, perTaskStopAffordance: true,
            permissionMode: permissionMode as Options["permissionMode"], allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
            ...(config.thinking === "off" ? { thinking: { type: "disabled" } } : {}),
            ...(config.thinking && ["low", "medium", "high", "xhigh", "max"].includes(config.thinking) ? { thinking: { type: "adaptive" }, effort: config.thinking as Options["effort"] } : {}),
            ...(config.systemPrompt ? { systemPrompt: { type: "preset", preset: "claude_code", append: config.systemPrompt } } : {}),
            ...(handle ? { resume: handle.sessionId } : {}), mcpServers: config.mcpServers,
            spawnClaudeCodeProcess: spawnOptions => {
                const child = spawnProcess(options.command.length > 1 ? options.command[0]! : spawnOptions.command, options.command.length > 1 ? [...options.command.slice(1), ...spawnOptions.args] : spawnOptions.args, { cwd: spawnOptions.cwd, env: externalEnv(spawnOptions.env, options.env, config.env), signal: spawnOptions.signal });
                this.child = child;
                return child;
            },
            canUseTool: async (name, input, context) => {
                const id = context.toolUseID;
                const mapped = mapClaudeRunningToolCall({ callId: id, name, input });
                const response = await this.ask({ id, name, kind: name === "AskUserQuestion" ? "question" : name === "ExitPlanMode" ? "plan" : "tool", input, ...(mapped ? { detail: mapped.detail } : {}) });
                return response.behavior === "allow" ? { behavior: "allow", updatedInput: response.updatedInput ?? input } : { behavior: "deny", message: response.message ?? "Denied", interrupt: response.interrupt };
            },
        };
        this.query = (options.queryFactory ?? query)({ prompt: this.queue, options: sdkOptions });
        void this.pump();
    }
    async models(timeoutMs: number): Promise<Awaited<ReturnType<Query["supportedModels"]>>> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([this.query.supportedModels(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude catalog timed out")), timeoutMs); })]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    protected async launchTurn(prompt: AgentPromptInput): Promise<void> { const content = typeof prompt === "string" ? prompt : await claudePromptContent(prompt); this.canceling = false; this.sawText = false; this.streamedBlocks.clear(); this.unstartedMessages.add(this.queue.push(content)); }
    async steerActiveTurn(prompt: AgentPromptInput): Promise<boolean> { if (!this.activeTurn)
        return false; if (this.canceling) return false; const content = typeof prompt === "string" ? prompt : await claudePromptContent(prompt); if (!this.activeTurn || this.canceling || this.closed) return false; this.unstartedMessages.add(this.queue.push(content, "next")); this.timeline({ type: "user_message", text: promptText(prompt) }); return true; }
    private async pump(): Promise<void> {
        try {
            for await (const raw of this.query) {
                // Saving tool-output images is the only asynchronous step; it keeps event order.
                const pending = this.message(record(raw));
                if (pending)
                    await pending;
            }
            if (!this.closed)
                this.processExited("Claude stream ended");
        }
        catch (error) {
            if (!this.closed)
                this.processExited(errorText(error));
        }
    }
    private message(message: Record<string, unknown>): void | Promise<void> {
        if (this.closed)
            return;
        if (message.type === "command_lifecycle" || (message.type === "system" && message.subtype === "command_lifecycle")) {
            const lifecycle = record(message.lifecycle ?? message);
            if (lifecycle.state !== "queued") this.unstartedMessages.delete(text(lifecycle.command_uuid ?? lifecycle.commandUuid ?? lifecycle.uuid));
        }
        // Native subagents are not baton nodes; do not mix their tokens or turn boundaries into the main session.
        if (message.parent_tool_use_id)
            return;
        if (typeof message.session_id === "string")
            this.identify(message.session_id);
        if (message.type === "system" && message.subtype === "init") {
            if (typeof message.model === "string") {
                this.config.model = message.model;
                this.emit({ type: "model_changed", model: message.model });
            }
            return;
        }
        if (!this.activeTurn)
            return;
        if (message.type === "stream_event") {
            const event = record(message.event), delta = record(event.delta);
            if (event.type === "message_start")
                this.streamedBlocks.clear();
            if (event.type === "content_block_delta" && (delta.type === "text_delta" || delta.type === "thinking_delta")) {
                const type = delta.type === "text_delta" ? "assistant_message" : "reasoning";
                this.streamedBlocks.add(type);
                if (type === "assistant_message")
                    this.sawText = true;
                this.timeline({ type, text: text(delta.text ?? delta.thinking) });
            }
            return;
        }
        if (message.type === "assistant") {
            const content = record(message.message).content;
            if (Array.isArray(content))
                for (const block of content.map(record)) {
                    if (block.type === "text" && !this.streamedBlocks.has("assistant_message")) {
                        this.sawText = true;
                        this.timeline({ type: "assistant_message", text: text(block.text) });
                    }
                    if (block.type === "thinking" && !this.streamedBlocks.has("reasoning"))
                        this.timeline({ type: "reasoning", text: text(block.thinking) });
                    if (block.type === "tool_use") {
                        const id = text(block.id), name = text(block.name);
                        this.tools.set(id, { name, input: block.input });
                        const mapped = mapClaudeRunningToolCall({ callId: id, name, input: block.input });
                        if (mapped)
                            this.timeline(mapped);
                    }
                }
            this.streamedBlocks.clear();
        }
        if (message.type === "user") {
            const content = record(message.message).content;
            if (Array.isArray(content)) {
                const results = content.map(record).filter(block => block.type === "tool_result" && this.tools.has(text(block.tool_use_id)));
                const images = this.options.saveImage ? results.map(block => toolResultImages(block, message.tool_use_result)) : [];
                if (images.some(list => list.length))
                    return (async () => {
                        for (const [index, block] of results.entries()) {
                            const tool = this.tools.get(text(block.tool_use_id));
                            const refs = await saveProviderImages(this.options.saveImage, (images[index] ?? []).map(image => ({ ...image, ...(tool?.name === "Read" && typeof record(tool.input).file_path === "string" ? { name: basename(text(record(tool.input).file_path)) } : {}) })));
                            if (!this.closed)
                                this.toolResult(block, message, refs);
                        }
                    })();
                for (const block of results)
                    this.toolResult(block, message);
            }
        }
        if (message.type === "result") {
            const failed = message.is_error === true || message.subtype !== "success";
            if (!this.sawText && typeof message.result === "string" && !failed)
                this.timeline({ type: "assistant_message", text: message.result });
            const usage = record(message.usage);
            const mapped: AgentUsage = {
                ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
                ...(typeof usage.cache_read_input_tokens === "number" ? { cachedInputTokens: usage.cache_read_input_tokens } : {}),
                ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
                ...(typeof message.total_cost_usd === "number" ? { totalCostUsd: Math.max(0, message.total_cost_usd - this.cumulativeCost) } : {}),
            };
            const models = Object.values(record(message.modelUsage)).map(record);
            if (models.length) {
                const totals = models.reduce<{
                    inputTokens: number;
                    cachedInputTokens: number;
                    outputTokens: number;
                }>((total, model) => ({ inputTokens: total.inputTokens + Number(model.inputTokens ?? 0) + Number(model.cacheCreationInputTokens ?? 0), cachedInputTokens: total.cachedInputTokens + Number(model.cacheReadInputTokens ?? 0), outputTokens: total.outputTokens + Number(model.outputTokens ?? 0) }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
                for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"] as const)
                    mapped[key] = Math.max(0, totals[key] - this.cumulativeModelUsage[key]);
                this.cumulativeModelUsage = totals;
                const activeModel = record(record(message.modelUsage)[this.config.model ?? ""] ?? models[0]);
                if (typeof activeModel.contextWindow === "number")
                    mapped.contextWindowMaxTokens = activeModel.contextWindow;
            }
            if (typeof message.total_cost_usd === "number")
                this.cumulativeCost = message.total_cost_usd;
            const errors = Array.isArray(message.errors) ? message.errors.join("\n") : text(message.result);
            this.finish(this.canceling ? "canceled" : failed ? "failed" : "completed", errors || "Claude failed", mapped);
        }
    }
    private toolResult(block: Record<string, unknown>, message: Record<string, unknown>, images: AgentImageRef[] = []): void {
        const id = text(block.tool_use_id), tool = this.tools.get(id);
        if (!tool)
            return;
        const output = sanitizeImages(message.tool_use_result ?? (Array.isArray(block.content) ? block.content.map(record).filter(c => c.type === "text").map(c => text(c.text)).join("\n") : block.content));
        const params = { callId: id, name: tool.name, input: tool.input, output };
        const mapped = block.is_error ? mapClaudeFailedToolCall({ ...params, error: output }) : mapClaudeCompletedToolCall(params);
        if (mapped)
            this.timeline(images.length ? { ...mapped, images } : mapped);
        this.tools.delete(id);
    }
    async interrupt(): Promise<void> {
        if (!this.activeTurn)
            return;
        this.canceling = true;
        this.clearPermissions();
        try {
            // Paseo's per-UUID withdrawal also covers input already consumed by the SDK
            // but not started by Claude. Removing only our local queue is insufficient.
            const ids = new Set(this.unstartedMessages);
            this.unstartedMessages.clear();
            const local = this.queue.withdraw(ids);
            const cancel = (this.query as Query & { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }).cancelAsyncMessage;
            let safe = true;
            for (const id of ids) if (!local.has(id)) {
                try { if (!cancel || !await cancel.call(this.query, id)) safe = false; }
                catch { safe = false; }
            }
            // Close before interrupt if recall is unavailable: the CLI could otherwise
            // dequeue a surviving steer between its result and our close call.
            if (!safe) { await this.close(); return; }
            await this.query.interrupt();
            await this.waitForTurn();
        }
        catch {
            await this.close();
        }
    }
    async close(): Promise<void> {
        if (this.closing)
            return this.closing;
        this.closed = true;
        this.finish("canceled");
        this.queue.close();
        this.abort.abort();
        this.query.close();
        this.closing = this.child ? terminateWithTreeKill(this.child, { gracefulTimeoutMs: 2000, forceTimeoutMs: 1000 }).then(result => { if (result === "kill-timeout")
            throw new Error("Claude process did not exit after SIGKILL"); }) : Promise.resolve();
        return this.closing;
    }
}

/** Images of one tool_result: its content blocks, else the SDK's structured tool_use_result (Read). */
function toolResultImages(block: Record<string, unknown>, toolUseResult: unknown): Array<{ data: string; mimeType: string | null }> {
    const inline = Array.isArray(block.content) ? findImageBlocks(block.content) : [];
    return inline.length ? inline : findImageBlocks(toolUseResult);
}
function sanitizeImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeImages);
  if (value === null || typeof value !== "object") return value;
  const object = record(value);
  if (object.type === "image") return { type: "text", text: "[image]" };
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, sanitizeImages(child)]));
}
