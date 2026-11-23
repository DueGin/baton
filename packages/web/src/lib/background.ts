import type { BackgroundProcess, RunSnapshot } from "@baton/protocol";
import type { BatonClient } from "../api.js";
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

type HistoryGroup = { key: string; records: [BackgroundProcess, ...BackgroundProcess[]] };

export function groupExitedProcesses(exited: BackgroundProcess[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  const exitStamp = (process: BackgroundProcess) => process.exitedAt ? Date.parse(process.exitedAt) : -Infinity;
  for (const process of [...exited].sort((left, right) => exitStamp(right) - exitStamp(left) || left.id.localeCompare(right.id))) {
    const key = JSON.stringify(process.nodeId ? [process.nodeId, process.command] : [null, process.id]);
    const group = groups.get(key);
    if (group) group.records.push(process);
    else groups.set(key, { key, records: [process] });
  }
  return [...groups.values()];
}

export function exitTimeLabel(exitedAt: string | undefined, now: number): string {
  if (!exitedAt) return "—";
  const date = new Date(exitedAt);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date(now).toDateString() ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export async function dismissExitedHistory(ids: string[], client: Pick<BatonClient, "dismissBackground">) {
  const failures: { id: string; reason: string }[] = [];
  for (const id of ids) {
    try { await client.dismissBackground(id, { dismissed: true }); }
    catch (cause) { failures.push({ id, reason: cause instanceof Error ? cause.message : String(cause) }); }
  }
  return failures;
}
