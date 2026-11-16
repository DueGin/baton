import { posix, win32 } from "node:path";
import type { ListDirsResponse } from "@baton/protocol";

export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const normalized = win32.normalize(path), root = win32.parse(normalized).root;
    return (normalized === root ? root : normalized.replace(/[\\/]+$/, "")).toLowerCase();
  }
  return posix.normalize(path).replace(/\/$/, "") || "/";
}
export function containsPath(base: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? win32 : posix, relative = paths.relative(pathKey(base, platform), pathKey(child, platform));
  return relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}
export function directoryParent(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "win32" && pathKey(path, platform) === pathKey(win32.parse(path).root, platform)) return "";
  const paths = platform === "win32" ? win32 : posix, parent = paths.dirname(path);
  return parent === path ? undefined : parent;
}
/** Windows has a virtual browser root; probe only A–Z, never run a shell. */
export async function windowsRoots(home: string, exists: (path: string) => Promise<boolean>, projects: string[] = []): Promise<ListDirsResponse> {
  const registered = new Set(projects.map((p) => pathKey(p, "win32")));
  const roots = await Promise.all(Array.from({ length: 26 }, async (_, i) => {
    const name = `${String.fromCharCode(65 + i)}:`, path = `${name}\\`;
    return await exists(path) ? { name, path, isGitRepo: false, isProject: registered.has(pathKey(path, "win32")) } : undefined;
  }));
  return { path: "", home, dirs: roots.filter((root) => root !== undefined) };
}
