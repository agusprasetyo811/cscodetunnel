import type { RequestRecord } from './types';

// In-memory ring buffer of captured requests. Bounded: bodies are capped by
// the proxy (256KB default), and the record count is capped by `max`.
// Memory envelope: max × 2 × captureLimit in the worst case — the dashboard
// list endpoint strips bodies, only the detail endpoint serves them.

export class RequestStore {
  private records = new Map<string, RequestRecord>();
  private order: string[] = [];
  private seq = 0;
  private subs = new Set<(rec: RequestRecord, phase: 'start' | 'end') => void>();

  constructor(private max = 1000) {}

  create(rec: Omit<RequestRecord, 'id'>): RequestRecord {
    const full: RequestRecord = { ...rec, id: `req-${String(++this.seq).padStart(6, '0')}` };
    this.records.set(full.id, full);
    this.order.push(full.id);
    while (this.order.length > this.max) {
      const evicted = this.order.shift()!;
      this.records.delete(evicted);
    }
    this.emit(full, 'start');
    return full;
  }

  update(id: string, patch: Partial<RequestRecord>): void {
    const rec = this.records.get(id);
    if (!rec) return;
    Object.assign(rec, patch);
    if (patch.response) this.emit(rec, 'end');
  }

  get(id: string): RequestRecord | undefined {
    return this.records.get(id);
  }

  /** Newest first. */
  list(limit = 100): RequestRecord[] {
    return this.order
      .slice(-limit)
      .reverse()
      .map((id) => this.records.get(id)!)
      .filter(Boolean);
  }

  subscribe(fn: (rec: RequestRecord, phase: 'start' | 'end') => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(rec: RequestRecord, phase: 'start' | 'end'): void {
    for (const fn of this.subs) fn(rec, phase);
  }
}
