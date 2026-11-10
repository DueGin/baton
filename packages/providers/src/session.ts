// Ported from Paseo (https://github.com/getpaseo/paseo) packages/server/src/server/agent/providers/provider-runner.ts @63ea3e5 — Copyright (c) 2025-present Mohamed Boudra, Apache-2.0. Modified for baton.
import { randomUUID } from "node:crypto";
import type { AgentPersistenceHandle, AgentPermissionRequest, AgentPermissionResponse, AgentProvider, AgentSession, AgentSessionConfig, AgentStreamEvent, AgentTimelineItem, AgentUsage } from "./agent-sdk-types.js";
export function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function text(value: unknown): string { return typeof value === "string" ? value : ""; }
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export abstract class ProviderSession implements AgentSession {
    sessionId: string | null = null;
    protected activeTurn: string | null = null;
    protected closed = false;
    private listeners = new Set<(event: AgentStreamEvent) => void>();
    private permissions = new Map<string, {
        request: AgentPermissionRequest;
        resolve: (response: AgentPermissionResponse) => void;
    }>();
    private turnDone: Promise<void> = Promise.resolve();
    private resolveDone: () => void = () => { };
    constructor(readonly provider: AgentProvider, protected config: AgentSessionConfig) { this.config = { ...config }; }
    getPersistence(): AgentPersistenceHandle | null { return this.sessionId ? { provider: this.provider, sessionId: this.sessionId } : null; }
    subscribe(listener: (event: AgentStreamEvent) => void): () => void {
        this.listeners.add(listener);
        if (this.sessionId)
            this.deliver(listener, { type: "thread_started", sessionId: this.sessionId });
        return () => { this.listeners.delete(listener); };
    }
    private deliver(listener: (event: AgentStreamEvent) => void, event: AgentStreamEvent): void { try {
        listener(event);
    }
    catch { /* consumers cannot break provider ordering */ } }
    protected emit(event: AgentStreamEvent): void { for (const listener of this.listeners)
        this.deliver(listener, event); }
    protected identify(id: string): void { if (this.sessionId === id)
        return; this.sessionId = id; this.emit({ type: "thread_started", sessionId: id }); }
    protected timeline(item: AgentTimelineItem): void { this.emit({ type: "timeline", item, timestamp: new Date().toISOString(), ...(this.activeTurn ? { turnId: this.activeTurn } : {}) }); }
    async startTurn(prompt: string): Promise<{
        turnId: string;
    }> {
        if (this.closed)
            throw new Error("Session is closed");
        if (this.activeTurn)
            throw new Error("A turn is already active");
        const turnId = randomUUID();
        this.activeTurn = turnId;
        this.turnDone = new Promise(resolve => { this.resolveDone = resolve; });
        this.emit({ type: "turn_started", turnId });
        this.timeline({ type: "user_message", text: prompt });
        try {
            await this.launchTurn(prompt);
        }
        catch (error) {
            if (this.activeTurn === turnId)
                this.finish("failed", errorText(error));
            throw error;
        }
        return { turnId };
    }
    protected abstract launchTurn(prompt: string): Promise<void>;
    protected finish(status: "completed" | "failed" | "canceled", message?: string, usage?: AgentUsage): void {
        const turnId = this.activeTurn;
        if (!turnId)
            return;
        const resolveDone = this.resolveDone;
        this.clearPermissions();
        this.activeTurn = null;
        if (status === "completed")
            this.emit({ type: "turn_completed", turnId, ...(usage ? { usage } : {}) });
        else if (status === "failed")
            this.emit({ type: "turn_failed", turnId, error: message ?? "Provider turn failed" });
        else
            this.emit({ type: "turn_canceled", turnId, reason: message ?? "Interrupted" });
        resolveDone();
    }
    protected ask(request: AgentPermissionRequest): Promise<AgentPermissionResponse> {
        if (this.closed)
            return Promise.resolve({ behavior: "deny", message: "Session closed" });
        if (this.permissions.has(request.id))
            throw new Error(`Duplicate permission ${request.id}`);
        return new Promise(resolve => {
            this.permissions.set(request.id, { request, resolve });
            this.emit({ type: "permission_requested", request, ...(this.activeTurn ? { turnId: this.activeTurn } : {}) });
        });
    }
    async respondToPermission(id: string, response: AgentPermissionResponse): Promise<void> {
        const pending = this.permissions.get(id);
        if (!pending)
            throw new Error(`Unknown permission ${id}`);
        this.permissions.delete(id);
        this.emit({ type: "permission_resolved", requestId: id, resolution: response, ...(this.activeTurn ? { turnId: this.activeTurn } : {}) });
        pending.resolve(response);
    }
    pendingPermissions(): AgentPermissionRequest[] { return [...this.permissions.values()].map(p => p.request); }
    protected clearPermissions(): void {
        for (const id of [...this.permissions.keys()])
            void this.respondToPermission(id, { behavior: "deny", message: "Turn ended" });
    }
    async runtimeInfo(): Promise<{
        model?: string | null;
        modeId?: string | null;
    }> { return { model: this.config.model ?? null, modeId: this.config.modeId ?? null }; }
    protected processExited(error: string): void { if (this.closed)
        return; this.closed = true; this.finish("failed", error); this.emit({ type: "closed", error }); void this.close().catch(() => { }); }
    protected async waitForTurn(timeoutMs = 2500): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([this.turnDone, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Agent did not stop after interrupt")), timeoutMs); })]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    abstract interrupt(): Promise<void>;
    abstract close(): Promise<void>;
}
