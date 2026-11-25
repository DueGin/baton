import type { CreateRunRequest, ProjectSummary, RunSummary, TeamPresetInput } from "@baton/protocol";
import { runActivityAt } from "./unread.js";
export const currentProjectKey = "baton.currentProject";
export const collapsedProjectsKey = "baton.collapsedProjects";
export type ProjectAgent = TeamPresetInput["lead"];
export function readCurrentProject(storage: Pick<Storage, "getItem">): string | null { try { return storage.getItem(currentProjectKey); } catch { return null; } }
export function saveCurrentProject(storage: Pick<Storage, "setItem">, id: string): void { try { storage.setItem(currentProjectKey, id); } catch { /* Browser storage is optional. */ } }
export function readCollapsedProjects(storage: Pick<Storage, "getItem">): Set<string> {
  try { const value: unknown = JSON.parse(storage.getItem(collapsedProjectsKey) ?? "[]"); return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []); } catch { return new Set(); }
}
export function saveCollapsedProjects(storage: Pick<Storage, "setItem">, ids: Set<string>): void { try { storage.setItem(collapsedProjectsKey, JSON.stringify([...ids])); } catch { /* Browser storage is optional. */ } }
export function readProjectAgent(storage: Pick<Storage, "getItem">, id: string): ProjectAgent | undefined {
  try { const value: unknown = JSON.parse(storage.getItem(`baton.projectAgent.${id}`) ?? "null"); if (typeof value !== "object" || !value || !("agentId" in value) || typeof value.agentId !== "string") return undefined;
    const fields = value as Record<string, unknown>; return { agentId: value.agentId, ...Object.fromEntries(["model", "modeId", "thinking"].flatMap(key => typeof fields[key] === "string" ? [[key, fields[key]]] : [])) };
  } catch { return undefined; }
}
export function saveProjectAgent(storage: Pick<Storage, "setItem">, id: string, agent: ProjectAgent): void { try { storage.setItem(`baton.projectAgent.${id}`, JSON.stringify(agent)); } catch { /* Browser storage is optional. */ } }
export const pathBasename = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1) || "/";
export function subdirectoryPath(projectPath: string, input: string): { cwd?: string; error?: string } {
  if (/[\u0000-\u001f]/.test(input)) return { error: "子目录不能包含控制字符" };
  const value = input.trim(); if (!value || value === ".") return {};
  if (value.startsWith("/") || value.startsWith("~") || /^[a-z]:/i.test(value) || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return { error: "请填写项目内的相对子目录" };
  const parts: string[] = [];
  for (const part of value.split("/")) { if (!part || part === ".") continue; if (part === "..") { if (!parts.length) return { error: "子目录不能越出项目路径" }; parts.pop(); } else parts.push(part); }
  return parts.length ? { cwd: `${projectPath.replace(/\/+$/, "")}/${parts.join("/")}` } : {};
}
export function projectRunPayload(project: ProjectSummary | undefined, subdir: string, body: Omit<CreateRunRequest, "projectId" | "cwd">): CreateRunRequest {
  if (!project || project.archived) throw new Error("请选择未归档的项目");
  if (!project.exists) throw new Error("项目目录不存在，请恢复目录或选择其他项目");
  const result = subdirectoryPath(project.path, subdir); if (result.error) throw new Error(result.error);
  return { ...body, projectId: project.id, ...(result.cwd ? { cwd: result.cwd } : {}) };
}
export function groupProjects(projects: ProjectSummary[], runs: RunSummary[]): Array<{ project: ProjectSummary; runs: RunSummary[] }> {
  return [...projects]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.name.localeCompare(right.name))
    .map(project => ({ project, runs: runs.filter(run => run.projectId === project.id).sort(compareRunActivity) }));
}
export function compareRunActivity(left: RunSummary, right: RunSummary): number {
  return Date.parse(runActivityAt(right)) - Date.parse(runActivityAt(left)) || left.id.localeCompare(right.id);
}
export function liveProjectSummaries(projects: ProjectSummary[], runs: RunSummary[]): ProjectSummary[] {
  return projects.map(project => { const entries = runs.filter(run => run.projectId === project.id); return { ...project, openPrCount: entries.reduce((sum, run) => sum + (run.openPrCount ?? 0), 0), runCount: entries.length, activeRunCount: entries.filter(run => run.status !== "paused" && (run.status === "active" || run.activeNodeCount > 0)).length, pendingTotal: entries.reduce((sum, run) => sum + run.pendingTotal, 0), backgroundCount: entries.reduce((sum, run) => sum + (run.backgroundCount ?? 0), 0), lastRunAt: entries.map(runActivityAt).sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? project.lastRunAt }; });
}
