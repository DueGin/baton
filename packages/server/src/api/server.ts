import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_TYPES, type PullRequestFeedbackRequest, CreateProjectRequest, PatchProjectRequest, CreatePermissionRuleRequest, ResolveEscalationRequest, ApproveTeamProposalRequest, AddMemberRequest, ReplaceMemberRequest, ReassignRequest, SaveTeamPresetRequest, TeamPresetInput, CreateRunRequest, PatchRunRequest, PermissionDecision, RunEventEnvelope, SendMessageResponse, UpdateSettingsRequest, TestTitleModelRequest, RollbackRequest } from "@baton/protocol";
import type { UpdateNodeConfigRequest } from "@baton/protocol";
import type { DriverRegistry } from "../driver/types.js";
import { FakeDriverRegistry } from "../driver/fake.js";
import { Store } from "../store/index.js";
import { DEFAULT_POLICY, Kernel, MessageError } from "../kernel/index.js";
import { handleMcp } from "../mcp/index.js";
import { NotificationHub, Notifications, desktopNotifier, notificationMode, type NotificationMode, type Notifier } from "../notifications/index.js";
import { exportRun, type ExportFormat } from "../telemetry/index.js";
import { Settings } from "../settings/index.js";
import { Titles, type TitleGenerator } from "../titles/index.js";
import { BackgroundRegistry, type BackgroundOptions } from "../background/index.js";
import { Projects, ProjectError } from "../projects/index.js";
import { PullRequests, type PullRequestOptions } from "../pull-requests/index.js";
import { AttachmentError, Attachments, isAttachmentMimeType, readLocalImage } from "../attachments/index.js";
import { CheckpointError, Checkpoints } from "../checkpoints/index.js";
import { ShadowGit, type ShadowGitOptions } from "../checkpoints/shadow-git.js";
export interface StartServerOptions {
  home?: string; port?: number; registry?: DriverRegistry; fake?: boolean; webDist?: string;
  maxActiveNodes?: number; deliveryDebounceMs?: number; idleTimeoutMs?: number; stallTimeoutMs?: number; askTimeoutMinutes?: number; notifier?: Notifier; notificationCoalesceMs?: number;
  titleGenerator?: TitleGenerator;
  background?: BackgroundOptions;
  pullRequests?: PullRequestOptions;
  notifications?: NotificationMode;
  /** Injectable OS transport; notifier remains an application/test observer. */
  osNotifier?: Notifier;
  /** Internal platform injection for deterministic filesystem/capability tests. */
  platform?: NodeJS.Platform;
  /** Default-port base for tests; an explicit port always disables fallback. */
  portBase?: number;
  /** File checkpoints for rollback (DESIGN §4.13): false disables file snapshots; an object tunes the caps. */
  fileCheckpoints?: false | Partial<Omit<ShadowGitOptions, "root">>;
}
export interface BatonServer {
  home: string; port: number; token: string; url: string; server: Server; store: Store; kernel: Kernel; background: BackgroundRegistry; pullRequests: PullRequests; attachments: Attachments;
  close(): Promise<void>;
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
/** A captured path segment, percent-decoded (ids such as "<nodeId>:<toolUseId>" arrive as %3A). */
function segment(value: string): string { try { return decodeURIComponent(value); } catch { throw new HttpError(400, "Malformed path segment"); } }
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body)); }
/** JSON request body. A POST without a body (no Content-Type, nothing sent) reads as `{}`; a body
 * that is present must be application/json. */
async function body(request: IncomingMessage): Promise<unknown> {
  const json = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() === "application/json";
  const parts: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); length += part.length;
    if (length > 1024 * 1024) throw new HttpError(413, "Request body too large"); parts.push(part);
  }
  if (!length) return {};
  if (!json) throw new HttpError(415, "Only application/json request bodies are accepted");
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; } catch { throw new HttpError(400, "Invalid JSON body"); }
}
/** Raw request bytes up to `limit`. An oversized body is drained (within reason) before the 413 so
 * the client can read the response. */
async function rawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  const tooLarge = (): HttpError => new HttpError(413, `Request body exceeds ${limit} bytes`);
  if (Number.isFinite(declared) && declared > limit) { request.resume(); throw tooLarge(); }
  const parts: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); length += part.length;
    if (length <= limit) parts.push(part);
    else if (length > limit * 2) { request.destroy(); throw tooLarge(); }
  }
  if (length > limit) throw tooLarge();
  return Buffer.concat(parts);
}
function image(response: ServerResponse, bytes: Buffer, mimeType: string, cacheControl: string, name?: string): void {
  response.writeHead(200, { "content-type": mimeType, "content-length": bytes.length, "cache-control": cacheControl, "x-content-type-options": "nosniff", ...(name ? { "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}` } : {}) }).end(bytes);
}
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected a JSON object"); return value as Record<string, unknown>; }
function sequence(value: string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, "Invalid sequence"); return n;
}
export async function startServer(options: StartServerOptions = {}): Promise<BatonServer> {
  const home = resolve(options.home ?? process.env.BATON_HOME ?? join(homedir(), ".baton"));
  if (options.port === 6767) throw new Error("Port 6767 is reserved for Paseo");
  await mkdir(home, { recursive: true, mode: 0o700 });
  let token: string;
  try { token = (await readFile(join(home, "token"), "utf8")).trim(); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    token = randomBytes(32).toString("hex"); await writeFile(join(home, "token"), token, { mode: 0o600, flag: "wx" });
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("Invalid daemon token file");
  await chmod(join(home, "token"), 0o600);
  const store = new Store(join(home, "baton.db"));
  const attachments = new Attachments(store, join(home, "attachments"));
  const checkpoints = new Checkpoints(store, options.fileCheckpoints === false ? undefined : new ShadowGit({ ...options.fileCheckpoints, root: join(home, "checkpoints"), exclude: [home, ...(options.fileCheckpoints?.exclude ?? [])] }));
  let registry: DriverRegistry;
  try { registry = options.registry ?? (options.fake ? new FakeDriverRegistry() : (await import("../driver/paseo-adapter.js")).createPaseoDriverRegistry({ home, saveImage: (data, mimeType, name) => attachments.saveImage(data, mimeType, name) })); }
  catch (error) { store.close(); throw error; }
  if (registry instanceof FakeDriverRegistry) registry.saveImage = (data, mimeType, name) => attachments.saveImage(data, mimeType, name);
  try {
    const projects = new Projects(store); await projects.migrate();
    if (options.fake) { const path = join(home, "demo-project"); await mkdir(path, { recursive: true }); await projects.create({ path, name: "Demo project" }); }
  } catch (error) { store.close(); await registry.shutdown(); throw error; }
  const settings = new Settings(home), titles = new Titles(settings, options.titleGenerator);
  const platform = options.platform ?? process.platform;
  let hub: NotificationHub;
  try { hub = new NotificationHub(notificationMode(await settings.config(), options.notifications, platform), options.osNotifier ?? (options.notifier ? () => {} : desktopNotifier), platform); }
  catch (error) { store.close(); throw error; }
  // Test/application injected notifiers still observe notifications independently of the OS mode.
  const notify: Notifier = options.notifier ? async (event) => { await hub.notify(event); await options.notifier!(event); } : hub.notify;
  const notifications = new Notifications(store, notify, options.notificationCoalesceMs);
  let kernel: Kernel, background: BackgroundRegistry, pullRequests: PullRequests, port = 0;
  const streams = new Set<ServerResponse>();
  const webDist = resolve(options.webDist ?? fileURLToPath(new URL("../../../web/dist", import.meta.url)));
  const server = createServer((request, response) => {
    if (shuttingDown) { json(response, 503, { error: { code: "SHUTTING_DOWN", message: "Daemon is shutting down" } }); return; }
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof HttpError || error instanceof ProjectError || error instanceof MessageError || error instanceof AttachmentError || error instanceof CheckpointError ? error.status : /not found/i.test(message) ? 404 : 400;
      json(response, status, { error: { code: `HTTP_${status}`, message } });
    });
  });
  let shuttingDown = false;
  function notificationStream(response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" }); response.flushHeaders(); streams.add(response);
    const unsubscribe = hub.subscribe((event) => response.write(`event: notification\ndata: ${JSON.stringify(event)}\n\n`));
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000); heartbeat.unref();
    response.once("close", () => { clearInterval(heartbeat); unsubscribe(); streams.delete(response); });
  }
  function inboxStream(response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" }); response.flushHeaders(); streams.add(response);
    let previous = JSON.stringify(store.inbox()), timer: NodeJS.Timeout | undefined;
    const unsubscribe = store.subscribe(() => {
      // Coalesce without postponing forever while providers continuously stream items.
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; const current = JSON.stringify(store.inbox()); if (current !== previous) { previous = current; response.write('event: changed\ndata: {}\n\n'); } }, 50);
    });
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000); heartbeat.unref();
    response.once("close", () => { clearTimeout(timer); clearInterval(heartbeat); unsubscribe(); streams.delete(response); });
  }
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "Host not allowed");
    if (request.headers.origin && request.headers.origin !== `http://${host}`) throw new HttpError(403, "Origin not allowed");
    const url = new URL(request.url ?? "/", `http://${host}`), path = url.pathname, method = request.method ?? "GET";
    const mcp = /^\/mcp\/n\/([a-f0-9]{64})$/.exec(path);
    if (mcp) { await handleMcp(kernel, mcp[1]!, request, response, method === "POST" ? await body(request) : undefined); return; }
    if (path.startsWith("/api/")) {
      const provided = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : (method === "GET" && path.endsWith("/events") ? url.searchParams.get("token") : null);
      if (!provided || Buffer.byteLength(provided) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) throw new HttpError(401, "Bearer token required");
      if (method === "POST" && path === "/api/attachments") {
        const type = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
        if (!isAttachmentMimeType(type)) { request.resume(); throw new HttpError(415, `Unsupported attachment type: ${type || "none"}; expected ${ATTACHMENT_MIME_TYPES.join(", ")}`); }
        const header = request.headers["x-attachment-name"];
        let name: string | undefined;
        if (typeof header === "string" && header) { try { name = decodeURIComponent(header); } catch { request.resume(); throw new HttpError(400, "Malformed X-Attachment-Name header"); } }
        json(response, 201, await attachments.save(await rawBody(request, ATTACHMENT_MAX_BYTES), type, name)); return;
      }
      const attachmentRoute = /^\/api\/attachments\/([^/]+)$/.exec(path);
      if (method === "GET" && attachmentRoute) {
        const found = await attachments.read(segment(attachmentRoute[1]!));
        if (!found) throw new HttpError(404, "Attachment not found");
        // Ids are content-immutable, so clients may cache them indefinitely.
        image(response, found.bytes, found.record.mimeType, "private, max-age=31536000, immutable", found.record.name); return;
      }
      if (method === "GET" && path === "/api/files/image") {
        const target = url.searchParams.get("path");
        if (!target) throw new HttpError(400, "path query parameter is required");
        const local = await readLocalImage(target);
        if (!local) throw new HttpError(404, "Image not found");
        image(response, local.bytes, local.mimeType, "private, no-cache"); return;
      }
      if (path === "/api/projects") {
        if (method === "GET") { json(response, 200, await kernel.projects.list(url.searchParams.get("archived") === "1")); return; }
        if (method === "POST") { json(response, 201, await kernel.projects.create(record(await body(request)) as unknown as CreateProjectRequest)); return; }
      }
      const projectRoute = /^\/api\/projects\/([^/]+)$/.exec(path);
      if (projectRoute) {
        const id = decodeURIComponent(projectRoute[1]!);
        if (method === "GET") { json(response, 200, await kernel.projects.summary(id)); return; }
        if (method === "PATCH") { kernel.projects.patch(id, record(await body(request)) as PatchProjectRequest); json(response, 200, await kernel.projects.summary(id)); return; }
      }
      if (method === "GET" && path === "/api/fs/dirs") { json(response, 200, await kernel.projects.dirs(url.searchParams.get("path") ?? undefined, url.searchParams.get("hidden") === "1")); return; }
      if (method === "GET" && path === "/api/prs") { json(response, 200, pullRequests.list(url.searchParams.get("projectId") ?? undefined, url.searchParams.get("state") ?? "open")); return; }
      const linkPr = /^\/api\/runs\/([^/]+)\/prs$/.exec(path);
      if (method === "POST" && linkPr) { const input = record(await body(request)); json(response, 201, pullRequests.link(decodeURIComponent(linkPr[1]!), input.url as string, input.nodeId as string | undefined)); return; }
      const pr = /^\/api\/prs\/([^/]+)(?:\/(refresh|feedback))?$/.exec(path);
      if (pr) {
        const id = decodeURIComponent(pr[1]!);
        if (method === "DELETE" && !pr[2]) { json(response, 200, pullRequests.unlink(id)); return; }
        if (method === "POST" && pr[2] === "refresh") { await body(request); json(response, 200, await pullRequests.refresh(id)); return; }
        if (method === "POST" && pr[2] === "feedback") { json(response, 202, await pullRequests.feedback(id, record(await body(request)) as unknown as PullRequestFeedbackRequest)); return; }
      }
      if (method === "GET" && path === "/api/background") { await background.scan(); json(response, 200, background.list(url.searchParams.get("status") ?? "running")); return; }
      const backgroundRoute = /^\/api\/background\/([^/]+)\/(stop|dismiss)$/.exec(path);
      if (method === "POST" && backgroundRoute) {
        const input = record(await body(request)), id = decodeURIComponent(backgroundRoute[1]!);
        json(response, 200, backgroundRoute[2] === "stop" ? await background.stop(id, input.graceMs as number | undefined) : background.dismiss(id, input.dismissed as boolean)); return;
      }
      if (path === "/api/settings") {
        if (method === "GET") { json(response, 200, { ...await settings.get(), github: await pullRequests.githubStatus() }); return; }
        if (method === "PUT") { const saved = await settings.update(record(await body(request)) as UpdateSettingsRequest); json(response, 200, { ...saved, github: await pullRequests.githubStatus() }); return; }
      }
      if (method === "POST" && path === "/api/settings/title-model/test") {
        const input = record(await body(request)) as TestTitleModelRequest, latest = store.list()[0];
        json(response, 200, await titles.test(input, latest ? kernel.firstPrompt(latest.id) : "Build a simple task management app.")); return;
      }
      if (method === "GET" && path === "/api/inbox") { json(response, 200, store.inbox()); return; }
      if (method === "GET" && path === "/api/inbox/events") { inboxStream(response); return; }
      if (method === "GET" && path === "/api/notifications/events") { notificationStream(response); return; }
      if (path === "/api/permission-rules") {
        if (method === "GET") { json(response, 200, store.rules()); return; }
        if (method === "POST") { json(response, 201, kernel.rules.create(record(await body(request)) as unknown as CreatePermissionRuleRequest)); return; }
      }
      const permissionRule = /^\/api\/permission-rules\/([^/]+)$/.exec(path);
      if (method === "DELETE" && permissionRule) { store.deleteRule(segment(permissionRule[1]!)); json(response, 200, { deleted: true }); return; }
      const question = /^\/api\/questions\/([^/]+)\/answer$/.exec(path);
      const declineRoute = /^\/api\/questions\/([^/]+)\/decline$/.exec(path);
      if (method === "POST" && declineRoute) { await body(request); json(response, 200, await kernel.human.decline(segment(declineRoute[1]!))); return; }
      if (method === "POST" && question) { const input = record(await body(request)); json(response, 200, await kernel.human.answer(segment(question[1]!), input)); return; }
      const escalation = /^\/api\/escalations\/([^/]+)\/resolve$/.exec(path);
      if (method === "POST" && escalation) { json(response, 200, await kernel.human.resolve(segment(escalation[1]!), record(await body(request)) as unknown as ResolveEscalationRequest)); return; }
      if (method === "GET" && path === "/api/info") { json(response, 200, { name: "baton", version: "0.1.0", home, port, platform, features: { backgroundProcesses: platform !== "win32", notificationStream: true }, defaults: DEFAULT_POLICY }); return; }
      if (method === "GET" && path === "/api/agents") { json(response, 200, await kernel.agents()); return; }
      if (method === "POST" && path === "/api/agents/refresh") { await body(request); json(response, 200, await kernel.agents(true)); return; }
      if (path === "/api/runs") {
        if (method === "GET") { json(response, 200, store.list(url.searchParams.get("projectId") ?? undefined)); return; }
        if (method === "POST") { json(response, 201, await kernel.createRun(record(await body(request)) as unknown as CreateRunRequest)); return; }
      }
      if (path === "/api/teams") {
        if (method === "GET") { json(response, 200, store.presets()); return; }
        if (method === "POST") { json(response, 201, await kernel.teams.savePreset(record(await body(request)) as unknown as TeamPresetInput)); return; }
      }
      const preset = /^\/api\/teams\/([^/]+)$/.exec(path);
      if (preset) {
        if (method === "GET") { json(response, 200, store.preset(segment(preset[1]!))); return; }
        if (method === "PUT") { json(response, 200, await kernel.teams.savePreset(record(await body(request)) as unknown as TeamPresetInput, segment(preset[1]!))); return; }
        if (method === "DELETE") { store.deletePreset(segment(preset[1]!)); json(response, 200, { deleted: true }); return; }
      }
      const proposalRoute = /^\/api\/runs\/([^/]+)\/team\/proposals\/([^/]+)\/(approve|reject)$/.exec(path);
      if (method === "POST" && proposalRoute) {
        const input = record(await body(request));
        const result = proposalRoute[3] === "approve" ? await kernel.teams.approve(segment(proposalRoute[1]!), segment(proposalRoute[2]!), input as ApproveTeamProposalRequest) : await kernel.teams.reject(segment(proposalRoute[1]!), segment(proposalRoute[2]!), input.feedback as string);
        json(response, 200, result); return;
      }
      const teamRoute = /^\/api\/runs\/([^/]+)\/team\/(members|save-preset)(?:\/([^/]+)(?:\/(replace))?)?$/.exec(path);
      if (teamRoute) {
        const id = segment(teamRoute[1]!), memberId = teamRoute[3]; store.snapshot(id);
        if (method === "POST" && teamRoute[2] === "save-preset") { json(response, 201, await kernel.teams.saveRun(id, record(await body(request)) as unknown as SaveTeamPresetRequest)); return; }
        if (method === "POST" && !memberId) { json(response, 201, await kernel.teams.add(id, record(await body(request)) as unknown as AddMemberRequest)); return; }
        if (method === "POST" && memberId && teamRoute[4] === "replace") { json(response, 200, await kernel.teams.replace(id, memberId, record(await body(request)) as unknown as ReplaceMemberRequest, "human")); return; }
        if (method === "DELETE" && memberId && !teamRoute[4]) { json(response, 200, kernel.teams.remove(id, memberId)); return; }
      }
      const reassign = /^\/api\/delegations\/([^/]+)\/reassign$/.exec(path);
      if (method === "POST" && reassign) { json(response, 200, await kernel.teams.reassign(segment(reassign[1]!), record(await body(request)) as unknown as ReassignRequest)); return; }
      const regenerate = /^\/api\/runs\/([^/]+)\/title\/regenerate$/.exec(path);
      if (method === "POST" && regenerate) {
        await body(request); store.snapshot(segment(regenerate[1]!));
        try { json(response, 200, await kernel.regenerateTitle(segment(regenerate[1]!))); }
        catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)); }
        return;
      }
      const run = /^\/api\/runs\/([^/]+)(?:\/(events|cancel|export|pause|resume))?$/.exec(path);
      if (run) {
        const id = segment(run[1]!), action = run[2]; store.snapshot(id);
        if (method === "GET" && !action) { json(response, 200, store.snapshot(id)); return; }
        if (method === "POST" && (action === "pause" || action === "resume")) { json(response, 200, action === "pause" ? await kernel.pauseRun(id) : await kernel.resumeRun(id)); return; }
        if (method === "PATCH" && !action) { json(response, 200, kernel.patchRun(id, record(await body(request)) as PatchRunRequest)); return; }
        if (method === "POST" && action === "cancel") {
          const input = request.headers["content-length"] === "0" || !request.headers["content-length"] && !request.headers["transfer-encoding"] ? {} : record(await body(request));
          if (input.stopBackground !== undefined && typeof input.stopBackground !== "boolean") throw new HttpError(400, "stopBackground must be a boolean");
          if (input.stopBackground) { await background.scan(); await background.stopRun(id); }
          await kernel.cancelRun(id); json(response, 200, store.snapshot(id)); return;
        }
        if (method === "GET" && action === "events") {
          const after = sequence(url.searchParams.get("after") ?? (typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined));
          if (!request.headers.accept?.includes("text/event-stream")) { json(response, 200, store.events(id, after)); return; }
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" }); response.flushHeaders(); streams.add(response);
          const write = (event: RunEventEnvelope): void => { response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`); };
          let cursor = after;
          // Subscribe and replay in the same synchronous turn: no events can fall in the gap.
          const unsubscribe = store.subscribe((event) => { if (event.runId === id && event.seq > cursor) { cursor = event.seq; write(event); } });
          for (const event of store.events(id, after)) { cursor = event.seq; write(event); }
          const timer = setInterval(() => response.write(": heartbeat\n\n"), 15000); timer.unref();
          response.once("close", () => { clearInterval(timer); unsubscribe(); streams.delete(response); }); return;
        }
        if (method === "GET" && action === "export") {
          const format = url.searchParams.get("format") ?? "json";
          if (!["json", "md", "otlp"].includes(format)) throw new HttpError(400, "Invalid export format");
          response.writeHead(200, { "content-type": format === "md" ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8", "content-disposition": `attachment; filename="${id}.${format === "md" ? "md" : "json"}"` }).end(exportRun(store, id, format as ExportFormat)); return;
        }
      }
      const message = /^\/api\/nodes\/([^/]+)\/messages\/([^/]+)(\/deliver)?$/.exec(path);
      if (message) {
        const id = segment(message[1]!), seq = sequence(message[2]);
        if (seq < 1) throw new HttpError(400, "Invalid message sequence");
        if (method === "POST" && message[3]) {
          const input = record(await body(request));
          if (input.mode !== "steer" && input.mode !== "interrupt") throw new HttpError(400, "Invalid delivery mode");
          const delivered = await kernel.deliverHumanMessage(id, seq, input.mode);
          const result: SendMessageResponse = { accepted: true, ...delivered };
          json(response, 202, result); return;
        }
        if (method === "DELETE" && !message[3]) { kernel.retractMessage(id, seq); json(response, 200, { accepted: true }); return; }
        if (method === "PATCH" && !message[3]) {
          const input = record(await body(request));
          kernel.editMessage(id, seq, input.text as string);
          json(response, 200, { accepted: true }); return;
        }
      }
      const checkpointChanges = /^\/api\/checkpoints\/([^/]+)\/changes$/.exec(path);
      if (method === "GET" && checkpointChanges) { json(response, 200, await kernel.rollbacks.changes(segment(checkpointChanges[1]!))); return; }
      const node = /^\/api\/nodes\/([^/]+)(?:\/(items|messages|cancel|queue|checkpoints|rollback))?$/.exec(path);
      if (node) {
        const id = segment(node[1]!); store.node(id);
        if (method === "PATCH" && !node[2]) {
          const input = record(await body(request)), config: UpdateNodeConfigRequest = {};
          for (const key of ["model", "modeId", "thinking"] as const) {
            const value = input[key];
            if (value === undefined) continue;
            if (value !== null && (typeof value !== "string" || !value.trim())) throw new HttpError(400, `${key} must be a nonempty string or null`);
            config[key] = value;
          }
          json(response, 200, await kernel.updateNodeConfig(id, config)); return;
        }
        if (method === "GET" && node[2] === "checkpoints") { json(response, 200, kernel.rollbacks.list(id)); return; }
        if (method === "POST" && node[2] === "rollback") { json(response, 200, await kernel.rollbacks.rollback(id, record(await body(request)) as unknown as RollbackRequest)); return; }
        if (method === "PUT" && node[2] === "queue") {
          const input = record(await body(request));
          if (!Array.isArray(input.order) || !input.order.every((seq: unknown) => typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0)) throw new HttpError(400, "order must be an array of positive item sequences");
          json(response, 200, kernel.reorderQueue(id, input.order as number[])); return;
        }
        if (method === "GET" && node[2] === "items") { const after = sequence(url.searchParams.get("after")), items = store.items(id, after); json(response, 200, { items, lastSeq: items.at(-1)?.seq ?? after }); return; }
        if (method === "POST" && node[2] === "messages") {
          const input = record(await body(request));
          if (input.clientId !== undefined && typeof input.clientId !== "string") throw new HttpError(400, "clientId must be a string");
          if (input.mode !== undefined && input.mode !== "queue" && input.mode !== "steer" && input.mode !== "interrupt") throw new HttpError(400, "Invalid send mode");
          const delivered = await kernel.message(id, input.text as string, input.clientId, input.mode);
          const result: SendMessageResponse = { accepted: true, ...delivered };
          json(response, 202, result); return;
        }
        if (method === "POST" && node[2] === "cancel") { await body(request); await kernel.cancelNode(id); json(response, 200, store.node(id)); return; }
      }
      const permission = /^\/api\/permissions\/([^/]+)$/.exec(path);
      if (method === "POST" && permission) { const input = record(await body(request)) as unknown as PermissionDecision; await kernel.respondPermission(decodeURIComponent(permission[1]!), input.response, "human", input.remember); json(response, 200, { accepted: true }); return; }
      const delegation = /^\/api\/delegations\/([^/]+)$/.exec(path);
      if (method === "GET" && delegation) { json(response, 200, store.delegation(segment(delegation[1]!))); return; }
      throw new HttpError(404, "API route not found");
    }
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
    let file = resolve(webDist, `.${decodeURIComponent(path)}`);
    if (file !== webDist && !file.startsWith(webDist + sep)) throw new HttpError(403, "Path not allowed");
    try { if (!(await stat(file)).isFile()) file = join(webDist, "index.html"); }
    catch { file = join(webDist, "index.html"); }
    try {
      const contents = await readFile(file), types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
      const cacheControl = file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": cacheControl }).end(method === "HEAD" ? undefined : contents);
    } catch { json(response, 404, { error: { code: "WEB_NOT_BUILT", message: "Console not built. Build packages/web or use the REST API." } }); }
  }
  try {
    const base = options.port ?? options.portBase ?? 7433;
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolveListening, reject) => {
          const error = (err: Error): void => { server.off("listening", listening); reject(err); };
          const listening = (): void => { server.off("error", error); resolveListening(); };
          server.once("error", error); server.once("listening", listening); server.listen(base + attempt, "127.0.0.1");
        }); break;
      } catch (error) { if (options.port !== undefined || attempt >= 20 || !error || typeof error !== "object" || !("code" in error) || error.code !== "EADDRINUSE") throw error; }
    }
  } catch (error) { notifications.close(); store.close(); await registry.shutdown(); throw error; }
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Invalid server address"); port = address.port;
  const url = `http://127.0.0.1:${port}`;
  kernel = new Kernel(store, registry, { ...options, baseUrl: url, titles, attachments, checkpoints }); kernel.recover();
  background = new BackgroundRegistry(store, () => kernel.processSources(), { platform, ...options.background });
  pullRequests = new PullRequests(store, settings, { queue: (id, text) => kernel.queueFeedback(id, text), notify }, options.pullRequests);
  await writeFile(join(home, "daemon.json"), JSON.stringify({ url, port, pid: process.pid, startedAt: new Date().toISOString(), version: "0.1.0", spawnedBy: process.env.BATON_SPAWNED_BY === "desktop" ? "desktop" : "cli" }), { mode: 0o600 });
  let closing: Promise<void> | undefined;
  return { home, token, port, url, server, store, kernel, background, pullRequests, attachments, close() {
    closing ??= (async () => {
      shuttingDown = true; notifications.close(); hub.close();
      for (const stream of streams) stream.end();
      const closed = new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed())); server.closeAllConnections();
      const results = await Promise.allSettled([pullRequests.close(), background.close(), kernel.shutdown()]);
      await closed; store.close();
      const failed = results.find((result) => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
    })(); return closing;
  } };
}
