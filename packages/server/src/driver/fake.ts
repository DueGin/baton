import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { terminateProcessIds } from "@baton/providers";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentEntry, AttachmentRef, BatonToolName, JsonValue, PermissionRequest, PermissionResponse, TimelineItem, Usage } from "@baton/protocol";
import type { AgentDriver, DriverEvent, DriverRegistry, DriverSession, OpenSessionSpec, PromptInput, PromptPart, SteerOutcome } from "./types.js";
type ImagePart = Extract<PromptPart, { type: "image" }>;
/** Text a fake agent "sees": image parts are echoed as `[image name]`. */
export function fakePromptText(prompt: PromptInput): string {
  return typeof prompt === "string" ? prompt : prompt.map((part) => part.type === "text" ? part.text : `[image ${part.name ?? part.path.split(/[\\/]/).at(-1)}]`).join("");
}
export interface FakeContext {
  /** Prompt text; image parts appear as `[image name]`. */
  prompt: string;
  /** The prompt exactly as the kernel sent it (string or text/image parts). */
  input: PromptInput; images: ImagePart[];
  turn: number; spec: OpenSessionSpec; signal: AbortSignal;
  text(text: string): void; reasoning(text: string): void; item(item: TimelineItem): void;
  usage(usage: Usage): void; sleep(ms: number): Promise<void>;
  call<T = unknown>(tool: BatonToolName, input: Record<string, unknown>): Promise<T>;
  permission(request: PermissionRequest): Promise<PermissionResponse>;
  steered: string[];
  /** Real subprocess, parented by this fake session's agent supervisor; caller owns cleanup. */
  spawn(command: string, args?: string[], options?: { detached?: boolean }): Promise<number>;
  /** Stores an image the way real drivers store tool output (startServer wires the attachment store). */
  saveImage(data: Uint8Array | string, mimeType: string, name?: string): Promise<AttachmentRef>;
}
export type FakeSaveImage = (data: Uint8Array | string, mimeType: string, name?: string) => Promise<AttachmentRef>;
export type FakeScript = (context: FakeContext) => Promise<void> | void;
export interface FakeDriverOptions { script?: FakeScript; scripts?: FakeScript[]; steer?: boolean; label?: string; /** Accept image parts (default true). */ images?: boolean; /** Native conversation rewind (default true); false exercises the replay fallback. */ rewind?: boolean }
const capabilities = { steer: true, resume: true, reasoning: true, mcp: true, images: true };
export class FakeDriver implements AgentDriver {
  readonly capabilities: AgentEntry["capabilities"];
  readonly sessions: FakeSession[] = [];
  /** Native rewinds performed by this driver's sessions (points as given), for tests. */
  readonly rewinds: JsonValue[] = [];
  saveImage?: FakeSaveImage;
  constructor(readonly agentId: string, readonly options: FakeDriverOptions = {}) { this.capabilities = { ...capabilities, steer: options.steer ?? true, images: options.images ?? true }; }
  async open(spec: OpenSessionSpec): Promise<FakeSession> {
    const session = new FakeSession(this, spec); this.sessions.push(session); return session;
  }
  async resume(persistence: JsonValue, spec: OpenSessionSpec): Promise<FakeSession> {
    const session = await this.open(spec);
    if (persistence && typeof persistence === "object" && !Array.isArray(persistence)) {
      if (typeof persistence.sessionId === "string") session.sessionId = persistence.sessionId;
      if (typeof persistence.turns === "number") session.turns = persistence.turns;
    }
    return session;
  }
}
export class FakeSession implements DriverSession {
  supportsLongToolCalls(): boolean { return true; }
  sessionId: string = randomUUID(); turns = 0; closed = false;
  readonly prompts: string[] = []; readonly steered: string[] = [];
  /** Raw inputs of prompts / steered, in the same order. */
  readonly inputs: PromptInput[] = []; readonly steeredInputs: PromptInput[] = [];
  private listeners = new Set<(event: DriverEvent) => void>();
  private active?: { id: string; controller: AbortController; promise: Promise<void> };
  private permissions = new Map<string, { request: PermissionRequest; resolve: (response: PermissionResponse) => void }>();
  private client?: Client; private connecting?: Promise<Client>;
  private supervisor?: ChildProcess;
  private spawned = new Set<number>();
  rewindPoint?: () => JsonValue | null;
  rewindConversation?: (point: JsonValue) => Promise<void>;
  constructor(readonly driver: FakeDriver, readonly spec: OpenSessionSpec) {
    if (driver.options.rewind === false) return;
    // "Just before the last prompt" = the number of turns before it; a rewind forks to a new session id.
    this.rewindPoint = () => ({ turns: this.turns - 1, sessionId: this.sessionId });
    this.rewindConversation = async (point) => {
      const turns = point && typeof point === "object" && !Array.isArray(point) ? point.turns : undefined;
      if (typeof turns !== "number" || turns < 0 || turns > this.turns) throw new Error("Fake rewind point is outside this conversation");
      if (this.active) throw new Error("Fake session cannot rewind during a turn");
      this.driver.rewinds.push(point); this.turns = turns; this.sessionId = randomUUID();
    };
  }
  processIds(): number[] { return this.supervisor?.pid && this.supervisor.exitCode === null && this.supervisor.signalCode === null ? [this.supervisor.pid] : []; }
  private async spawnChild(command: string, args: string[], detached: boolean): Promise<number> {
    if (!this.supervisor) {
      this.supervisor = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process');process.on('message',m=>{const c=spawn(m.command,m.args,{cwd:m.cwd,detached:m.detached,stdio:'ignore'});c.once('error',e=>process.send({id:m.id,error:e.message}));c.once('spawn',()=>{c.unref();process.send({id:m.id,pid:c.pid})})});`], { cwd: this.spec.cwd, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"] });
    }
    const supervisor = this.supervisor, id = randomUUID();
    return new Promise<number>((resolve, reject) => {
      const cleanup = (): void => { supervisor.off("message", message); supervisor.off("error", error); supervisor.off("exit", exit); };
      const error = (e: Error): void => { cleanup(); reject(e); };
      const exit = (): void => error(new Error("Fake process supervisor exited"));
      const message = (value: unknown): void => {
        if (!value || typeof value !== "object" || !("id" in value) || value.id !== id) return;
        cleanup();
        if ("pid" in value && typeof value.pid === "number") { this.spawned.add(value.pid); resolve(value.pid); }
        else reject(new Error("error" in value ? String(value.error) : "Spawn failed"));
      };
      supervisor.on("message", message); supervisor.once("error", error); supervisor.once("exit", exit);
      supervisor.send({ id, command, args, cwd: this.spec.cwd, detached }, (e) => { if (e) error(e); });
    });
  }
  persistence(): JsonValue { return { sessionId: this.sessionId, turns: this.turns }; }
  subscribe(listener: (event: DriverEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: DriverEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* driver contract: never throw from listeners */ } } }
  async runtimeInfo(): Promise<{ model: string; modeId: string }> { return { model: this.spec.model ?? "fake-model", modeId: this.spec.modeId ?? "default" }; }
  async startTurn(input: PromptInput): Promise<{ turnId: string }> {
    if (this.closed) throw new Error("Fake session is closed");
    if (this.active) throw new Error("Fake session already has an active turn");
    const prompt = fakePromptText(input), images = typeof input === "string" ? [] : input.filter((part): part is ImagePart => part.type === "image");
    const id = randomUUID(), controller = new AbortController(); this.turns++; this.prompts.push(prompt); this.inputs.push(input);
    const item = (value: TimelineItem): void => { controller.signal.throwIfAborted(); this.emit({ type: "item", turnId: id, item: value, timestamp: new Date().toISOString() }); };
    const context: FakeContext = {
      prompt, input, images, turn: this.turns, spec: this.spec, signal: controller.signal,
      text: (text) => item({ type: "assistant_message", text }), reasoning: (text) => item({ type: "reasoning", text }), item,
      usage: (usage) => this.emit({ type: "usage", turnId: id, usage }),
      sleep: async (ms) => { await delay(ms, undefined, { signal: controller.signal }); },
      steered: this.steered,
      spawn: async (command, args = [], options = {}) => {
        const callId = randomUUID(), detail = { type: "shell" as const, command: [command, ...args].join(" "), cwd: this.spec.cwd };
        item({ type: "tool_call", callId, name: "shell", status: "running", detail });
        const pid = await this.spawnChild(command, args, options.detached ?? false);
        item({ type: "tool_call", callId, name: "shell", status: "completed", detail }); return pid;
      },
      call: async <T>(tool: BatonToolName, input: Record<string, unknown>): Promise<T> => {
        const callId = randomUUID(); item({ type: "tool_call", callId, name: `mcp__baton__${tool}`, status: "running", detail: { type: "unknown", input, output: undefined } });
        try {
          const client = await this.mcpClient(); controller.signal.throwIfAborted();
          const response = await client.callTool({ name: tool, arguments: input }, undefined, { signal: controller.signal, timeout: 3660000, resetTimeoutOnProgress: true });
          const content = response.content;
          const text = Array.isArray(content) ? content.filter((v: unknown): v is { type: "text"; text: string } => !!v && typeof v === "object" && "type" in v && v.type === "text" && "text" in v && typeof v.text === "string").map((v) => v.text).join("\n") : "";
          if (response.isError) throw new Error(text);
          const output: unknown = response.structuredContent ?? (text ? JSON.parse(text) : null);
          item({ type: "tool_call", callId, name: `mcp__baton__${tool}`, status: "completed", detail: { type: "unknown", input, output } }); return output as T;
        } catch (error) {
          if (!controller.signal.aborted) item({ type: "tool_call", callId, name: `mcp__baton__${tool}`, status: "failed", error: error instanceof Error ? error.message : String(error), detail: { type: "unknown", input, output: null } });
          throw error;
        }
      },
      saveImage: (data, mimeType, name) => {
        const save = this.driver.saveImage;
        return save ? save(data, mimeType, name) : Promise.reject(new Error("No attachment store attached to the fake driver"));
      },
      permission: (request) => new Promise((resolve) => {
        this.permissions.set(request.id, { request, resolve }); this.emit({ type: "permission_requested", turnId: id, request });
      }),
    };
    const script = this.driver.options.scripts?.[this.turns - 1] ?? this.driver.options.script ?? demoScript;
    const promise = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      this.emit({ type: "session", sessionId: this.sessionId }); this.emit({ type: "turn_started", turnId: id });
      try {
        controller.signal.throwIfAborted(); await script(context); controller.signal.throwIfAborted();
        this.active = undefined; this.emit({ type: "turn_completed", turnId: id, usage: { inputTokens: 200, outputTokens: 100, totalCostUsd: 0.002 } });
      } catch (error) {
        this.active = undefined;
        this.emit(controller.signal.aborted ? { type: "turn_canceled", turnId: id, reason: "Interrupted" } : { type: "turn_failed", turnId: id, error: error instanceof Error ? error.message : String(error) });
      }
    });
    this.active = { id, controller, promise }; return { turnId: id };
  }
  private async mcpClient(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const config = this.spec.mcpServers.baton;
      if (!config || config.type !== "http") throw new Error("FakeDriver requires baton HTTP MCP injection");
      const client = new Client({ name: "baton-fake-agent", version: "0.1.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url))); this.client = client; return client;
    })();
    return this.connecting;
  }
  async steer(input: PromptInput): Promise<SteerOutcome> {
    if (!this.driver.capabilities.steer) return "unsupported";
    if (!this.active) return "no_active_turn";
    this.steered.push(fakePromptText(input)); this.steeredInputs.push(input); return "steered";
  }
  async interrupt(): Promise<void> {
    const active = this.active; if (!active) return;
    active.controller.abort();
    for (const p of this.permissions.values()) p.resolve({ behavior: "deny", message: "Interrupted", interrupt: true }); this.permissions.clear();
    await active.promise;
  }
  async respondToPermission(requestId: string, response: PermissionResponse): Promise<void> {
    const pending = this.permissions.get(requestId); if (!pending) throw new Error("Fake permission not pending");
    this.permissions.delete(requestId); pending.resolve(response); this.emit({ type: "permission_resolved", requestId, response, turnId: this.active?.id });
  }
  pendingPermissions(): PermissionRequest[] { return [...this.permissions.values()].map((p) => p.request); }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.interrupt(); await this.client?.close(); await terminateProcessIds([...this.spawned, ...this.processIds()]); this.spawned.clear(); this.supervisor?.kill(); this.listeners.clear(); }
}
export class FakeDriverRegistry implements DriverRegistry {
  readonly drivers: Map<string, FakeDriver>;
  /** Set by startServer: lets fake scripts store images through the attachment store. */
  set saveImage(save: FakeSaveImage) { for (const driver of this.drivers.values()) driver.saveImage = save; }
  constructor(scripts?: Record<string, FakeScript | FakeDriverOptions> | FakeDriver[]) {
    const drivers = Array.isArray(scripts) ? scripts : Object.entries(scripts ?? { "fake-claude": { label: "Claude · demo" }, "fake-codex": { label: "Codex · demo" }, "fake-pi": { label: "Pi · demo", rewind: false } }).map(([id, value]) => new FakeDriver(id, typeof value === "function" ? { script: value } : value));
    this.drivers = new Map(drivers.map((d) => [d.agentId, d]));
  }
  async detect(): Promise<AgentEntry[]> {
    return [...this.drivers.values()].map((d) => ({ id: d.agentId, label: d.options.label ?? d.agentId, kind: "native", status: "ready", enabled: true, version: "demo-1.0", models: [{ id: "fake-model", label: "Demo model", isDefault: true }], modes: [{ id: "default", label: "Default" }, { id: "plan", label: "Read only", isReadOnly: true }], defaultModeId: "default", notes: "Scripted demo agent. Exercises real baton MCP delegation over HTTP.", capabilities: d.capabilities, checkedAt: new Date().toISOString() }));
  }
  get(agentId: string): FakeDriver | undefined { return this.drivers.get(agentId); }
  async shutdown(): Promise<void> { await Promise.all([...this.drivers.values()].flatMap((d) => d.sessions.map((s) => s.close()))); }
}
async function legacyDemoScript(c: FakeContext): Promise<void> {
  c.reasoning("I will split the work into independent pieces and bring the findings together.");
  c.usage({ inputTokens: 120, outputTokens: 25, totalCostUsd: 0.001 });
  if (!c.prompt.includes("<baton-assignment") && c.turn === 1) {
    c.text("I’m coordinating research, implementation review, and an integration check.\n");
    await c.call("list_agents", {});
    await Promise.all([
      c.call("delegate", { agent: "fake-codex", title: "Review the implementation", task: "Review the proposed architecture and ask a specialist to check the tests.", acceptance: ["Identify the main risks", "Include test coverage"] }),
      c.call("delegate", { agent: "fake-pi", title: "Research options", task: "Inspect the available options. Request permission before inspecting local configuration.", readonly: true }),
      c.call("delegate", { agent: "fake-codex", title: "Integration check", task: "Simulate an integration failure so the coordinator can explain the recovery." }),
    ]);
    for (let i = 0; i < 8; i++) { await c.sleep(700); c.usage({ inputTokens: 130 + i * 10, outputTokens: 35 + i * 8, totalCostUsd: 0.001 + i * 0.0001 }); }
    c.text("The work is underway. I will incorporate the delegated results as they arrive."); return;
  }
  if (!c.prompt.includes("<baton-assignment")) {
    await c.sleep(450); c.text("The delegated work is complete. The architecture and tests look sound; the integration check exposed a configuration issue that should be fixed before release. The research result is available in the delegation details."); return;
  }
  if (c.spec.title === "Integration check") { await c.sleep(2100); throw new Error("Demo integration check: missing test fixture (simulated failure)"); }
  if (c.spec.title === "Review the implementation") {
    const d = await c.call<{ delegationId: string }>("delegate", { agent: "fake-claude", title: "Check test coverage", task: "Inspect the test plan and report a concise coverage assessment.", readonly: true });
    await c.sleep(1300); c.text("Architecture review: the event log keeps the console and projections consistent.\n");
    await c.call("wait", { delegationIds: [d.delegationId], mode: "all", timeoutSec: 10 });
    await c.sleep(700); await c.call("report_result", { status: "success", summary: "Reviewed architecture and incorporated specialist test coverage. Recommend adding restart recovery checks.", result: { reviewed: true, risks: ["restart recovery"] } }); return;
  }
  if (c.spec.title === "Research options") {
    await c.sleep(1100);
    const permission = await c.permission({ id: "demo-inspect-config", kind: "tool", name: "Read local configuration", title: "Allow read-only configuration inspection?", description: "This is a simulated permission request; the fake agent will not read files.", detail: { type: "read", filePath: "./config.json" }, actions: [{ id: "allow", label: "Allow", behavior: "allow" }, { id: "deny", label: "Deny", behavior: "deny" }] });
    await c.sleep(1200); c.text(permission.behavior === "allow" ? "Configuration inspected. The local provider adapters cover the required use cases." : "Inspection was declined. The public architecture still supports the required provider mix.");
    await c.call("report_result", { status: permission.behavior === "allow" ? "success" : "partial", summary: "Compared the provider options and documented the permission decision.", artifacts: [{ kind: "note", value: "Claude, Codex and Pi can collaborate through the same delegation interface." }] }); return;
  }
  await c.sleep(900); c.text("Coverage includes delegation limits, result delivery, permissions and cancellation.");
  await c.call("report_result", { status: "success", summary: "Test coverage assessed. Add a persistence restart test and a resumable SSE check.", result: { coverage: ["delegation", "permissions", "cancel", "SSE"] } });
}

/** The default console demo deliberately stops at the human approval gate. */
/** `write <path> <text>` / `delete <path>` lines make the demo agent change files in its cwd. */
async function demoFileCommands(c: FakeContext): Promise<boolean> {
  const commands = [...c.prompt.matchAll(/^(write|delete) +(\S+)(?: +(.*))?$/gm)];
  if (!commands.length) return false;
  for (const [, verb, path, content] of commands) {
    const target = resolve(c.spec.cwd, path!);
    if (target !== c.spec.cwd && !target.startsWith(c.spec.cwd + sep)) { c.text(`Refusing to touch ${path} outside the working directory.\n`); continue; }
    const callId = randomUUID();
    if (verb === "write") { await mkdir(dirname(target), { recursive: true }); await writeFile(target, `${content ?? ""}\n`); }
    else await rm(target, { force: true });
    c.item({ type: "tool_call", callId, name: verb === "write" ? "Write" : "Delete", status: "completed", detail: verb === "write" ? { type: "write", filePath: path!, content: content ?? "" } : { type: "shell", command: `rm ${path}`, cwd: c.spec.cwd } });
    await c.sleep(150);
  }
  c.text(`Done: ${commands.map(([, verb, path]) => `${verb === "write" ? "wrote" : "deleted"} ${path}`).join(", ")}.`);
  return true;
}
async function demoScript(c: FakeContext): Promise<void> {
  if (await demoFileCommands(c)) return;
  if (c.images.length) c.text(`I received ${c.images.length === 1 ? "an image" : `${c.images.length} images`}: ${c.images.map((image) => `[image ${image.name ?? "unnamed"}]`).join(", ")}.\n\n`);
  if (c.prompt === "legacy demo" || c.spec.title === "legacy demo" || ["Review the implementation", "Research options", "Integration check", "Check test coverage"].includes(c.spec.title ?? "")) return legacyDemoScript(c);
  if (c.spec.systemPrompt?.includes("SOLO mode")) { c.text("I completed the demo request independently and verified the result."); return; }
  if (c.prompt.includes("<baton-assignment")) {
    c.reasoning("I will respect my team's file ownership and report a concise result.");
    c.usage({ inputTokens: 120, outputTokens: 20, totalCostUsd: 0.001 });
    if (c.spec.title === "Implement the feature" && c.spec.model === "demo-initial-builder") {
      c.text("The initial implementation is drafted. A provider-specific integration mismatch needs a different specialist.");
      c.item({ type: "tool_call", callId: "demo-edit", name: "edit", status: "completed", detail: { type: "edit", filePath: "src/demo-feature.ts" } });
      await c.sleep(1400); throw new Error("Demo: integration mismatch; reassign to another member");
    }
    if (c.spec.title === "Research the options") {
      await c.sleep(600);
      await c.permission({ id: "demo-read", name: "Inspect configuration", kind: "tool", title: "Allow simulated read-only inspection?", description: "The fake agent will not read real files.", detail: { type: "read", filePath: "config.json" } });
    }
    await c.sleep(900); c.text(c.spec.title === "Implement the feature" ? "I resumed from the predecessor's progress, fixed the integration and verified it." : "The assigned review is complete. File ownership and interfaces are consistent.");
    await c.call("report_result", { status: "success", summary: c.spec.title === "Implement the feature" ? "Replacement completed the implementation and integration checks." : `${c.spec.title} completed.`, result: { verified: true }, artifacts: [{ kind: "note", value: "Demo output only; no files were modified." }] }); return;
  }
  if (c.turn === 1 && !c.spec.systemPrompt?.includes("Collaboration mode: PRESET")) {
    c.reasoning("Three independent responsibilities give us useful parallel work without overlapping files.");
    const proposal = await c.call<{ status?: string }>("form_team", { rationale: "A small team separates implementation, review and research; each role owns different files.", members: [
      { role: "builder", agent: "fake-codex", model: "demo-initial-builder", responsibilities: "Implement src/demo-feature.ts and preserve the agreed interfaces.", reason: "Codex handles implementation." },
      { role: "reviewer", agent: "fake-claude", responsibilities: "Review architecture and own tests/demo-feature.test.ts.", reason: "Claude checks interfaces and edge cases." },
      { role: "researcher", agent: "fake-pi", responsibilities: "Read-only research; own the findings in docs/demo-options.md.", reason: "Pi compares options quickly." },
    ] });
    if (proposal.status === "pending_approval") { c.text("I proposed three roles with separate file ownership. Please approve or edit the roster in the console; I will start after confirmation."); return; }
  }
  const team = await c.call<{ members: Array<{ role: string; agentId: string; status: string; delegations: Array<{ id: string; status: string }> }> }>("get_team", {});
  for (const member of team.members.filter((m) => m.status === "active")) {
    if (!member.delegations.length) {
      const titles: Record<string, string> = { builder: "Implement the feature", reviewer: "Review the interfaces", researcher: "Research the options" };
      await c.call("delegate", { role: member.role, title: titles[member.role] ?? `Work as ${member.role}`, task: `Complete the ${member.role} scope, respect team file ownership and report the result.`, readonly: member.role === "researcher" });
    } else if (member.delegations.some((d) => d.status === "failed")) {
      await c.call("replace_member", { role: member.role, agent: "fake-claude", model: "demo-replacement-builder", reason: "The first member hit an integration mismatch; a different agent will take over with its progress summary." });
      c.text("The builder failed. I proposed a replacement; approving it transfers the existing task and recorded progress."); return;
    }
  }
  c.text(team.members.some((m) => m.delegations.some((d) => ["queued", "running"].includes(d.status))) ? "The approved team is working in parallel. I will integrate its results." : "I have integrated the team results and verified the completed work, including the reassigned implementation.");
}
