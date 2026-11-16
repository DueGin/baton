import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CreateProjectRequest, ListDirsResponse, PatchProjectRequest, ProjectRecord, ProjectSummary } from "@baton/protocol";
import type { Store } from "../store/index.js";

export class ProjectError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export type ProjectGit = (path: string, args: string[]) => Promise<string | undefined>;
const git: ProjectGit = (path, args) => new Promise((resolveGit) => {
  execFile("git", ["-C", path, ...args], { timeout: 1000, encoding: "utf8", maxBuffer: 65536, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => resolveGit(error ? undefined : stdout.trim() || undefined));
});
export function expandPath(path: string): string {
  if (typeof path !== "string" || !path.trim()) throw new ProjectError(400, "A directory path is required");
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (!isAbsolute(path)) throw new ProjectError(400, "Directory path must be absolute or start with ~/");
  return resolve(path);
}
async function directory(path: string): Promise<string> {
  const expanded = expandPath(path);
  try { const canonical = await realpath(expanded); if ((await stat(canonical)).isDirectory()) return canonical; }
  catch { /* return the same directory error for files, missing paths and inaccessible paths */ }
  throw new ProjectError(400, "Path must be an existing, accessible directory");
}
async function exists(path: string): Promise<boolean> { try { return (await stat(path)).isDirectory(); } catch { return false; } }
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new ProjectError(400, "Project name must contain 1–200 characters");
  return value.trim();
}
export class Projects {
  private branches = new Map<string, { until: number; value: Promise<string | undefined> }>();
  constructor(readonly store: Store, readonly runGit: ProjectGit = git, readonly clock: () => number = Date.now) {}
  async create(input: CreateProjectRequest): Promise<ProjectRecord> {
    if (input.name !== undefined) name(input.name);
    const path = await directory(input.path), previous = this.store.projectAt(path);
    if (previous) {
      if (!previous.archived) return previous;
      const restored = { ...previous, archived: false, updatedAt: new Date().toISOString() }; this.store.saveProject(restored); return restored;
    }
    const gitRoot = await this.runGit(path, ["rev-parse", "--show-toplevel"]);
    // No await between the final lookup and write: concurrent aliases return one project.
    const old = this.store.projectAt(path), ts = new Date().toISOString();
    if (old) {
      if (!old.archived) return old;
      const next = { ...old, archived: false, updatedAt: ts }; this.store.saveProject(next); return next;
    }
    const project: ProjectRecord = { id: randomUUID(), path, name: input.name !== undefined ? name(input.name) : basename(path) || path, ...(gitRoot ? { gitRoot } : {}), createdAt: ts, updatedAt: ts };
    this.store.saveProject(project); return project;
  }
  patch(id: string, input: PatchProjectRequest): ProjectRecord {
    const old = this.store.project(id);
    if (input.name !== undefined) name(input.name);
    if (input.archived !== undefined && typeof input.archived !== "boolean") throw new ProjectError(400, "archived must be a boolean");
    if (input.archived && this.store.list(id).some((r) => r.status === "active")) throw new ProjectError(409, "Cannot archive a project with active runs");
    const next = { ...old, ...(input.name !== undefined ? { name: name(input.name) } : {}), ...(input.archived !== undefined ? { archived: input.archived } : {}), updatedAt: new Date().toISOString() };
    this.store.saveProject(next); return next;
  }
  async cwd(projectId: string, value?: string): Promise<string> {
    if (typeof projectId !== "string" || !projectId.trim()) throw new ProjectError(400, "projectId is required");
    if (value !== undefined && typeof value !== "string") throw new ProjectError(400, "cwd must be a directory path");
    const project = this.store.project(projectId);
    if (project.archived) throw new ProjectError(400, "Project is archived");
    const path = await directory(value ?? project.path), base = await directory(project.path), child = relative(base, path);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new ProjectError(400, "cwd must be inside the project directory");
    if (this.store.project(projectId).archived) throw new ProjectError(400, "Project is archived");
    return path;
  }
  async summary(id: string): Promise<ProjectSummary> {
    const project = this.store.project(id), runs = this.store.list(id), present = await exists(project.path);
    let cached = this.branches.get(project.path);
    if (present && (!cached || cached.until <= this.clock())) {
      cached = { until: this.clock() + 10000, value: this.runGit(project.path, ["branch", "--show-current"]) }; this.branches.set(project.path, cached);
    }
    const gitBranch = present ? await cached?.value : undefined;
    return { ...project, runCount: runs.length, activeRunCount: runs.filter((r) => r.status === "active").length, pendingTotal: runs.reduce((sum, r) => sum + r.pendingTotal, 0), backgroundCount: runs.reduce((sum, r) => sum + (r.backgroundCount ?? 0), 0), openPrCount: runs.reduce((sum, r) => sum + (r.openPrCount ?? 0), 0), ...(runs.length ? { lastRunAt: runs.map((r) => r.createdAt).sort().at(-1)! } : {}), ...(gitBranch ? { gitBranch } : {}), exists: present };
  }
  async list(archived = false): Promise<ProjectSummary[]> { return Promise.all(this.store.projects().filter((p) => archived || !p.archived).map((p) => this.summary(p.id))); }
  async migrate(): Promise<void> {
    const legacy = this.store.list().filter((r) => !r.projectId);
    const grouped = new Map<string, typeof legacy>();
    for (const run of legacy) { const group = grouped.get(run.cwd) ?? []; group.push(run); grouped.set(run.cwd, group); }
    for (const [cwd, runs] of grouped) {
      let path = expandPath(cwd); try { path = await realpath(path); } catch { /* missing legacy projects stay registered */ }
      let project = this.store.projectAt(path);
      if (!project) {
        const gitRoot = await exists(path) ? await this.runGit(path, ["rev-parse", "--show-toplevel"]) : undefined;
        const ts = new Date().toISOString();
        project = this.store.projectAt(path) ?? { id: randomUUID(), path, name: basename(path) || path, ...(gitRoot ? { gitRoot } : {}), createdAt: ts, updatedAt: ts };
        this.store.saveProject(project);
      }
      for (const run of runs) if (!this.store.snapshot(run.id).run.projectId) this.store.append(run.id, { type: "run.updated", patch: { projectId: project.id } });
    }
  }
  async dirs(value = homedir(), hidden = false): Promise<ListDirsResponse> {
    const path = await directory(value), registered = new Set(this.store.projects().map((p) => p.path));
    const entries = (await readdir(path, { withFileTypes: true })).filter((e) => (hidden || !e.name.startsWith(".")) && (e.isDirectory() || e.isSymbolicLink())).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const dirs: ListDirsResponse["dirs"] = [];
    for (let i = 0; i < entries.length && dirs.length < 500; i += 50) {
      const batch = await Promise.all(entries.slice(i, i + 50).map(async (entry) => {
        const child = join(path, entry.name);
        try {
          if (!(await stat(child)).isDirectory()) return undefined;
          const canonical = await realpath(child);
          let isGitRepo = false; try { await lstat(join(child, ".git")); isGitRepo = true; } catch { /* no git marker */ }
          return { name: entry.name, path: canonical, isGitRepo, isProject: registered.has(canonical) };
        } catch { return undefined; }
      }));
      dirs.push(...batch.filter((d) => d !== undefined).slice(0, 500 - dirs.length));
    }
    const parent = dirname(path);
    return { path, ...(parent !== path ? { parent } : {}), home: homedir(), dirs };
  }
}
