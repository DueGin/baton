#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AgentEntry, CreateRunRequest, ProjectRecord, ProjectSummary, RunSnapshot, RunSummary } from "@baton/protocol";
import { startServer } from "../index.js";
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  home: { type: "string" }, port: { type: "string" }, fake: { type: "boolean" }, refresh: { type: "boolean" }, project: { type: "string" }, cwd: { type: "string" }, model: { type: "string" }, mode: { type: "string" }, "auto-approve": { type: "boolean" }, follow: { type: "boolean" }, format: { type: "string" }, output: { type: "string", short: "o" }, help: { type: "boolean", short: "h" },
} });
const home = resolve(values.home ?? process.env.BATON_HOME ?? join(homedir(), ".baton"));
async function main(): Promise<void> {
  const command = positionals[0];
  if (values.help || !command) {
    console.log("baton serve [--port 7433] [--home DIR] [--fake]\nbaton agents [--refresh]\nbaton projects\nbaton projects add <path>\nbaton runs [--project ID|PATH]\nbaton run <agent> <prompt> --project ID|PATH [--cwd DIR] [--model ID] [--mode ID] [--auto-approve] [--follow]\nbaton export <runId> --format json|md|otlp [-o FILE]"); return;
  }
  if (command === "serve") {
    const port = values.port === undefined ? 7433 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
    const daemon = await startServer({ home, port, fake: values.fake });
    console.log(`baton listening at ${daemon.url}/#token=${daemon.token}`);
    let closing = false;
    const close = (): void => { if (!closing) { closing = true; void daemon.close().then(() => { process.exitCode = 0; }).catch((error: unknown) => { console.error(error); process.exitCode = 1; }); } };
    process.once("SIGINT", close); process.once("SIGTERM", close); return;
  }
  const token = (await readFile(join(home, "token"), "utf8")).trim();
  let url = `http://127.0.0.1:${values.port ?? "7433"}`;
  if (!values.port) { try { const info = JSON.parse(await readFile(join(home, "daemon.json"), "utf8")) as { url: string }; url = info.url; } catch { /* default endpoint */ } }
  const request = async <T>(path: string, method = "GET", input?: unknown): Promise<T> => {
    const response = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, ...(input === undefined ? {} : { "content-type": "application/json" }) }, body: input === undefined ? undefined : JSON.stringify(input) });
    if (!response.ok) throw new Error(await response.text()); return await response.json() as T;
  };
  const projectPath = (path: string): string => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
  const selectProject = async (value: string): Promise<ProjectRecord> => {
    const projects = await request<ProjectSummary[]>("/api/projects?archived=1");
    const registered = projects.find((p) => p.id === value);
    if (registered) return registered;
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`Project not found: ${value}`);
    return request<ProjectRecord>("/api/projects", "POST", { path: projectPath(value) });
  };
  if (command === "projects") {
    if (positionals[1] === "add") {
      const path = positionals[2]; if (!path) throw new Error("Usage: baton projects add <path>");
      const project = await request<ProjectRecord>("/api/projects", "POST", { path: projectPath(path) });
      console.log(`${project.id}  ${project.name}  ${project.path}`); return;
    }
    if (positionals[1]) throw new Error("Usage: baton projects [add <path>]");
    for (const p of await request<ProjectSummary[]>("/api/projects")) console.log(`${p.id}  ${p.name}  ${p.path}  ${p.runCount} runs${p.gitBranch ? `  ${p.gitBranch}` : ""}${p.exists ? "" : "  (missing)"}`);
    return;
  }
  if (command === "agents") {
    const agents = await request<AgentEntry[]>(values.refresh ? "/api/agents/refresh" : "/api/agents", values.refresh ? "POST" : "GET", values.refresh ? {} : undefined);
    for (const a of agents) console.log(`${a.id.padEnd(18)} ${a.status.padEnd(12)} ${a.label}${a.diagnostic ? ` — ${a.diagnostic}` : ""}`); return;
  }
  if (command === "runs") { const selected = values.project ? await selectProject(values.project) : undefined; for (const r of await request<RunSummary[]>(`/api/runs${selected ? `?projectId=${encodeURIComponent(selected.id)}` : ""}`)) console.log(`${r.id}  ${r.status.padEnd(12)} ${r.nodeCount} nodes  ${r.title}`); return; }
  if (command === "run") {
    const agent = positionals[1], prompt = positionals.slice(2).join(" "); if (!agent || !prompt) throw new Error("Usage: baton run <agent> <prompt>");
    if (!values.project) throw new Error("--project <id|path> is required to start a run");
    const project = await selectProject(values.project);
    const input: CreateRunRequest = { agent, prompt, projectId: project.id, ...(values.cwd ? { cwd: projectPath(values.cwd) } : {}), model: values.model, modeId: values.mode, policy: { autoApprove: values["auto-approve"] ?? false } };
    const s = await request<RunSnapshot>("/api/runs", "POST", input);
    console.log(`Run ${s.run.id}`);
    if (!values.follow) return;
    const render = async (): Promise<void> => {
      const current = await request<RunSnapshot>(`/api/runs/${s.run.id}`);
      const walk = (parent: string | null, depth: number): void => {
        for (const n of current.nodes.filter((n) => n.parentNodeId === parent)) { console.log(`${"  ".repeat(depth)}${depth ? "└ " : ""}[${n.status}] ${n.agentId}: ${n.title}${n.activity ? ` · ${n.activity}` : ""}`); walk(n.id, depth + 1); }
      }; console.log(`\n${new Date().toLocaleTimeString()} · ${current.run.status}`); walk(null, 0);
    };
    await render();
    const controller = new AbortController(); process.once("SIGINT", () => controller.abort());
    try {
      const stream = await fetch(`${url}/api/runs/${s.run.id}/events?after=${s.lastSeq}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
      if (!stream.ok || !stream.body) throw new Error("Unable to follow events");
      let lastRendered = 0;
      for await (const _chunk of stream.body) { if (Date.now() - lastRendered > 250) { await render(); lastRendered = Date.now(); } }
    } catch (error) { if (!controller.signal.aborted) throw error; } return;
  }
  if (command === "export") {
    const id = positionals[1], format = values.format ?? "json"; if (!id || !["json", "md", "otlp"].includes(format)) throw new Error("Usage: baton export <runId> --format json|md|otlp [-o FILE]");
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(id)}/export?format=${format}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(await response.text());
    const contents = await response.text(); if (values.output) await writeFile(resolve(values.output), contents); else console.log(contents); return;
  }
  throw new Error(`Unknown command: ${command}`);
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
