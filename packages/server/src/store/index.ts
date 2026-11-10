import { DatabaseSync } from "node:sqlite";
import { applyEvent, type ItemRecord, type RunEvent, type RunEventEnvelope, type RunSnapshot, type RunSummary } from "@baton/protocol";

const tables = ["nodes", "delegations", "turns", "tool_spans", "permissions"] as const;
export class Store {
  readonly db: DatabaseSync;
  private listeners = new Set<(event: RunEventEnvelope) => void>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id, seq));
      CREATE TABLE IF NOT EXISTS items (node_id TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(node_id, seq));`);
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_run ON ${table}(run_id);`);
  }
  subscribe(listener: (event: RunEventEnvelope) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  snapshot(id: string): RunSnapshot {
    const row = this.db.prepare("SELECT data, seq FROM runs WHERE id=?").get(id);
    if (!row) throw new Error(`Run not found: ${id}`);
    const read = <T>(table: string): T[] => this.db.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid`).all(id).map((r) => JSON.parse(String(r.data)) as T);
    return { run: JSON.parse(String(row.data)) as RunSnapshot["run"], lastSeq: Number(row.seq), nodes: read("nodes"), delegations: read("delegations"), turns: read("turns"), toolSpans: read("tool_spans"), permissions: read("permissions") };
  }
  append(runId: string, payload: RunEvent): RunEventEnvelope {
    this.db.exec("BEGIN IMMEDIATE");
    let event: RunEventEnvelope;
    try {
      const current = payload.type === "run.created" && !this.db.prepare("SELECT id FROM runs WHERE id=?").get(runId) ? { run: payload.run, nodes: [], delegations: [], turns: [], toolSpans: [], permissions: [], lastSeq: 0 } : this.snapshot(runId);
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
        case "permission": upsert("permissions", event.permission); break;
        case "item": {
          const localSeq = event.itemSeq;
          const item: ItemRecord = { nodeId: event.nodeId, seq: localSeq, turnId: event.turnId, ts: event.ts, item: event.item };
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
    const { seq, ...rest } = item;
    return this.append(runId, { type: "item", ...rest, itemSeq: seq });
  }
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
  list(): RunSummary[] {
    return this.db.prepare("SELECT id FROM runs ORDER BY rowid DESC").all().map((r) => {
      const s = this.snapshot(String(r.id));
      return { ...s.run, rootAgentId: s.nodes.find((n) => n.id === s.run.rootNodeId)?.agentId ?? "", agents: [...new Set(s.nodes.map((n) => n.agentId))], nodeCount: s.nodes.length, activeNodeCount: s.nodes.filter((n) => ["starting", "running", "waiting_permission"].includes(n.status)).length, pendingPermissions: s.permissions.filter((p) => p.status === "pending").length };
    });
  }
  close(): void { this.listeners.clear(); this.db.close(); }
}
