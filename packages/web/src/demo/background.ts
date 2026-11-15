import type { BackgroundProcess, RunSnapshot } from "@baton/protocol";
export function demoBackground(snapshot: RunSnapshot, now: number): BackgroundProcess[] {
  const node = snapshot.nodes.find(node => node.agentId === "codex") ?? snapshot.nodes[0]!;
  const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();
  const common = { runId: snapshot.run.id, nodeId: node.id, ppid: 4100, pgid: 4200, cwd: node.cwd, lastSeenAt: at(0) };
  return [
    { ...common, id: `4201:${Math.floor(now / 1000) - 240}`, pid: 4201, command: "npm run dev", ports: [5173], children: [{ pid: 4202, command: "node node_modules/vite/bin/vite.js --host 127.0.0.1", ports: [5173] }], startedAt: at(-240), status: "running", attribution: "tree" },
    { ...common, nodeId: snapshot.run.rootNodeId, ppid: 1, pgid: 4300, id: `4301:${Math.floor(now / 1000) - 180}`, pid: 4301, command: "nohup python -m http.server 8000", ports: [8000], children: [], startedAt: at(-180), status: "running", attribution: "inferred" },
    { ...common, id: `4401:${Math.floor(now / 1000) - 360}`, pid: 4401, pgid: 4400, command: "node scripts/watch.mjs", ports: [], children: [], startedAt: at(-360), status: "exited", exitedAt: at(-60), stoppedBy: "human", attribution: "group" },
  ];
}
