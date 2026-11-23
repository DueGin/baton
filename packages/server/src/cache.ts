export class AsyncCache<Value> {
  private entries = new Map<string, { until: number; value: Promise<Value> }>();
  constructor(private ttlMs: number, private capacity: number) {}

  get(key: string, load: () => Promise<Value>): Promise<Value> {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && cached.until > now) return cached.value;
    for (const [name, entry] of this.entries) if (entry.until <= now) this.entries.delete(name);
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    const value = load().catch((error: unknown) => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, { until: now + this.ttlMs, value });
    return value;
  }
}
