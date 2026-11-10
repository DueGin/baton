import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CreatePermissionRuleRequest, ResolveEscalationRequest, ApproveTeamProposalRequest, AddMemberRequest, ReplaceMemberRequest, ReassignRequest, SaveTeamPresetRequest, TeamPresetInput, CreateRunRequest, PatchRunRequest, PermissionDecision, RunEventEnvelope } from "@baton/protocol";
import type { DriverRegistry } from "../driver/types.js";
import { FakeDriverRegistry } from "../driver/fake.js";
import { Store } from "../store/index.js";
import { DEFAULT_POLICY, Kernel } from "../kernel/index.js";
import { handleMcp } from "../mcp/index.js";
import { Notifications, desktopNotifier, type Notifier } from "../notifications/index.js";
import { exportRun, type ExportFormat } from "../telemetry/index.js";
export interface StartServerOptions {
  home?: string; port?: number; registry?: DriverRegistry; fake?: boolean; webDist?: string;
  maxActiveNodes?: number; deliveryDebounceMs?: number; idleTimeoutMs?: number; stallTimeoutMs?: number; notifier?: Notifier; notificationCoalesceMs?: number;
}
export interface BatonServer {
  home: string; port: number; token: string; url: string; server: Server; store: Store; kernel: Kernel;
  close(): Promise<void>;
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body)); }
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new HttpError(415, "Only application/json request bodies are accepted");
  const parts: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); length += part.length;
    if (length > 1024 * 1024) throw new HttpError(413, "Request body too large"); parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; } catch { throw new HttpError(400, "Invalid JSON body"); }
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
  let registry = options.registry;
  if (!registry) registry = options.fake ? new FakeDriverRegistry() : (await import("../driver/paseo-adapter.js")).createPaseoDriverRegistry({ home });
  const store = new Store(join(home, "baton.db"));
  let desktop = process.platform === "darwin";
  try { const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { notifications?: { desktop?: boolean } }; if (typeof config.notifications?.desktop === "boolean") desktop = config.notifications.desktop; }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) { store.close(); throw error; } }
  const notifications = new Notifications(store, options.notifier ?? (desktop ? desktopNotifier : () => {}), options.notificationCoalesceMs);
  let kernel: Kernel, port = 0;
  const streams = new Set<ServerResponse>();
  const webDist = resolve(options.webDist ?? fileURLToPath(new URL("../../../web/dist", import.meta.url)));
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof HttpError ? error.status : /not found/i.test(message) ? 404 : 400;
      json(response, status, { error: { code: `HTTP_${status}`, message } });
    });
  });
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
      if (method === "GET" && path === "/api/inbox") { json(response, 200, store.inbox()); return; }
      if (method === "GET" && path === "/api/inbox/events") { inboxStream(response); return; }
      if (path === "/api/permission-rules") {
        if (method === "GET") { json(response, 200, store.rules()); return; }
        if (method === "POST") { json(response, 201, kernel.rules.create(record(await body(request)) as unknown as CreatePermissionRuleRequest)); return; }
      }
      const permissionRule = /^\/api\/permission-rules\/([^/]+)$/.exec(path);
      if (method === "DELETE" && permissionRule) { store.deleteRule(permissionRule[1]!); json(response, 200, { deleted: true }); return; }
      const question = /^\/api\/questions\/([^/]+)\/answer$/.exec(path);
      if (method === "POST" && question) { const input = record(await body(request)); json(response, 200, kernel.human.answer(question[1]!, input.answer as string)); return; }
      const escalation = /^\/api\/escalations\/([^/]+)\/resolve$/.exec(path);
      if (method === "POST" && escalation) { json(response, 200, await kernel.human.resolve(escalation[1]!, record(await body(request)) as unknown as ResolveEscalationRequest)); return; }
      if (method === "GET" && path === "/api/info") { json(response, 200, { name: "baton", version: "0.1.0", home, port, defaults: DEFAULT_POLICY }); return; }
      if (method === "GET" && path === "/api/agents") { json(response, 200, await kernel.agents()); return; }
      if (method === "POST" && path === "/api/agents/refresh") { await body(request); json(response, 200, await kernel.agents(true)); return; }
      if (path === "/api/runs") {
        if (method === "GET") { json(response, 200, store.list()); return; }
        if (method === "POST") { json(response, 201, await kernel.createRun(record(await body(request)) as unknown as CreateRunRequest)); return; }
      }
      if (path === "/api/teams") {
        if (method === "GET") { json(response, 200, store.presets()); return; }
        if (method === "POST") { json(response, 201, await kernel.teams.savePreset(record(await body(request)) as unknown as TeamPresetInput)); return; }
      }
      const preset = /^\/api\/teams\/([^/]+)$/.exec(path);
      if (preset) {
        if (method === "GET") { json(response, 200, store.preset(preset[1]!)); return; }
        if (method === "PUT") { json(response, 200, await kernel.teams.savePreset(record(await body(request)) as unknown as TeamPresetInput, preset[1]!)); return; }
        if (method === "DELETE") { store.deletePreset(preset[1]!); json(response, 200, { deleted: true }); return; }
      }
      const proposalRoute = /^\/api\/runs\/([^/]+)\/team\/proposals\/([^/]+)\/(approve|reject)$/.exec(path);
      if (method === "POST" && proposalRoute) {
        const input = record(await body(request));
        const result = proposalRoute[3] === "approve" ? await kernel.teams.approve(proposalRoute[1]!, proposalRoute[2]!, input as ApproveTeamProposalRequest) : await kernel.teams.reject(proposalRoute[1]!, proposalRoute[2]!, input.feedback as string);
        json(response, 200, result); return;
      }
      const teamRoute = /^\/api\/runs\/([^/]+)\/team\/(members|save-preset)(?:\/([^/]+)(?:\/(replace))?)?$/.exec(path);
      if (teamRoute) {
        const id = teamRoute[1]!, memberId = teamRoute[3]; store.snapshot(id);
        if (method === "POST" && teamRoute[2] === "save-preset") { json(response, 201, await kernel.teams.saveRun(id, record(await body(request)) as unknown as SaveTeamPresetRequest)); return; }
        if (method === "POST" && !memberId) { json(response, 201, await kernel.teams.add(id, record(await body(request)) as unknown as AddMemberRequest)); return; }
        if (method === "POST" && memberId && teamRoute[4] === "replace") { json(response, 200, await kernel.teams.replace(id, memberId, record(await body(request)) as unknown as ReplaceMemberRequest, "human")); return; }
        if (method === "DELETE" && memberId && !teamRoute[4]) { json(response, 200, kernel.teams.remove(id, memberId)); return; }
      }
      const reassign = /^\/api\/delegations\/([^/]+)\/reassign$/.exec(path);
      if (method === "POST" && reassign) { json(response, 200, await kernel.teams.reassign(reassign[1]!, record(await body(request)) as unknown as ReassignRequest)); return; }
      const run = /^\/api\/runs\/([^/]+)(?:\/(events|cancel|export))?$/.exec(path);
      if (run) {
        const id = run[1]!, action = run[2]; store.snapshot(id);
        if (method === "GET" && !action) { json(response, 200, store.snapshot(id)); return; }
        if (method === "PATCH" && !action) { json(response, 200, kernel.patchRun(id, record(await body(request)) as PatchRunRequest)); return; }
        if (method === "POST" && action === "cancel") { await body(request); await kernel.cancelRun(id); json(response, 200, store.snapshot(id)); return; }
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
      const node = /^\/api\/nodes\/([^/]+)\/(items|messages|cancel)$/.exec(path);
      if (node) {
        const id = node[1]!; store.node(id);
        if (method === "GET" && node[2] === "items") { const after = sequence(url.searchParams.get("after")), items = store.items(id, after); json(response, 200, { items, lastSeq: items.at(-1)?.seq ?? after }); return; }
        if (method === "POST" && node[2] === "messages") { const input = record(await body(request)); await kernel.message(id, input.text as string); json(response, 202, { accepted: true }); return; }
        if (method === "POST" && node[2] === "cancel") { await body(request); await kernel.cancelNode(id); json(response, 200, store.node(id)); return; }
      }
      const permission = /^\/api\/permissions\/([^/]+)$/.exec(path);
      if (method === "POST" && permission) { const input = record(await body(request)) as unknown as PermissionDecision; await kernel.respondPermission(decodeURIComponent(permission[1]!), input.response, "human", input.remember); json(response, 200, { accepted: true }); return; }
      const delegation = /^\/api\/delegations\/([^/]+)$/.exec(path);
      if (method === "GET" && delegation) { json(response, 200, store.delegation(delegation[1]!)); return; }
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
    await new Promise<void>((resolveListening, reject) => { server.once("error", reject); server.listen(options.port ?? 7433, "127.0.0.1", () => { server.off("error", reject); resolveListening(); }); });
  } catch (error) { notifications.close(); store.close(); await registry.shutdown(); throw error; }
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Invalid server address"); port = address.port;
  const url = `http://127.0.0.1:${port}`;
  kernel = new Kernel(store, registry, { ...options, baseUrl: url }); kernel.recover();
  await writeFile(join(home, "daemon.json"), JSON.stringify({ url, port, pid: process.pid }), { mode: 0o600 });
  let closing: Promise<void> | undefined;
  return { home, token, port, url, server, store, kernel, close() {
    closing ??= (async () => { notifications.close(); await kernel.shutdown(); for (const stream of streams) stream.end(); const closed = new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed())); server.closeAllConnections(); await closed; store.close(); })(); return closing;
  } };
}
