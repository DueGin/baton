import type { BackgroundProcess, RunSnapshot } from "@baton/protocol";
export function demoBackground(snapshot: RunSnapshot, now: number): BackgroundProcess[] {
  const node = snapshot.nodes.find(node => node.agentId === "codex") ?? snapshot.nodes[0]!;
  const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();
  const common = { runId: snapshot.run.id, nodeId: node.id, ppid: 4100, pgid: 4200, cwd: node.cwd, lastSeenAt: at(0) };
  const exited = (pid: number, command: string, start: number, end: number, ports: number[] = []): BackgroundProcess => ({
    ...common, id: `${pid}:${Math.floor(now / 1000) + start}`, pid, pgid: pid, command, ports, children: [],
    startedAt: at(start), lastSeenAt: at(end), exitedAt: at(end), status: "exited", attribution: "group",
  });
  return [
    { ...common, id: `4201:${Math.floor(now / 1000) - 240}`, pid: 4201, command: "npm run dev", ports: [5173], children: [{ pid: 4202, command: "node node_modules/vite/bin/vite.js --host 127.0.0.1", ports: [5173] }], startedAt: at(-240), status: "running", attribution: "tree" },
    { ...common, nodeId: snapshot.run.rootNodeId, ppid: 1, pgid: 4300, id: `4301:${Math.floor(now / 1000) - 180}`, pid: 4301, command: "nohup python -m http.server 8000", ports: [8000], children: [], startedAt: at(-180), status: "running", attribution: "inferred" },
    { ...exited(4401, "node scripts/watch.mjs", -360, -60), stoppedBy: "human" },
    exited(4411, "go test -tags=integration ./...", -7260, -7200, [55190]),
    exited(4422, "go test -tags=integration ./...", -645, -410, [55215]),
    exited(4433, "go test -tags=integration ./...", -260, -30, [55218]),
    exited(4444, "go test -tags=unit ./...", -82000, -81725),
  ];
}
