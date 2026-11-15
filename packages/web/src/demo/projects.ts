import type { ListDirsResponse, ProjectRecord } from "@baton/protocol";
const tree: Record<string, string[]> = {
  "/": ["workspace", "tmp"], "/workspace": ["atlas", "notes", "archive", "playground"], "/tmp": ["demo"], "/tmp/demo": ["src"],
  "/workspace/atlas": ["src", "packages", "docs"], "/workspace/atlas/src": ["components", "lib"], "/workspace/atlas/packages": ["web", "server"], "/workspace/atlas/packages/web": ["src"],
  "/workspace/notes": ["research", "drafts"], "/workspace/archive": ["legacy"], "/workspace/playground": [],
};
export function demoPath(input: string): string { const path = input.trim().replace(/^~(?=\/|$)/, "/workspace"); if (!path.startsWith("/")) throw new Error("请填写绝对路径或 ~"); const parts: string[] = []; for (const part of path.split("/")) { if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part); } return `/${parts.join("/")}`; }
export function demoDirs(input: string, projects: ProjectRecord[]): ListDirsResponse {
  const path = demoPath(input); if (!(path in tree) && !Object.entries(tree).some(([parent, names]) => names.some(name => `${parent === "/" ? "" : parent}/${name}` === path))) throw new Error("不是目录或目录不存在");
  return { path, home: "/workspace", ...(path === "/" ? {} : { parent: path.slice(0, path.lastIndexOf("/")) || "/" }), dirs: (tree[path] ?? []).map(name => { const child = `${path === "/" ? "" : path}/${name}`; return { name, path: child, isGitRepo: child === "/workspace/atlas", isProject: projects.some(project => project.path === child) }; }) };
}
export function initialDemoProjects(ts: string): ProjectRecord[] { return [
  { id: "project-atlas", name: "Atlas", path: "/workspace/atlas", gitRoot: "/workspace/atlas", createdAt: ts, updatedAt: ts },
  { id: "project-notes", name: "研究笔记", path: "/workspace/notes", createdAt: ts, updatedAt: ts },
  { id: "project-archive", name: "旧版原型", path: "/workspace/archive", archived: true, createdAt: ts, updatedAt: ts },
]; }
