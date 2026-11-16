import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { applyEvent, emptyUsage, type ListDirsResponse, type ProjectRecord, type ProjectSummary, type RunSnapshot } from "@baton/protocol";
import { startServer, type BatonServer, type StartServerOptions } from "./api/server.js";
import { FakeDriverRegistry, type FakeScript } from "./driver/fake.js";
import { Projects } from "./projects/index.js";
import { Store } from "./store/index.js";
import { exportRun } from "./telemetry/index.js";
const servers: BatonServer[] = [], homes: string[] = [];
const exec = promisify(execFile);
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const home of homes.splice(0)) await rm(home, { force: true, recursive: true }); });
async function home(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "baton-projects-")); homes.push(path); return path; }
async function setup(script: FakeScript = (c) => c.text("Done"), options: Partial<StartServerOptions> = {}): Promise<BatonServer> {
  const server = await startServer({ home: await home(), port: 0, registry: new FakeDriverRegistry({ root: script }), notifier: () => {}, background: { platform: "win32" }, ...options }); servers.push(server); return server;
}
async function request(server: BatonServer, path: string, method = "GET", input?: unknown): Promise<Response> {
  return fetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`, ...(input === undefined ? {} : { "content-type": "application/json" }) }, body: input === undefined ? undefined : JSON.stringify(input) });
}
async function api<T>(server: BatonServer, path: string, method = "GET", input?: unknown): Promise<T> {
  const response = await request(server, path, method, input); if (!response.ok) throw new Error(await response.text()); return await response.json() as T;
}
async function until(condition: () => boolean): Promise<void> { const end = Date.now() + 4000; while (!condition()) { if (Date.now() > end) throw new Error("Timed out"); await delay(5); } }

describe("project registry and session boundaries", () => {
  it("creates canonical projects, deduplicates symlink aliases and restores archived projects", async () => {
    const server = await setup(), path = join(server.home, "project"), alias = join(server.home, "alias");
    await mkdir(path); await symlink(path, alias);
    const project = await api<ProjectRecord>(server, "/api/projects", "POST", { path });
    expect(project).toMatchObject({ name: "project", path: await realpath(path) });
    const duplicates = await Promise.all([path, alias].map((path) => api<ProjectRecord>(server, "/api/projects", "POST", { path, name: "Do not rename" })));
    expect(duplicates.map((p) => p.id)).toEqual([project.id, project.id]); expect(server.store.projects()).toHaveLength(1);
    await api(server, `/api/projects/${project.id}`, "PATCH", { archived: true, name: "Renamed" });
    expect(await api(server, "/api/projects")).toEqual([]); expect(await api(server, "/api/projects?archived=1")).toHaveLength(1);
    expect(await api(server, "/api/projects", "POST", { path: alias })).toMatchObject({ id: project.id, archived: false, name: "Renamed" });
    expect((await request(server, "/api/projects", "POST", { path: "relative" })).status).toBe(400);
    const file = join(server.home, "file"); await writeFile(file, "content");
    expect((await request(server, "/api/projects", "POST", { path: file })).status).toBe(400);
    expect((await request(server, "/api/projects", "POST", { path: join(server.home, "missing") })).status).toBe(400);
    expect(await server.kernel.projects.create({ path: "~" })).toMatchObject({ path: await realpath(homedir()), name: basename(homedir()) });
  });

  it("requires projectId, defaults cwd, accepts contained subdirs and rejects symlink escapes", async () => {
    const server = await setup(), path = join(server.home, "project"), subdir = join(path, "src"), outside = join(server.home, "project-other");
    await mkdir(subdir, { recursive: true }); await mkdir(outside); await symlink(outside, join(path, "escape")); await symlink(subdir, join(server.home, "src-alias"));
    const project = await server.kernel.projects.create({ path });
    const missing = await request(server, "/api/runs", "POST", { agent: "root", prompt: "test", cwd: path });
    expect(missing.status).toBe(400); expect(await missing.text()).toContain("projectId is required");
    expect((await request(server, "/api/runs", "POST", { projectId: "missing", agent: "root", prompt: "test" })).status).toBe(404);
    const run = await api<RunSnapshot>(server, "/api/runs", "POST", { projectId: project.id, agent: "root", prompt: "test" });
    expect(run.run).toMatchObject({ projectId: project.id, cwd: await realpath(path) }); expect(run.nodes[0]?.cwd).toBe(await realpath(path));
    const child = await server.kernel.createRun({ projectId: project.id, cwd: join(server.home, "src-alias"), agent: "root", prompt: "subdir" });
    expect(child.run.cwd).toBe(await realpath(subdir));
    for (const cwd of [outside, join(path, "escape"), "relative"]) expect((await request(server, "/api/runs", "POST", { projectId: project.id, cwd, agent: "root", prompt: "bad" })).status).toBe(400);
    await until(() => server.store.list(project.id).every((r) => r.status === "idle"));
    await api(server, `/api/projects/${project.id}`, "PATCH", { archived: true });
    expect((await request(server, "/api/runs", "POST", { projectId: project.id, agent: "root", prompt: "archived" })).status).toBe(400);
  });

  it("rejects archiving active runs with 409 and filters runs by project", async () => {
    const server = await setup(async (c) => { await c.sleep(10000); });
    const one = await server.kernel.projects.create({ path: server.home }), otherPath = join(server.home, "other"); await mkdir(otherPath);
    const two = await server.kernel.projects.create({ path: otherPath });
    const run = await server.kernel.createRun({ projectId: one.id, agent: "root", prompt: "active" });
    await server.kernel.createRun({ projectId: two.id, agent: "root", prompt: "other" });
    expect((await request(server, `/api/projects/${one.id}`, "PATCH", { archived: true })).status).toBe(409);
    expect(await api(server, `/api/runs?projectId=${one.id}`)).toMatchObject([{ id: run.run.id, projectId: one.id }]);
    expect(await api(server, `/api/runs?projectId=${one.id}`)).toHaveLength(1);
    await server.kernel.cancelRun(run.run.id);
    expect(await api(server, `/api/projects/${one.id}`, "PATCH", { archived: true })).toMatchObject({ archived: true });
    expect((await request(server, `/api/projects/${two.id}`, "PATCH", { archived: "yes" })).status).toBe(400);
  });

  it("rechecks project archival after asynchronous agent discovery", async () => {
    const server = await setup(), project = await server.kernel.projects.create({ path: server.home });
    const detect = server.kernel.registry.detect.bind(server.kernel.registry);
    let release: () => void = () => {}, discovering = false;
    server.kernel.registry.detect = async (options) => { discovering = true; await new Promise<void>((resolve) => { release = resolve; }); return detect(options); };
    const creation = server.kernel.createRun({ projectId: project.id, agent: "root", prompt: "racing archive" });
    await until(() => discovering);
    server.kernel.projects.patch(project.id, { archived: true }); release();
    await expect(creation).rejects.toThrow("Project is archived"); expect(server.store.list()).toHaveLength(0);
  });

  it("summarizes pending items, active runs, background entries and exported project metadata", async () => {
    const server = await setup(async (c) => { await c.sleep(10000); }), project = await server.kernel.projects.create({ path: server.home, name: "My Project" });
    const run = await server.kernel.createRun({ projectId: project.id, agent: "root", prompt: "one" });
    const second = await server.kernel.createRun({ projectId: project.id, agent: "root", prompt: "two" });
    await server.kernel.tool(run.run.rootNodeId, "ask_human", { question: "Pick one", blocking: false });
    const process = { id: "99999:1", runId: run.run.id, nodeId: run.run.rootNodeId, pid: 99999, ppid: 1, pgid: 99999, command: "node app", ports: [3000], children: [], startedAt: run.run.createdAt, status: "stopping" as const, attribution: "group" as const, lastSeenAt: run.run.createdAt };
    server.store.append(run.run.id, { type: "background", process });
    expect(await api<ProjectSummary>(server, `/api/projects/${project.id}`)).toMatchObject({ id: project.id, exists: true, runCount: 2, activeRunCount: 2, pendingTotal: 1, backgroundCount: 1, lastRunAt: second.run.createdAt });
    expect(JSON.parse(exportRun(server.store, run.run.id, "json"))).toMatchObject({ project: { name: "My Project", path: project.path } });
    expect(exportRun(server.store, run.run.id, "md")).toContain(`Project: My Project (${project.path})`);
    expect(exportRun(server.store, run.run.id, "otlp")).toContain("baton.project.name");
  });
});

describe("migration, git and directory browser", () => {
  it("migrates legacy runs by canonical cwd, preserves missing directories and is idempotent on startup", async () => {
    const path = await home(), cwd = join(path, "project"), alias = join(path, "alias"), missing = join(path, "gone");
    await mkdir(cwd); await symlink(cwd, alias);
    const store = new Store(join(path, "baton.db")), ts = new Date().toISOString();
    for (const [id, dir] of [["r1", cwd], ["r2", cwd], ["r3", alias], ["r4", missing]]) store.append(id!, { type: "run.created", run: { id: id!, cwd: dir!, title: id!, status: "idle", rootNodeId: `${id}-node`, policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false }, usage: emptyUsage(), createdAt: ts, updatedAt: ts } });
    store.close();
    const server = await setup(undefined, { home: path });
    expect(server.store.projects()).toHaveLength(2);
    expect(new Set(["r1", "r2", "r3"].map((id) => server.store.snapshot(id).run.projectId)).size).toBe(1);
    const gone = server.store.snapshot("r4").run.projectId!;
    expect(await server.kernel.projects.summary(gone)).toMatchObject({ path: missing, exists: false, runCount: 1 });
    const migration = server.store.events("r1").filter((e) => e.type === "run.updated" && e.patch.projectId);
    expect(migration).toHaveLength(1);
    await server.kernel.projects.migrate(); expect(server.store.events("r1").filter((e) => e.type === "run.updated" && e.patch.projectId)).toHaveLength(1);
    const snapshot = server.store.snapshot("r1"); expect(server.store.events("r1").reduce(applyEvent, { ...snapshot, lastSeq: 0 })).toEqual(snapshot);
    await server.close(); servers.splice(servers.indexOf(server), 1);
    const restored = await setup(undefined, { home: path });
    expect(restored.store.projects()).toHaveLength(2); expect(restored.store.events("r1").filter((e) => e.type === "run.updated" && e.patch.projectId)).toHaveLength(1);
  });

  it("detects repository roots and branches with a ten-second branch cache", async () => {
    const server = await setup(), repository = join(server.home, "repo"), subdir = join(repository, "src"); await mkdir(subdir, { recursive: true });
    await exec("git", ["init", "-b", "project-test", repository]);
    const project = await server.kernel.projects.create({ path: subdir }); expect(project.gitRoot).toBe(await realpath(repository));
    expect(await server.kernel.projects.summary(project.id)).toMatchObject({ gitBranch: "project-test" });
    let calls = 0, clock = 0;
    const cached = new Projects(server.store, async () => { calls++; return "cached-branch"; }, () => clock);
    await Promise.all([cached.summary(project.id), cached.summary(project.id)]); expect(calls).toBe(1);
    clock = 9999; await cached.summary(project.id); expect(calls).toBe(1);
    clock = 10000; await cached.summary(project.id); expect(calls).toBe(2);
    await rm(repository, { recursive: true }); expect(await server.kernel.projects.summary(project.id)).toMatchObject({ exists: false });
  });

  it("browses only sorted directories, marks git/project paths, hides dotdirs and caps at 500", async () => {
    const server = await setup(), path = join(server.home, "browser"); await mkdir(path);
    for (const dir of ["zeta", ".hidden", "alpha"]) await mkdir(join(path, dir));
    await writeFile(join(path, "alpha", ".git"), "gitdir: elsewhere"); await writeFile(join(path, "ordinary-file"), "do not read");
    await server.kernel.projects.create({ path: join(path, "alpha") }); await symlink(join(path, "alpha"), join(path, "beta-alias"));
    const list = await api<ListDirsResponse>(server, `/api/fs/dirs?path=${encodeURIComponent(path)}`);
    expect(list).toMatchObject({ path: await realpath(path), parent: await realpath(server.home), home: homedir() });
    expect(list.dirs.map((d) => d.name)).toEqual(["alpha", "beta-alias", "zeta"]);
    expect(list.dirs[0]).toMatchObject({ isGitRepo: true, isProject: true }); expect(list.dirs[1]).toMatchObject({ isProject: true });
    expect((await api<ListDirsResponse>(server, `/api/fs/dirs?path=${encodeURIComponent(path)}&hidden=1`)).dirs.map((d) => d.name)).toEqual([".hidden", "alpha", "beta-alias", "zeta"]);
    expect((await request(server, `/api/fs/dirs?path=${encodeURIComponent(join(path, "ordinary-file"))}`)).status).toBe(400);
    expect((await fetch(`${server.url}/api/fs/dirs?path=${encodeURIComponent(path)}`)).status).toBe(401);
    await Promise.all(Array.from({ length: 505 }, (_, i) => mkdir(join(path, `dir-${String(i).padStart(3, "0")}`))));
    expect((await api<ListDirsResponse>(server, `/api/fs/dirs?path=${encodeURIComponent(path)}`)).dirs).toHaveLength(500);
    expect((await server.kernel.projects.dirs("/")).parent).toBeUndefined();
  });
});

describe("CLI projects and fake demo", () => {
  it("registers project paths, lists projects and starts runs by path or id", async () => {
    const server = await setup();
    const cli = async (...args: string[]): Promise<string> => (await exec(process.execPath, ["--import", "tsx", "packages/server/src/cli/main.ts", ...args, "--home", server.home], { cwd: process.cwd(), env: { ...process.env, BATON_HOME: server.home } })).stdout;
    const added = await cli("projects", "add", server.home), project = server.store.projects()[0]!;
    expect(added).toContain(project.id); expect(await cli("projects")).toContain(project.path);
    expect(await cli("run", "root", "by id", "--project", project.id)).toMatch(/^Run /);
    const autoPath = join(server.home, "automatic"); await mkdir(autoPath);
    const auto = await cli("run", "root", "by path", "--project", autoPath), runId = auto.trim().replace(/^Run /, "");
    expect(server.store.snapshot(runId).run.projectId).toBe(server.store.projectAt(await realpath(autoPath))?.id);
    expect(await cli("runs", "--project", autoPath)).toContain(runId);
    await expect(cli("run", "root", "missing project")).rejects.toThrow(/--project/);
  }, 20000);
  it("registers the fake demo working directory and uses it for a demo run", async () => {
    const server = await setup(undefined, { fake: true, registry: undefined });
    const project = server.store.projects().find((p) => p.name === "Demo project")!;
    expect(project.path).toBe(await realpath(join(server.home, "demo-project")));
    const run = await server.kernel.createRun({ projectId: project.id, agent: "fake-claude", prompt: "solo demo", policy: { mode: "solo" } });
    expect(run.run).toMatchObject({ projectId: project.id, cwd: project.path });
  });
});
