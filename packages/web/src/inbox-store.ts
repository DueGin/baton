import type { InboxItem } from "@baton/protocol";
import type { BatonClient } from "./api.js";
import { sortInbox } from "./lib/inbox.js";
import { errorText, type ConnectionState } from "./store.js";

interface InboxState { items: InboxItem[]; connection: ConnectionState; loaded: boolean; error: string | null }
/** Cross-run subscription stays open while navigating all console pages. */
export class InboxStore {
  private state: InboxState = { items: [], connection: "loading", loaded: false, error: null };
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private refreshing: Promise<void> | null = null;
  private dirty = false;
  constructor(private readonly client: BatonClient) {}
  getSnapshot = (): InboxState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<InboxState>): void { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  refresh = (): Promise<void> => {
    this.dirty = true;
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    this.refreshing = (async () => {
      while (this.dirty && generation === this.generation) {
        this.dirty = false;
        try { const items = await this.client.inbox(); if (generation === this.generation) this.update({ items: sortInbox(items), loaded: true, error: null }); }
        catch (error) { if (generation === this.generation) this.update({ loaded: true, error: errorText(error) }); }
      }
    })().finally(() => { if (generation === this.generation) this.refreshing = null; });
    return this.refreshing;
  };
  start(): void { this.stop(); this.connect(0); }
  stop(): void { this.generation++; this.controller?.abort(); clearTimeout(this.retry); this.refreshing = null; this.dirty = false; }
  private connect(attempt: number): void {
    const generation = this.generation;
    this.controller = new AbortController(); const signal = this.controller.signal;
    this.update({ connection: "loading" });
    // Subscribe before fetching; changed during a fetch schedules another snapshot.
    void this.client.inboxEvents(() => { void this.refresh(); }, signal).then(() => {
      if (!signal.aborted) throw new Error("收件箱连接已断开");
    }).catch((error: unknown) => {
      if (signal.aborted || generation !== this.generation) return;
      this.update({ connection: "reconnecting", error: errorText(error) });
      this.retry = setTimeout(() => this.connect(attempt + 1), Math.min(1000 * 2 ** attempt, 15000));
    });
    void this.refresh().then(() => { if (!signal.aborted && generation === this.generation && this.state.connection === "loading") this.update({ connection: "live" }); });
  }
}
