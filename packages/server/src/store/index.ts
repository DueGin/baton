import { DatabaseSync } from "node:sqlite";
import { applyEvent, isActivityEvent, type AttachmentRecord, type PullRequestRecord, type ProjectRecord, type BackgroundProcess, type ItemRecord, type RunEvent, type RunEventEnvelope, type RunSnapshot, type RunSummary, type TaskRecord, type TeamPreset, type PermissionRule, type InboxItem, type QuestionRecord, type EscalationRecord, type TurnTrigger } from "@baton/protocol";
export interface HeldPrompt { text: string; trigger: TurnTrigger; humanSeq?: number }

const tables = ["nodes", "delegations", "turns", "tool_spans", "permissions", "questions", "escalations", "background_processes", "pull_requests"] as const;
export class Store {
  readonly db: DatabaseSync;
  private listeners = new Set<(event: RunEventEnvelope) => void>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_run ON tasks(json_extract(data, '$.runId'));
      CREATE TABLE IF NOT EXISTS permission_rules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_round_limits (id TEXT PRIMARY KEY, extra INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, run_id TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paused_nodes (node_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS held_prompts (node_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_presets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id, seq));
      CREATE TABLE IF NOT EXISTS items (node_id TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(node_id, seq));
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, data TEXT NOT NULL);`);
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_run ON ${table}(run_id);`);
  }
  subscribe(listener: (event: RunEventEnvelope) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  snapshot(id: string): RunSnapshot {
    const row = this.db.prepare("SELECT data, seq FROM runs WHERE id=?").get(id);
    if (!row) throw new Error(`Run not found: ${id}`);
    const read = <T>(table: string): T[] => this.db.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid`).all(id).map((r) => JSON.parse(String(r.data)) as T);
    let lastEventAt: string | undefined, lastActivityAt: string | undefined;
    for (const entry of this.db.prepare("SELECT data FROM events WHERE run_id=? ORDER BY seq DESC").iterate(id)) {
      const event = JSON.parse(String(entry.data)) as RunEventEnvelope;
      lastEventAt ??= event.ts;
      if (isActivityEvent(event)) { lastActivityAt = event.ts; break; }
    }
    const backgroundProcesses = visibleBackground(read<BackgroundProcess>("background_processes"));
    const pullRequests = read<PullRequestRecord>("pull_requests");
    return { run: JSON.parse(String(row.data)) as RunSnapshot["run"], lastSeq: Number(row.seq), ...(lastEventAt ? { lastEventAt } : {}), ...(lastActivityAt ? { lastActivityAt } : {}), ...(backgroundProcesses.length ? { backgroundProcesses } : {}), ...(pullRequests.length ? { pullRequests } : {}), nodes: read("nodes"), delegations: read("delegations"), turns: read("turns"), toolSpans: read("tool_spans"), permissions: read("permissions"), questions: read("questions"), escalations: read("escalations") };
  }
  append(runId: string, payload: RunEvent): RunEventEnvelope {
    this.db.exec("BEGIN IMMEDIATE");
    let event: RunEventEnvelope;
    try {
      const current = payload.type === "run.created" && !this.db.prepare("SELECT id FROM runs WHERE id=?").get(runId) ? { run: payload.run, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], questions: [], escalations: [], lastSeq: 0 } : this.snapshot(runId);
      event = JSON.parse(JSON.stringify({ ...payload, runId, seq: current.lastSeq + 1, ts: new Date().toISOString() })) as RunEventEnvelope;
      const next = applyEvent(current, event);
      this.db.prepare("INSERT INTO events VALUES (?, ?, ?)").run(runId, event.seq, JSON.stringify(event));
      this.db.prepare("INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, seq=excluded.seq").run(runId, JSON.stringify(next.run), event.seq);
      const upsert = (table: string, value: { id: string }): void => {
        this.db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id, runId, JSON.stringify(value));
      };
      switch (event.type) {
        case "node.created": upsert("nodes", event.node); break;
        case "node.updated": { const id = event.nodeId; upsert("nodes", next.nodes.find((n) => n.id === id)!); break; }
        case "delegation.created": upsert("delegations", event.delegation); break;
        case "delegation.updated": { const id = event.delegationId; upsert("delegations", next.delegations.find((d) => d.id === id)!); break; }
        case "turn.started": upsert("turns", event.turn); break;
        case "turn.updated": { const id = event.turnId; upsert("turns", next.turns.find((t) => t.id === id)!); break; }
        case "tool.span": upsert("tool_spans", event.span); break;
        case "question": upsert("questions", event.question); break;
        case "escalation": upsert("escalations", event.escalation); break;
        case "permission": upsert("permissions", event.permission); break;
        case "background": upsert("background_processes", event.process); break;
        case "pr": upsert("pull_requests", event.pr); break;
        case "item": {
          const localSeq = event.itemSeq;
          const item: ItemRecord = { nodeId: event.nodeId, seq: localSeq, turnId: event.turnId, ts: event.itemTs, item: event.item, ...(event.rolledBack ? { rolledBack: true } : {}) };
          this.db.prepare("INSERT INTO items VALUES (?, ?, ?, ?) ON CONFLICT(node_id, seq) DO UPDATE SET data=excluded.data").run(event.nodeId, localSeq, runId, JSON.stringify(item));
          break;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    for (const listener of this.listeners) { try { listener(event); } catch { /* observers cannot roll back committed events */ } }
    return event;
  }
  appendItem(runId: string, item: ItemRecord): RunEventEnvelope {
    const { seq, ts, ...rest } = item;
    return this.append(runId, { type: "item", ...rest, itemSeq: seq, itemTs: ts });
  }
  rememberPausedNode(runId: string, nodeId: string): void { this.db.prepare("INSERT OR IGNORE INTO paused_nodes VALUES (?, ?)").run(nodeId, runId); }
  pausedNodes(runId: string): string[] { return this.db.prepare("SELECT node_id FROM paused_nodes WHERE run_id=? ORDER BY rowid").all(runId).map((row) => String(row.node_id)); }
  forgetPausedNode(nodeId: string): void { this.db.prepare("DELETE FROM paused_nodes WHERE node_id=?").run(nodeId); }
  holdPrompts(nodeId: string, prompts: HeldPrompt[]): void { this.db.prepare("INSERT INTO held_prompts VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET data=excluded.data").run(nodeId, JSON.stringify(prompts)); }
  heldPrompts(nodeId: string): HeldPrompt[] { const row = this.db.prepare("SELECT data FROM held_prompts WHERE node_id=?").get(nodeId); return row ? JSON.parse(String(row.data)) as HeldPrompt[] : []; }
  clearHeldPrompts(nodeId: string): void { this.db.prepare("DELETE FROM held_prompts WHERE node_id=?").run(nodeId); }
  events(runId: string, after = 0): RunEventEnvelope[] {
    return this.db.prepare("SELECT data FROM events WHERE run_id=? AND seq>? ORDER BY seq").all(runId, after).map((r) => JSON.parse(String(r.data)) as RunEventEnvelope);
  }
  items(nodeId: string, after = 0): ItemRecord[] {
    return this.db.prepare("SELECT data FROM items WHERE node_id=? AND seq>? ORDER BY seq").all(nodeId, after).map((r) => JSON.parse(String(r.data)) as ItemRecord);
  }
  node(id: string): RunSnapshot["nodes"][number] {
    const row = this.db.prepare("SELECT data FROM nodes WHERE id=?").get(id);
    if (!row) throw new Error(`Node not found: ${id}`); return JSON.parse(String(row.data)) as RunSnapshot["nodes"][number];
  }
  delegation(id: string): RunSnapshot["delegations"][number] {
    const row = this.db.prepare("SELECT data FROM delegations WHERE id=?").get(id);
    if (!row) throw new Error(`Delegation not found: ${id}`); return JSON.parse(String(row.data)) as RunSnapshot["delegations"][number];
  }
  list(projectId?: string): RunSummary[] {
    const rows = projectId === undefined ? this.db.prepare("SELECT id FROM runs ORDER BY rowid DESC").all() : this.db.prepare("SELECT id FROM runs WHERE json_extract(data, '$.projectId')=? ORDER BY rowid DESC").all(projectId);
    return rows.map((row) => this.summarizeRun(this.snapshot(String(row.id))));
  }
  runSummary(id: string): RunSummary | undefined {
    return this.db.prepare("SELECT 1 FROM runs WHERE id=?").get(id) ? this.summarizeRun(this.snapshot(id)) : undefined;
  }
  private summarizeRun(snapshot: RunSnapshot): RunSummary {
    const { run, nodes, permissions, backgroundProcesses, pullRequests, lastEventAt, lastActivityAt } = snapshot;
    const root = nodes.find((node) => node.id === run.rootNodeId);
    const ordered = root ? [root, ...nodes.filter((node) => node !== root)] : nodes;
    const models: NonNullable<RunSummary["models"]> = [], seen = new Set<string>();
    for (const { agentId, model } of ordered) {
      const key = JSON.stringify([agentId, model]);
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(model === undefined ? { agentId } : { agentId, model });
    }
    return { ...run, ...(lastEventAt ? { lastEventAt } : {}), ...(lastActivityAt ? { lastActivityAt } : {}), rootAgentId: root?.agentId ?? "", models, agents: [...new Set(nodes.map((node) => node.agentId))], nodeCount: nodes.length, activeNodeCount: run.status === "paused" ? 0 : nodes.filter((node) => ["starting", "running", "waiting_permission"].includes(node.status)).length, pendingPermissions: permissions.filter((permission) => permission.status === "pending").length, pendingTotal: this.inboxFor(snapshot).length, backgroundCount: backgroundCount(backgroundProcesses), openPrCount: (pullRequests ?? []).filter((pr) => !pr.unlinkedAt && ["open", "draft"].includes(pr.state)).length };
  }
  private inboxFor(s: RunSnapshot): InboxItem[] {
    const common = { runId: s.run.id, runTitle: s.run.title };
    return [
      ...s.permissions.filter((p) => p.status === "pending").map((permission): InboxItem => ({ ...common, kind: "permission", permission })),
      ...(s.run.team?.proposals ?? []).filter((p) => p.status === "pending").map((proposal): InboxItem => ({ ...common, kind: "proposal", proposal })),
      ...s.questions.filter((q) => q.status === "pending").map((question): InboxItem => ({ ...common, kind: "question", question })),
      ...s.escalations.filter((e) => e.status === "pending").map((escalation): InboxItem => ({ ...common, kind: "escalation", escalation })),
    ];
  }
  inbox(): InboxItem[] {
    const timestamp = (item: InboxItem): string => item.kind === "permission" ? item.permission.requestedAt : item.kind === "proposal" ? item.proposal.proposedAt : item.kind === "question" ? item.question.askedAt : item.escalation.createdAt;
    return this.db.prepare("SELECT id FROM runs ORDER BY rowid").all().flatMap((row) => this.inboxFor(this.snapshot(String(row.id)))).sort((a, b) => timestamp(a).localeCompare(timestamp(b)));
  }
  question(id: string): QuestionRecord { const row = this.db.prepare("SELECT data FROM questions WHERE id=?").get(id); if (!row) throw new Error("Question not found"); return JSON.parse(String(row.data)) as QuestionRecord; }
  escalation(id: string): EscalationRecord { const row = this.db.prepare("SELECT data FROM escalations WHERE id=?").get(id); if (!row) throw new Error("Escalation not found"); return JSON.parse(String(row.data)) as EscalationRecord; }
  rules(): PermissionRule[] { return this.db.prepare("SELECT data FROM permission_rules ORDER BY rowid").all().map((row) => JSON.parse(String(row.data)) as PermissionRule); }
  saveRule(rule: PermissionRule): void { this.db.prepare("INSERT INTO permission_rules VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(rule.id, JSON.stringify(rule)); }
  deleteRule(id: string): void { if (this.db.prepare("DELETE FROM permission_rules WHERE id=?").run(id).changes === 0) throw new Error("Permission rule not found"); }
  extraRounds(id: string): number { return Number(this.db.prepare("SELECT extra FROM delegation_round_limits WHERE id=?").get(id)?.extra ?? 0); }
  extendRounds(id: string, extra: number): void { this.db.prepare("INSERT INTO delegation_round_limits VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET extra=extra+excluded.extra").run(id, extra); }
  queueNotice(id: string, nodeId: string, runId: string, text: string): void { this.db.prepare("INSERT INTO notices VALUES (?, ?, ?, ?)").run(id, nodeId, runId, text); }
  notices(nodeId?: string): Array<{ id: string; nodeId: string; text: string }> {
    const rows = nodeId ? this.db.prepare("SELECT * FROM notices WHERE node_id=? ORDER BY rowid").all(nodeId) : this.db.prepare("SELECT * FROM notices ORDER BY rowid").all();
    return rows.map((row) => ({ id: String(row.id), nodeId: String(row.node_id), text: String(row.text) }));
  }
  deleteNotices(ids: string[]): void { for (const id of ids) this.db.prepare("DELETE FROM notices WHERE id=?").run(id); }
  presets(): TeamPreset[] { return this.db.prepare("SELECT data FROM team_presets ORDER BY rowid").all().map((row) => JSON.parse(String(row.data)) as TeamPreset); }
  preset(id: string): TeamPreset {
    const row = this.db.prepare("SELECT data FROM team_presets WHERE id=?").get(id);
    if (!row) throw new Error(`Team preset not found: ${id}`); return JSON.parse(String(row.data)) as TeamPreset;
  }
  savePreset(preset: TeamPreset): void { this.db.prepare("INSERT INTO team_presets VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(preset.id, JSON.stringify(preset)); }
  deletePreset(id: string): void { this.preset(id); this.db.prepare("DELETE FROM team_presets WHERE id=?").run(id); }
  background(): BackgroundProcess[] { return visibleBackground(this.db.prepare("SELECT data FROM background_processes ORDER BY rowid").all().map((r) => JSON.parse(String(r.data)) as BackgroundProcess)); }
  backgroundProcess(id: string): BackgroundProcess { const p = this.background().find((p) => p.id === id); if (!p) throw new Error("Background process not found"); return p; }
  pullRequests(): PullRequestRecord[] { return this.db.prepare("SELECT data FROM pull_requests ORDER BY rowid").all().map((row) => JSON.parse(String(row.data)) as PullRequestRecord); }
  pullRequest(id: string): PullRequestRecord { const row = this.db.prepare("SELECT data FROM pull_requests WHERE id=?").get(id); if (!row) throw new Error("Pull request not found"); return JSON.parse(String(row.data)) as PullRequestRecord; }
  projects(): ProjectRecord[] { return this.db.prepare("SELECT data FROM projects ORDER BY rowid").all().map((r) => JSON.parse(String(r.data)) as ProjectRecord); }
  project(id: string): ProjectRecord { const row = this.db.prepare("SELECT data FROM projects WHERE id=?").get(id); if (!row) throw new Error("Project not found"); return JSON.parse(String(row.data)) as ProjectRecord; }
  projectAt(path: string): ProjectRecord | undefined { const row = this.db.prepare("SELECT data FROM projects WHERE path=?").get(path); return row ? JSON.parse(String(row.data)) as ProjectRecord : undefined; }
  saveProject(project: ProjectRecord): void { this.db.prepare("INSERT INTO projects VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET path=excluded.path, data=excluded.data").run(project.id, project.path, JSON.stringify(project)); }
  tasks(): TaskRecord[] { return this.db.prepare("SELECT data FROM tasks ORDER BY rowid").all().map((row) => JSON.parse(String(row.data)) as TaskRecord); }
  task(id: string): TaskRecord { const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id); if (!row) throw new Error("Task not found"); return JSON.parse(String(row.data)) as TaskRecord; }
  saveTask(task: TaskRecord): void { this.db.prepare("INSERT INTO tasks VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(task.id, JSON.stringify(task)); }
  deleteTask(id: string): void { if (this.db.prepare("DELETE FROM tasks WHERE id=?").run(id).changes === 0) throw new Error("Task not found"); }
  hasTaskForRun(runId: string): boolean { return this.db.prepare("SELECT 1 FROM tasks WHERE json_extract(data, '$.runId')=? LIMIT 1").get(runId) !== undefined; }
  attachment(id: string): AttachmentRecord | undefined { const row = this.db.prepare("SELECT data FROM attachments WHERE id=?").get(id); return row ? JSON.parse(String(row.data)) as AttachmentRecord : undefined; }
  attachmentBySha(sha256: string): AttachmentRecord | undefined { const row = this.db.prepare("SELECT data FROM attachments WHERE sha256=?").get(sha256); return row ? JSON.parse(String(row.data)) as AttachmentRecord : undefined; }
  /** Inserts unless the same content is already stored; returns the stored record. */
  insertAttachment(record: AttachmentRecord, sha256: string): AttachmentRecord {
    this.db.prepare("INSERT INTO attachments VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(record.id, sha256, JSON.stringify(record));
    return this.attachmentBySha(sha256) ?? record;
  }
  close(): void { this.listeners.clear(); this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
}
export function backgroundCount(processes: BackgroundProcess[] = []): number { return processes.filter((p) => p.status !== "exited" && !p.dismissed).length; }
/** A folded parent is historical noise once its surviving child has its own registration.
 * Keep both in events/storage; use the recorded command and lifetime to reject reused PIDs. */
function visibleBackground(processes: BackgroundProcess[]): BackgroundProcess[] {
  return processes.filter((parent) => {
    if (parent.status !== "exited") return true;
    if (processes.some((child) => child.id !== parent.id && child.runId === parent.runId && child.nodeId === parent.nodeId
      && parent.children.some((folded) => folded.pid === child.pid && folded.command === child.command)
      && Date.parse(child.startedAt) >= Date.parse(parent.startedAt)
      && Date.parse(child.startedAt) <= Date.parse(parent.lastSeenAt))) return false;
    return Date.parse(parent.exitedAt ?? parent.lastSeenAt) >= Date.now() - 86400000;
  });
}
