import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FakeDriverRegistry } from "../driver/fake.js";
import { startServer, type BatonServer } from "./server.js";

let temp: string, cwd: string, server: BatonServer;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "baton-completion-api-"));
  cwd = join(temp, "work"); await mkdir(cwd);
  const registry = new FakeDriverRegistry({ root: { script: () => {}, sessionCommands: async () => [{ name: "/live" }], scanCommands: async () => [{ name: "scan" }] } });
  server = await startServer({ home: join(temp, "home"), port: 0, registry, fileCheckpoints: false, notifier: () => {} });
});
afterEach(async () => { await server?.close(); await rm(temp, { recursive: true, force: true }); });
const get = (path: string, params: Record<string, string> = {}, auth = true) => fetch(`${server.url}/api/${path}?${new URLSearchParams(params)}`, { headers: auth ? { authorization: `Bearer ${server.token}` } : {} });

it("serves scan-only new-run commands and live node commands", async () => {
  const scan = await get("commands", { agentId: "root", cwd });
  expect(scan.status).toBe(200); expect(await scan.json()).toEqual({ commands: [{ name: "scan" }], source: "scan" });
  const project = await server.kernel.projects.create({ path: cwd });
  const { run } = await server.kernel.createRun({ projectId: project.id, agent: "root", prompt: "start", title: "Test" });
  const live = await get("commands", { nodeId: run.rootNodeId });
  expect(live.status).toBe(200); expect(await live.json()).toEqual({ commands: [{ name: "live" }], source: "session" });
});

it("authenticates completion requests and distinguishes invalid inputs from unknown nodes", async () => {
  for (const path of ["commands", "files/search"]) expect((await get(path, {}, false)).status).toBe(401);
  expect((await get("commands", { nodeId: "missing" })).status).toBe(404);
  for (const params of [{}, { agentId: "root" }, { cwd }, { agentId: "root", cwd: "." }]) expect((await get("commands", params)).status).toBe(400);
  await writeFile(join(cwd, "file"), "");
  for (const bad of ["", "relative", join(temp, "missing"), join(cwd, "file")]) expect((await get("files/search", { cwd: bad })).status).toBe(400);
  for (const limit of ["0", "-1", "2.5", "NaN"]) expect((await get("files/search", { cwd, limit })).status).toBe(400);
});

it("serves ranked relative files and directories with truncation", async () => {
  await mkdir(join(cwd, "docs")); await writeFile(join(cwd, "docs", "a b.txt"), ""); await writeFile(join(cwd, "docfile"), "");
  const response = await get("files/search", { cwd, q: "doc", limit: "1" });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ cwd, truncated: true, files: [{ path: "docs/", kind: "dir" }] });
  expect(await (await get("files/search", { cwd, q: "docs/" })).json()).toEqual({ cwd, truncated: false, files: [{ path: "docs/a b.txt", kind: "file" }] });
});
