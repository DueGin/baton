import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, readToken, SseParser } from "./api.js";
import type { RunEventEnvelope } from "@baton/protocol";

afterEach(() => vi.unstubAllGlobals());
describe("API transport", () => {
  it("lists the catalog and redetects agents through the refresh endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json([])); vi.stubGlobal("fetch", fetchMock); const client = new ApiClient("token");
    expect(await client.agents()).toEqual([]); expect(await client.agents(true)).toEqual([]);
    expect(fetchMock.mock.calls.map(call => [call[0], (call[1] as RequestInit).method])).toEqual([["/api/agents", "GET"], ["/api/agents/refresh", "POST"]]);
  });
  it("lists, links, refreshes, feeds back and unlinks PRs using globally unique encoded IDs", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({})); vi.stubGlobal("fetch", fetchMock); const client = new ApiClient("token"); const id = "run:github:org/repo#12";
    await client.pullRequests("project/1", "all"); await client.linkPullRequest("run/1", { url: "https://github.com/org/repo/pull/12", nodeId: "n1" }); await client.refreshPullRequest(id); await client.feedbackPullRequest(id, { include: ["checks", "reviews"], nodeId: "n1", note: "修复回归" }); await client.unlinkPullRequest(id);
    expect(fetchMock.mock.calls.map(call => [call[0], (call[1] as RequestInit).method])).toEqual([["/api/prs?state=all&projectId=project%2F1", "GET"], ["/api/runs/run%2F1/prs", "POST"], ["/api/prs/run%3Agithub%3Aorg%2Frepo%2312/refresh", "POST"], ["/api/prs/run%3Agithub%3Aorg%2Frepo%2312/feedback", "POST"], ["/api/prs/run%3Agithub%3Aorg%2Frepo%2312", "DELETE"]]);
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual({ url: "https://github.com/org/repo/pull/12", nodeId: "n1" }); expect(JSON.parse((fetchMock.mock.calls[3]![1] as RequestInit).body as string)).toEqual({ include: ["checks", "reviews"], nodeId: "n1", note: "修复回归" });
    const github = { ghPath: "/usr/local/bin/gh", env: { HTTPS_PROXY: "http://localhost:7890" }, trackMentioned: false }; await client.updateSettings({ github }); expect(JSON.parse((fetchMock.mock.calls[5]![1] as RequestInit).body as string)).toEqual({ github });
  });
  it("extracts the URL token, saves it per session and removes it from the address", () => {
    const values = new Map<string, string>();
    const storage: Storage = { get length() { return values.size; }, clear: () => values.clear(), getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null, removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
    const replaceState = vi.fn();
    expect(readToken({ hash: "#token=secret&keep=yes", pathname: "/", search: "?demo=0" }, storage, { replaceState })).toBe("secret");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?demo=0#keep=yes");
    expect(readToken({ hash: "", pathname: "/", search: "" }, storage)).toBe("secret");
  });
  it("parses fragmented SSE data with CRLF and ignores heartbeat frames", () => {
    const received: RunEventEnvelope[] = []; const parser = new SseParser(event => received.push(event));
    const event: RunEventEnvelope = { type: "log", runId: "r", seq: 2, ts: "2026-11-10T00:00:00Z", level: "info", message: "你好" };
    const stream = `: heartbeat\r\n\r\nid: 2\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
    for (const char of stream) parser.push(char);
    expect(received).toEqual([event]);
  });
  it("sends bearer auth, JSON bodies and encoded IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ accepted: true, delivery: "queued", itemSeq: 9 }, { status: 202 })); vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("local-secret");
    expect(await client.send("node/1", "hello", "client-1")).toEqual({ accepted: true, delivery: "queued", itemSeq: 9 });
    expect(fetchMock).toHaveBeenCalledWith("/api/nodes/node%2F1/messages", { method: "POST", headers: { Authorization: "Bearer local-secret", "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello", clientId: "client-1", mode: "queue" }) });
  });
  it("sends explicit delivery modes and upgrades or retracts an existing row", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ accepted: true, delivery: "queued", itemSeq: 12 })); vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("token");
    await client.send("node/1", "hello", "c1", "steer");
    await client.deliver("node/1", 12, { mode: "steer" });
    await client.deliver("node/1", 12, { mode: "interrupt" });
    await client.retract("node/1", 12);
    expect(fetchMock.mock.calls.map(call => [call[0], (call[1] as RequestInit).method])).toEqual([
      ["/api/nodes/node%2F1/messages", "POST"], ["/api/nodes/node%2F1/messages/12/deliver", "POST"], ["/api/nodes/node%2F1/messages/12/deliver", "POST"], ["/api/nodes/node%2F1/messages/12", "DELETE"],
    ]);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ text: "hello", clientId: "c1", mode: "steer" });
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual({ mode: "steer" });
    expect(JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string)).toEqual({ mode: "interrupt" });
  });
  it("submits the complete ordered queue with an encoded node ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ order: [9, 4, 7] })); vi.stubGlobal("fetch", fetchMock);
    expect(await new ApiClient("token").reorderQueue("node/1", { order: [9, 4, 7] })).toEqual({ order: [9, 4, 7] });
    expect(fetchMock).toHaveBeenCalledWith("/api/nodes/node%2F1/queue", { method: "PUT", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ order: [9, 4, 7] }) });
  });
  it("edits only the queued message text at its encoded PATCH endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock);
    await new ApiClient("token").edit("node/1", 7, { text: "更新任务\n保留换行" });
    expect(fetchMock).toHaveBeenCalledWith("/api/nodes/node%2F1/messages/7", { method: "PATCH", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ text: "更新任务\n保留换行" }) });
  });
  it("exposes server error bodies and response status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "invalid token" } }), { status: 401 })));
    await expect(new ApiClient("bad").runs()).rejects.toThrow("401");
  });
  it("pauses/resumes runs without a body and posts structured multi-prompt answers", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ status: "paused" })); vi.stubGlobal("fetch", fetchMock); const client = new ApiClient("token");
    await client.pauseRun("run/1"); await client.resumeRun("run/1");
    const payload = { answers: { scope: ["当前项目"], checks: ["中文", "权限"] }, answer: "范围：当前项目\n验证：中文、权限" }; await client.answer("q/2", payload);
    expect(fetchMock.mock.calls.map(call => [call[0], (call[1] as RequestInit).method])).toEqual([["/api/runs/run%2F1/pause", "POST"], ["/api/runs/run%2F1/resume", "POST"], ["/api/questions/q%2F2/answer", "POST"]]);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBeUndefined(); expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBeUndefined();
    expect(JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string)).toEqual(payload);
  });
  it("edits and regenerates titles and reads, writes and tests the title model", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({})); vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("token");
    await client.patchRun("run/1", { title: "检查登录流程" });
    await client.regenerateTitle("run/1");
    await client.settings();
    await client.updateSettings({ titleModel: { enabled: true, baseUrl: "http://localhost:3425/v1", model: "title-model", apiKey: "write-only", apiKeyEnv: null } });
    await client.testTitleModel({ sample: "实现登录流程", titleModel: { model: "test-model" } });
    expect(fetchMock.mock.calls.map(call => [call[0], (call[1] as RequestInit).method])).toEqual([
      ["/api/runs/run%2F1", "PATCH"], ["/api/runs/run%2F1/title/regenerate", "POST"], ["/api/settings", "GET"], ["/api/settings", "PUT"], ["/api/settings/title-model/test", "POST"],
    ]);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ title: "检查登录流程" });
    expect(JSON.parse((fetchMock.mock.calls[3]![1] as RequestInit).body as string)).toMatchObject({ titleModel: { apiKey: "write-only", apiKeyEnv: null } });
    expect(JSON.parse((fetchMock.mock.calls[4]![1] as RequestInit).body as string)).toEqual({ sample: "实现登录流程", titleModel: { model: "test-model" } });
  });
  it("lists processes, sends stop/dismiss decisions and optionally stops services on run cancel", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({})); vi.stubGlobal("fetch", fetchMock); const client = new ApiClient("token");
    await client.background(); await client.background("all");
    await client.stopBackground("123:4", { graceMs: 3000 }); await client.dismissBackground("123:4", { dismissed: true });
    await client.cancelRun("run/1"); await client.cancelRun("run/1", { stopBackground: true });
    expect(fetchMock.mock.calls.map(call => [call[0], (call[1] as RequestInit).method])).toEqual([
      ["/api/background?status=running", "GET"], ["/api/background?status=all", "GET"], ["/api/background/123%3A4/stop", "POST"], ["/api/background/123%3A4/dismiss", "POST"], ["/api/runs/run%2F1/cancel", "POST"], ["/api/runs/run%2F1/cancel", "POST"],
    ]);
    expect(JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string)).toEqual({ graceMs: 3000 });
    expect(JSON.parse((fetchMock.mock.calls[3]![1] as RequestInit).body as string)).toEqual({ dismissed: true });
    expect(JSON.parse((fetchMock.mock.calls[4]![1] as RequestInit).body as string)).toEqual({});
    expect(JSON.parse((fetchMock.mock.calls[5]![1] as RequestInit).body as string)).toEqual({ stopBackground: true });
  });
  it("sends answers, escalation decisions, remembered permissions and rule mutations", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("token");
    await client.answer("q/1", { answer: "默认隐藏" });
    await client.resolveEscalation("e/2", { resolution: "extend", extraRounds: 3, note: "继续" });
    await client.decide("p/3", { response: { behavior: "allow" }, remember: { scope: "run", pattern: "npm test", agentOnly: true } });
    await client.createPermissionRule({ toolName: "shell", pattern: "npm test", scope: "global", decision: "allow" });
    await client.deletePermissionRule("rule/4");
    expect(fetchMock.mock.calls.map(call => [call[0], (call[1] as RequestInit).method])).toEqual([["/api/questions/q%2F1/answer", "POST"], ["/api/escalations/e%2F2/resolve", "POST"], ["/api/permissions/p%2F3", "POST"], ["/api/permission-rules", "POST"], ["/api/permission-rules/rule%2F4", "DELETE"]]);
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual({ resolution: "extend", extraRounds: 3, note: "继续" });
    expect(JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string).remember).toEqual({ scope: "run", pattern: "npm test", agentOnly: true });
  });
  it("refetches inbox on fragmented changed frames and sends Bearer on its SSE stream", async () => {
    const bytes = new TextEncoder().encode(': heartbeat\r\n\r\nevent: changed\r\ndata: {}\r\n\r\nevent: changed\ndata: {}\n\n');
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body)); vi.stubGlobal("fetch", fetchMock); const changed = vi.fn();
    await new ApiClient("token").inboxEvents(changed, new AbortController().signal);
    expect(changed).toHaveBeenCalledTimes(3); // initial connection reconciliation + two changed events
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/inbox/events");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer token", Accept: "text/event-stream" });
  });
  it("retains additive availability warnings from preset mutations", async () => {
    const saved = { id: "team-1", name: "Preset", lead: { agentId: "gemini" }, members: [], createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z", warnings: ["gemini is currently unavailable"] };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(saved)));
    const client = new ApiClient("token");
    const input = { name: saved.name, lead: saved.lead, members: saved.members };
    expect((await client.createTeam(input)).warnings).toEqual(saved.warnings);
    expect((await client.updateTeam(saved.id, input)).warnings).toEqual(saved.warnings);
    expect((await client.saveTeam("run-1", { name: saved.name })).warnings).toEqual(saved.warnings);
  });
  it("uses the team, proposal and reassignment routes with JSON and encoded identifiers", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("token");
    await client.addMember("run/1", { role: "api", agentId: "codex" });
    await client.replaceMember("run/1", "member/2", { agentId: "pi", reassignActive: true });
    await client.removeMember("run/1", "member/2");
    await client.approveTeam("run/1", "p/3", { members: [{ role: "api", agentId: "pi" }], note: "edited" });
    await client.rejectTeam("run/1", "p/4", { feedback: "smaller team" });
    await client.reassign("d/5", { memberId: "member/2", reason: "handoff" });
    await client.saveTeam("run/1", { name: "Preset" });
    await client.createTeam({ name: "Preset", lead: { agentId: "claude" }, members: [] });
    await client.updateTeam("t/6", { name: "New name", lead: { agentId: "pi" }, members: [] });
    await client.deleteTeam("t/6");
    expect(fetchMock.mock.calls.map(call => [call[0], (call[1] as RequestInit).method])).toEqual([
      ["/api/runs/run%2F1/team/members", "POST"], ["/api/runs/run%2F1/team/members/member%2F2/replace", "POST"], ["/api/runs/run%2F1/team/members/member%2F2", "DELETE"], ["/api/runs/run%2F1/team/proposals/p%2F3/approve", "POST"], ["/api/runs/run%2F1/team/proposals/p%2F4/reject", "POST"], ["/api/delegations/d%2F5/reassign", "POST"], ["/api/runs/run%2F1/team/save-preset", "POST"], ["/api/teams", "POST"], ["/api/teams/t%2F6", "PUT"], ["/api/teams/t%2F6", "DELETE"],
    ]);
    expect(JSON.parse((fetchMock.mock.calls[3]![1] as RequestInit).body as string)).toMatchObject({ note: "edited", members: [{ role: "api", agentId: "pi" }] });
  });
});
