import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applyEvent, type ListPullRequestsResponse, type PullRequestRecord, type RunPolicy, type RunSnapshot, type SettingsResponse } from "@baton/protocol";
import { startServer, type BatonServer, type StartServerOptions } from "./api/server.js";
import { FakeDriverRegistry, type FakeScript } from "./driver/fake.js";
import type { ForgeCommand } from "./pull-requests/forge.js";
import type { DesktopNotification } from "./notifications/index.js";
import { exportRun } from "./telemetry/index.js";

const servers: BatonServer[] = [], homes: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const url = "https://github.com/owner/repo/pull/42";
const open = { state: "OPEN", title: "Feature PR", isDraft: false, headRefName: "feature", baseRefName: "main", mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ name: "unit", conclusion: "SUCCESS" }], updatedAt: "2026-11-16T00:00:00Z", comments: [] };
const failure = { ...open, statusCheckRollup: [{ name: "unit", conclusion: "FAILURE", detailsUrl: "https://github.com/owner/repo/actions/runs/123/job/7" }], reviewDecision: "CHANGES_REQUESTED" };
async function until(test: () => boolean): Promise<void> { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw new Error("Timed out"); await delay(5); } }
async function setup(script: FakeScript = (c) => c.text("Done"), options: Partial<StartServerOptions> = {}, config?: unknown) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), "baton-pr-")); if (!homes.includes(home)) homes.push(home);
  if (config) await writeFile(join(home, "config.json"), JSON.stringify(config));
  let now = Date.now(), fixture: unknown = open, error: string | undefined;
  const commands: ForgeCommand[] = [], notices: DesktopNotification[] = [];
  const server = await startServer({ home, port: 0, registry: new FakeDriverRegistry({ root: script, child: script }), notifier: (notice) => { notices.push(notice); }, deliveryDebounceMs: 10,
    pullRequests: { autoPoll: false, clock: () => now, resolveExecutable: async () => "/fixture/gh", runner: async (command) => {
      commands.push(command); if (error) throw new Error(error);
      if (command.args[0] === "auth") return "Logged in";
      if (command.args[0] === "run") return Array.from({ length: 100 }, (_, i) => `log ${i + 1}`).join("\n");
      if (command.args.at(-1) === "reviews,comments") return JSON.stringify({ reviews: [{ author: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "Handle the null case.", url: "https://github.com/owner/repo/pull/42#review" }], comments: [{ author: { login: "user" }, body: "Add coverage.", url: "https://github.com/owner/repo/pull/42#comment" }] });
      return JSON.stringify(fixture);
    } }, ...options });
  servers.push(server);
  const create = async (policy: Partial<RunPolicy> = {}): Promise<RunSnapshot> => server.kernel.createRun({ projectId: (await server.kernel.projects.create({ path: tmpdir() })).id, agent: "root", prompt: "Build feature", policy: { teamApproval: false, ...policy } });
  return { server, create, commands, notices, clock: () => now, advance: (ms: number) => { now += ms; }, fixture: (value: unknown) => { fixture = value; }, error: (value?: string) => { error = value; } };
}
async function request(server: BatonServer, path: string, method = "GET", data?: unknown): Promise<Response> {
  return fetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`, ...(data !== undefined ? { "content-type": "application/json" } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
}
async function api<T>(server: BatonServer, path: string, method = "GET", data?: unknown): Promise<T> { const response = await request(server, path, method, data); if (!response.ok) throw new Error(await response.text()); return await response.json() as T; }
function prPath(pr: PullRequestRecord): string { return `/api/prs/${encodeURIComponent(pr.id)}`; }

describe("PR discovery and persistence", () => {
  it("discovers shell creation, URL artifacts and mentioned links with provenance and priority", async () => {
    const { server, create } = await setup(async (c) => {
      if (c.spec.title === "Artifact") { await c.call("report_result", { status: "success", summary: "PR", artifacts: [{ kind: "url", value: "https://github.com/owner/repo/pull/43" }] }); return; }
      if (c.turn > 1) return;
      c.text(`See ${url}`);
      c.item({ type: "tool_call", name: "shell", callId: "create", status: "completed", detail: { type: "shell", command: "gh pr create --title feature", output: `Created ${url}` } });
      c.item({ type: "tool_call", name: "fetch", callId: "fetch", status: "completed", detail: { type: "fetch", url: "https://example", result: "See https://gitlab.com/team/repo/-/merge_requests/3" } });
      c.text("See also https://forge.example/team/repo/pulls/4");
    });
    const run = await create(); await until(() => server.store.node(run.run.rootNodeId).status === "idle"); await server.pullRequests.settled();
    const created = server.store.snapshot(run.run.id).pullRequests!.find((p) => p.number === 42)!;
    expect(created).toMatchObject({ source: "created", nodeId: run.run.rootNodeId, toolSpanId: `${run.run.rootNodeId}:create`, id: `${run.run.id}:github:owner/repo#42` });
    expect(server.pullRequests.link(run.run.id, url).source).toBe("created");
    await server.kernel.delegate(run.run.rootNodeId, { agent: "child", title: "Artifact", task: "Create PR" });
    await until(() => server.store.snapshot(run.run.id).delegations[0]?.status === "completed"); await server.pullRequests.settled();
    const prs = server.store.snapshot(run.run.id).pullRequests!;
    expect(prs).toHaveLength(4); expect(prs.find((p) => p.number === 43)?.source).toBe("artifact");
    expect(prs.find((p) => p.forge === "gitlab")?.source).toBe("mentioned"); expect(prs.find((p) => p.forge === "other")?.source).toBe("mentioned");
    await server.pullRequests.refresh(created.id);
    const snapshot = server.store.snapshot(run.run.id);
    const replay = server.store.events(run.run.id).reduce(applyEvent, { ...snapshot, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], questions: [], escalations: [], pullRequests: undefined, lastSeq: 0 });
    expect(replay).toEqual(snapshot);
    expect(exportRun(server.store, run.run.id, "md")).toContain("## Pull requests");
    expect(exportRun(server.store, run.run.id, "json")).toContain(created.id); expect(exportRun(server.store, run.run.id, "otlp")).toContain("baton.pull_requests");
  });
  it("honors trackMentioned=false while retaining created URLs", async () => {
    const { server, create } = await setup((c) => {
      c.text(url); c.item({ type: "tool_call", name: "shell", callId: "create", status: "completed", detail: { type: "shell", command: "glab mr create", output: "https://gitlab.com/a/b/-/merge_requests/1" } });
    }, {}, { github: { trackMentioned: false } });
    const run = await create(); await until(() => server.store.node(run.run.rootNodeId).status === "idle"); await server.pullRequests.settled();
    expect(server.store.snapshot(run.run.id).pullRequests).toMatchObject([{ source: "created", forge: "gitlab" }]);
  });
  it("tracks the same PR independently in two runs, unlinks replayably and requires explicit relink", async () => {
    const { server, create } = await setup(), a = await create(), b = await create();
    const first = server.pullRequests.link(a.run.id, url), second = server.pullRequests.link(b.run.id, url);
    expect(first.id).not.toBe(second.id); await server.pullRequests.refresh(first.id); await server.pullRequests.refresh(second.id);
    expect(server.store.list().map((r) => r.openPrCount)).toEqual([1, 1]);
    expect((await server.kernel.projects.summary(a.run.projectId!)).openPrCount).toBe(2);
    await api(server, prPath(first), "DELETE"); expect(server.pullRequests.list()).toHaveLength(1);
    expect(server.store.snapshot(a.run.id).pullRequests![0]?.unlinkedAt).toBeDefined();
    const replay = server.store.events(a.run.id).reduce(applyEvent, { ...server.store.snapshot(a.run.id), pullRequests: undefined, lastSeq: 0 });
    expect(replay.pullRequests).toEqual(server.store.snapshot(a.run.id).pullRequests);
    expect(server.store.list(a.run.projectId).find((r) => r.id === a.run.id)?.openPrCount).toBe(0);
    expect((await request(server, prPath(first) + "/refresh", "POST", {})).status).toBe(400);
    server.store.append(a.run.id, { type: "item", nodeId: a.run.rootNodeId, itemSeq: 999, itemTs: new Date().toISOString(), item: { type: "assistant_message", text: url } });
    await server.pullRequests.settled(); expect(server.store.pullRequest(first.id).unlinkedAt).toBeDefined();
    expect(server.pullRequests.link(a.run.id, url).unlinkedAt).toBeUndefined();
    expect((await request(server, `/api/runs/${a.run.id}/prs`, "POST", { url, nodeId: b.run.rootNodeId })).status).toBe(400);
  });
  it("reloads rows and resumes persisted polling schedule after restart", async () => {
    const fixture = await setup(), { server, create } = fixture, run = await create();
    const pr = server.pullRequests.link(run.run.id, url); await server.pullRequests.refresh(pr.id);
    await server.close(); servers.splice(servers.indexOf(server), 1);
    const restart = await setup(undefined, { home: server.home });
    expect(restart.server.store.pullRequest(pr.id).state).toBe("open");
    await restart.server.pullRequests.pollDue(); expect(restart.commands).toHaveLength(0);
    restart.advance(31000); await restart.server.pullRequests.pollDue(); expect(restart.commands).toHaveLength(1);
  });
});

describe("status polling", () => {
  it("polls single-flight, emits only meaningful changes and backs off with last status retained", async () => {
    const { server, create, commands, error, advance, clock } = await setup(), run = await create(), pr = server.pullRequests.link(run.run.id, url);
    await Promise.all([server.pullRequests.refresh(pr.id), server.pullRequests.refresh(pr.id)]); expect(commands).toHaveLength(1);
    const before = server.store.events(run.run.id).filter((e) => e.type === "pr").length;
    advance(30000); await server.pullRequests.pollDue(); expect(commands).toHaveLength(2);
    expect(server.store.events(run.run.id).filter((e) => e.type === "pr")).toHaveLength(before);
    error("Proxy offline"); await server.pullRequests.refresh(pr.id);
    expect(server.store.pullRequest(pr.id)).toMatchObject({ state: "open", title: "Feature PR", error: "Proxy offline" });
    let previousCalls = commands.length;
    advance(29999); await server.pullRequests.pollDue(); expect(commands).toHaveLength(previousCalls);
    advance(1); await server.pullRequests.pollDue(); expect(commands).toHaveLength(++previousCalls);
    advance(59999); await server.pullRequests.pollDue(); expect(commands).toHaveLength(previousCalls);
    advance(1); await server.pullRequests.pollDue(); expect(commands).toHaveLength(++previousCalls);
    for (let i = 0; i < 6; i++) { advance(600000); await server.pullRequests.pollDue(); }
    const metadata = server.store.db.prepare("SELECT data FROM pr_poll WHERE id=?").get(pr.id)!;
    expect(JSON.parse(String(metadata.data)).nextAt - clock()).toBe(600000);
    error(); await server.pullRequests.refresh(pr.id); expect(server.store.pullRequest(pr.id).error).toBeUndefined();
  });
  it("uses open/draft cadence after five minutes and stops after a terminal confirmation poll", async () => {
    const { server, create, commands, advance, fixture, notices } = await setup(), run = await create(), pr = server.pullRequests.link(run.run.id, url);
    await server.pullRequests.refresh(pr.id); advance(300001); await server.pullRequests.pollDue();
    const count = commands.length; advance(59999); await server.pullRequests.pollDue(); expect(commands).toHaveLength(count);
    fixture({ ...open, isDraft: true }); advance(1); await server.pullRequests.pollDue(); expect(server.store.pullRequest(pr.id).state).toBe("draft");
    advance(119999); await server.pullRequests.pollDue(); expect(commands).toHaveLength(count + 1);
    fixture({ ...open, state: "MERGED", mergedAt: "2026-11-16T01:00:00Z" }); advance(1); await server.pullRequests.pollDue();
    expect(notices.filter((n) => n.body.includes("merged"))).toHaveLength(1);
    advance(60000); await server.pullRequests.pollDue(); const terminalCalls = commands.length;
    advance(600000); await server.pullRequests.pollDue(); expect(commands).toHaveLength(terminalCalls); expect(server.store.list()[0]?.openPrCount).toBe(0);
  });
  it("emits a lastCheckedAt heartbeat every five minutes while suppressing intermediate no-op polls", async () => {
    const { server, create, advance, clock } = await setup(), run = await create(), pr = server.pullRequests.link(run.run.id, url);
    await server.pullRequests.refresh(pr.id);
    const firstCheck = server.store.pullRequest(pr.id).lastCheckedAt, count = server.store.events(run.run.id).filter((e) => e.type === "pr").length;
    advance(299999); await server.pullRequests.refresh(pr.id);
    expect(server.store.pullRequest(pr.id).lastCheckedAt).toBe(firstCheck);
    expect(server.store.events(run.run.id).filter((e) => e.type === "pr")).toHaveLength(count);
    advance(1); await server.pullRequests.refresh(pr.id);
    expect(server.store.pullRequest(pr.id).lastCheckedAt).toBe(new Date(clock()).toISOString());
    expect(server.store.events(run.run.id).filter((e) => e.type === "pr")).toHaveLength(count + 1);
  });
  it("retains unknown for unsupported forges without attempting gh", async () => {
    const { server, create, commands } = await setup(), run = await create();
    const other = server.pullRequests.link(run.run.id, "https://forge.example/a/b/pulls/4"), gitlab = server.pullRequests.link(run.run.id, "https://gitlab.com/a/b/-/merge_requests/5");
    expect((await server.pullRequests.refresh(other.id)).state).toBe("unknown");
    expect((await server.pullRequests.refresh(gitlab.id)).error).toContain("GitLab"); expect(commands).toHaveLength(0);
  });
  it("retains last checked state when gh is missing and cancels an in-flight refresh on unlink", async () => {
    let release = (): void => {}, entered = false;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { server, create, notices } = await setup(undefined, { pullRequests: { autoPoll: false, resolveExecutable: async () => "/fixture/gh", runner: async () => { entered = true; await pending; return JSON.stringify(failure); } } });
    const run = await create({ prFeedback: "auto" }), pr = server.pullRequests.link(run.run.id, url);
    const refreshing = server.pullRequests.refresh(pr.id); await until(() => entered); server.pullRequests.unlink(pr.id); release();
    expect((await refreshing).unlinkedAt).toBeDefined(); expect(notices).toEqual([]); expect(server.store.heldPrompts(run.run.rootNodeId)).toEqual([]);
    const missing = await setup(undefined, { pullRequests: { autoPoll: false, resolveExecutable: async () => undefined } });
    const r = await missing.create(), p = missing.server.pullRequests.link(r.run.id, url);
    expect((await missing.server.pullRequests.refresh(p.id)).error).toContain("gh not found");
  });
});

describe("feedback and settings APIs", () => {
  it("composes failures/log tail/reviews and queues to the creator without steering", async () => {
    const { server, create, fixture } = await setup(async (c) => { if (c.turn === 1) await c.sleep(100000); });
    const run = await create(), child = await server.kernel.delegate(run.run.rootNodeId, { agent: "child", title: "Creator", task: "work" });
    const pr = await api<PullRequestRecord>(server, `/api/runs/${run.run.id}/prs`, "POST", { url, nodeId: child.nodeId });
    fixture(failure); await api(server, prPath(pr) + "/refresh", "POST", {});
    await api(server, prPath(pr) + "/feedback", "POST", { include: ["checks", "reviews"], note: "Fix before merge" });
    const session = (server.kernel.registry as FakeDriverRegistry).get("child")!.sessions[0]!;
    expect(session.steered).toEqual([]); expect(session.prompts).toHaveLength(1);
    const held = server.store.heldPrompts(child.nodeId!)[0]!.text;
    for (const expected of ["unit", "/actions/runs/123/job/7", "log 21\n", "log 100", "Handle the null case.", "Add coverage.", "Fix before merge", '<baton-notice kind="system">']) expect(held).toContain(expected);
    expect(held).not.toContain("log 20\n");
    expect(server.store.pullRequest(pr.id).lastFeedbackAt).toBeDefined();
    expect((await request(server, prPath(pr) + "/feedback", "POST", { include: ["invalid"] })).status).toBe(400);
  });
  it("notifies transitions, auto feedback is rate limited per PR and off suppresses attention", async () => {
    const { server, create, fixture, notices, advance } = await setup(async (c) => { await c.sleep(100000); });
    const run = await create({ prFeedback: "auto" }), pr = server.pullRequests.link(run.run.id, url);
    await server.pullRequests.refresh(pr.id); fixture(failure); await server.pullRequests.refresh(pr.id);
    expect(server.store.heldPrompts(run.run.rootNodeId)).toHaveLength(1); expect(notices).toHaveLength(1);
    fixture(open); await server.pullRequests.refresh(pr.id); fixture(failure); await server.pullRequests.refresh(pr.id);
    expect(server.store.heldPrompts(run.run.rootNodeId)).toHaveLength(1);
    advance(600000); fixture(open); await server.pullRequests.refresh(pr.id); fixture(failure); await server.pullRequests.refresh(pr.id);
    expect(server.store.heldPrompts(run.run.rootNodeId)).toHaveLength(2);
    const off = await create({ prFeedback: "off" }), other = server.pullRequests.link(off.run.id, url), before = notices.length;
    await server.pullRequests.refresh(other.id); expect(notices).toHaveLength(before);
    fixture({ ...open, state: "CLOSED" }); await server.pullRequests.refresh(other.id); expect(notices).toHaveLength(before + 1);
  });
  it("sends manual feedback to the root by default or to an explicitly chosen node", async () => {
    const { server, create } = await setup((c) => c.text("Done")), run = await create();
    await until(() => server.store.node(run.run.rootNodeId).status === "idle");
    const child = await server.kernel.delegate(run.run.rootNodeId, { agent: "child", title: "Worker", task: "x" });
    await until(() => server.store.delegation(child.delegationId).status === "completed");
    const pr = server.pullRequests.link(run.run.id, url);
    await server.pullRequests.feedback(pr.id, { include: ["checks"], note: "For lead" });
    const registry = server.kernel.registry as FakeDriverRegistry;
    expect(registry.get("root")!.sessions[0]!.prompts.some((p) => p.includes("For lead"))).toBe(true);
    await server.pullRequests.feedback(pr.id, { include: ["checks"], nodeId: child.nodeId, note: "For worker" });
    expect(registry.get("child")!.sessions[0]!.prompts.some((p) => p.includes("For worker"))).toBe(true);
    const foreign = await create();
    expect((await request(server, prPath(pr) + "/feedback", "POST", { include: ["checks"], nodeId: foreign.run.rootNodeId })).status).toBe(400);
  });
  it("lists by project/state and returns summaries, settings detection cache, env merge and safe config writes", async () => {
    const { server, create, commands, advance, error } = await setup(undefined, {}, { custom: true, notifications: { desktop: false } });
    const settings = await api<SettingsResponse>(server, "/api/settings"); expect(settings.github).toEqual({ ghFound: true, authenticated: true });
    await api(server, "/api/settings"); expect(commands.filter((c) => c.args[0] === "auth")).toHaveLength(1);
    const saved = await api<SettingsResponse>(server, "/api/settings", "PUT", { github: { ghPath: "/custom/gh", env: { HTTPS_PROXY: "http://127.0.0.1:7890" }, trackMentioned: false } });
    expect(saved.github).toMatchObject({ ghPath: "/custom/gh", ghFound: true, authenticated: true, trackMentioned: false });
    expect(commands.at(-1)).toMatchObject({ timeout: 15000, env: { HTTPS_PROXY: "http://127.0.0.1:7890", GH_PROMPT_DISABLED: "1" } });
    expect((await stat(join(server.home, "config.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(server.home, "config.json"), "utf8"))).toMatchObject({ custom: true, notifications: { desktop: false }, github: { ghPath: "/custom/gh" } });
    advance(300001); error("not logged in"); expect((await api<SettingsResponse>(server, "/api/settings")).github?.authenticated).toBe(false); error();
    expect((await request(server, "/api/settings", "PUT", { github: { env: { BAD: 2 } } })).status).toBe(400);
    expect((await request(server, "/api/settings", "PUT", { github: { trackMentioned: "no" } })).status).toBe(400);
    const run = await create(), pr = server.pullRequests.link(run.run.id, url); await server.pullRequests.refresh(pr.id);
    const prs = await api<ListPullRequestsResponse>(server, `/api/prs?projectId=${run.run.projectId}`); expect(prs).toHaveLength(1); expect(prs[0]?.runTitle).toBe(run.run.title);
    expect(await api(server, "/api/prs?projectId=other&state=all")).toEqual([]);
    expect((await request(server, "/api/prs?state=bad")).status).toBe(400);
    expect((await request(server, `/api/runs/${run.run.id}/prs`, "POST", { url: "https://example.com" })).status).toBe(400);
  });
  it("reports missing gh and auth errors through injected detection", async () => {
    const { server } = await setup(undefined, { pullRequests: { autoPoll: false, resolveExecutable: async () => undefined, runner: async () => { throw new Error("must not run"); } } });
    expect((await api<SettingsResponse>(server, "/api/settings")).github).toEqual({ ghFound: false, authenticated: false });
  });
});
