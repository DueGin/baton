import type { BackgroundProcess, RunSnapshot } from "@baton/protocol";
export const backgroundActive = (process: BackgroundProcess): boolean => !process.dismissed && process.status !== "exited";
export function backgroundSummary(snapshot: Pick<RunSnapshot, "backgroundProcesses">, nodeId?: string) {
  const visible = (snapshot.backgroundProcesses ?? []).filter(process => !process.dismissed && (!nodeId || process.nodeId === nodeId)).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  const active = visible.filter(backgroundActive); const exited = visible.filter(process => process.status === "exited");
  return { active, exited, count: active.length, hasPorts: active.some(process => process.ports.length > 0) };
}
export const attributionDescriptions: Record<BackgroundProcess["attribution"], string> = {
  tree: "进程树归属：祖先链可追溯到此节点的 agent 进程。",
  group: "进程组归属：与此节点曾启动的工具 shell 属于同一进程组，进程被收养后仍可追溯。",
  inferred: "推断归属：孤儿进程在此节点 shell 工具调用期间启动，且工作目录位于节点目录内；可能存在误判。",
};
export const backgroundStatusLabels = { running: "运行中", stopping: "停止中…", exited: "已退出" };
export function backgroundPorts(ports: number[]): number[] { return [...new Set(ports.filter(port => Number.isInteger(port) && port > 0 && port <= 65535))].sort((a, b) => a - b); }
