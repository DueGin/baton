/** The only server module that imports @baton/providers. */
import { ProviderRegistry, type AgentClient, type AgentSession, type AgentStreamEvent, type AgentTimelineItem, type AgentPersistenceHandle } from "@baton/providers";
import type { AgentEntry, JsonValue, TimelineItem, PermissionResponse } from "@baton/protocol";
import type { AgentDriver, DriverEvent, DriverRegistry, DriverSession, SteerOutcome } from "./types.js";
export interface PaseoDriverRegistryOptions {
    home: string;
    logger?: ConstructorParameters<typeof ProviderRegistry>[0]["logger"];
}
export function createPaseoDriverRegistry(options: PaseoDriverRegistryOptions): DriverRegistry {
    const providers = new ProviderRegistry(options);
    const drivers = new Map<string, AgentDriver>();
    const sessions = new Set<PaseoDriverSession>();
    let stopped = false;
    let detecting: Promise<AgentEntry[]> | undefined;
    let generation = 0;
    return {
        detect(request) {
            if (stopped)
                return Promise.resolve([]);
            const current = ++generation;
            const pending = providers.detect(request).then(entries => {
                if (current !== generation)
                    return entries;
                drivers.clear();
                if (!stopped)
                    for (const entry of entries) {
                        const client = providers.get(entry.id);
                        if (client && entry.status === "ready")
                            drivers.set(entry.id, makeDriver(entry, client, sessions, () => stopped));
                    }
                return entries;
            }).catch(() => []);
            detecting = pending;
            return pending;
        },
        get(id) { return stopped ? undefined : drivers.get(id); },
        async shutdown() {
            if (stopped)
                return;
            stopped = true;
            drivers.clear();
            await detecting;
            await Promise.allSettled([...sessions].map(session => session.close()));
        },
    };
}
function makeDriver(entry: AgentEntry, client: AgentClient, sessions: Set<PaseoDriverSession>, isStopped: () => boolean): AgentDriver {
    async function wrap(open: Promise<AgentSession>): Promise<DriverSession> {
        const provider = await open;
        if (isStopped()) {
            await provider.close();
            throw new Error("Driver registry shut down");
        }
        const session = new PaseoDriverSession(provider, () => sessions.delete(session));
        sessions.add(session);
        return session;
    }
    return {
        agentId: entry.id, capabilities: entry.capabilities,
        async open(spec) { if (isStopped())
            throw new Error("Driver registry shut down"); return wrap(client.createSession(spec)); },
        async resume(persistence, spec) { if (isStopped())
            throw new Error("Driver registry shut down"); return wrap(client.resumeSession(parsePersistence(persistence, client.provider), spec)); },
    };
}
function parsePersistence(value: JsonValue, expectedProvider: string): AgentPersistenceHandle {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.provider !== expectedProvider || typeof value.sessionId !== "string")
        throw new Error("Invalid provider persistence handle");
    return { provider: expectedProvider as AgentPersistenceHandle["provider"], sessionId: value.sessionId, ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}) };
}
export class PaseoDriverSession implements DriverSession {
    supportsLongToolCalls(): boolean { return this.session.supportsLongToolCalls?.() ?? false; }
    private listeners = new Set<(event: DriverEvent) => void>();
    private turnId: string | null = null;
    private closed = false;
    private unsubscribe: () => void;
    constructor(private session: AgentSession, private onClose: () => void = () => { }) {
        this.unsubscribe = session.subscribe(event => {
            if (event.type === "turn_started")
                this.turnId = event.turnId;
            if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_canceled")
                this.turnId = null;
            const mapped = mapProviderEvent(event);
            if (!mapped)
                return;
            for (const listener of this.listeners)
                this.deliver(listener, mapped);
        });
    }
    get sessionId(): string | null { return this.session.sessionId; }
    processIds(): number[] { return this.session.processIds?.() ?? []; }
    persistence(): JsonValue | null { const handle = this.session.getPersistence(); return handle ? { ...handle } : null; }
    async startTurn(prompt: string): Promise<{
        turnId: string;
    }> { if (this.closed)
        throw new Error("Session closed"); return this.session.startTurn(prompt); }
    async steer(prompt: string): Promise<SteerOutcome> {
        if (!this.session.steerActiveTurn)
            return "unsupported";
        if (!this.turnId)
            return "no_active_turn";
        return await this.session.steerActiveTurn(prompt) ? "steered" : this.turnId ? "unsupported" : "no_active_turn";
    }
    async interrupt(): Promise<void> { await this.session.interrupt(); }
    async respondToPermission(id: string, response: PermissionResponse): Promise<void> { await this.session.respondToPermission(id, response); }
    pendingPermissions(): ReturnType<DriverSession["pendingPermissions"]> { return this.session.pendingPermissions().map(request => ({ ...request, detail: request.detail?.type === "worktree_setup" ? undefined : request.detail })); }
    subscribe(listener: (event: DriverEvent) => void): () => void {
        this.listeners.add(listener);
        if (this.sessionId)
            this.deliver(listener, { type: "session", sessionId: this.sessionId });
        return () => { this.listeners.delete(listener); };
    }
    private deliver(listener: (event: DriverEvent) => void, event: DriverEvent): void { try {
        listener(event);
    }
    catch { /* contract: listener failures cannot escape */ } }
    runtimeInfo(): Promise<{
        model?: string | null;
        modeId?: string | null;
    }> { return this.session.runtimeInfo(); }
    async close(): Promise<void> { if (this.closed)
        return; this.closed = true; try {
        await this.session.close();
    }
    finally {
        this.unsubscribe();
        this.onClose();
    } }
}
export function mapProviderEvent(event: AgentStreamEvent): DriverEvent | null {
    switch (event.type) {
        case "thread_started": return { type: "session", sessionId: event.sessionId };
        case "timeline": {
            const item = mapTimelineItem(event.item);
            return item ? { type: "item", turnId: event.turnId, item, timestamp: event.timestamp } : null;
        }
        case "usage_updated": return { type: "usage", turnId: event.turnId, usage: event.usage };
        case "mode_changed": return { type: "mode_changed", modeId: event.currentModeId };
        case "model_changed": return { type: "model_changed", model: event.model };
        case "permission_requested": return { type: "permission_requested", turnId: event.turnId, request: { ...event.request, detail: event.request.detail?.type === "worktree_setup" ? undefined : event.request.detail } };
        case "permission_resolved": return { type: "permission_resolved", turnId: event.turnId, requestId: event.requestId, response: event.resolution };
        default: return event;
    }
}
function mapTimelineItem(item: AgentTimelineItem): TimelineItem | null {
    if (item.type === "notification")
        return { ...item, type: "notice" };
    if (item.type === "tool_call") {
        if (item.detail.type === "worktree_setup")
            return null;
        return { type: "tool_call", callId: item.callId, name: item.name, status: item.status, detail: item.detail, ...(item.status === "failed" ? { error: typeof item.error === "string" ? item.error : JSON.stringify(item.error) ?? "Tool failed" } : {}) };
    }
    return item;
}
