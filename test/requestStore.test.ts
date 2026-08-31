import { describe, expect, it } from 'vitest';
import { RequestStore } from '../src/store/requestStore';
import type { RequestRecord } from '../src/store/types';

function baseRec(partial: Partial<RequestRecord> = {}): Omit<RequestRecord, 'id'> {
  return {
    tunnelId: 'tun-1',
    timestamp: Date.now(),
    method: 'GET',
    path: '/',
    query: {},
    httpVersion: '1.1',
    ws: false,
    request: { headers: {}, body: null },
    response: null,
    durationMs: null,
    ...partial,
  };
}

describe('RequestStore', () => {
  it('assigns monotonic ids and retrieves records', () => {
    const s = new RequestStore();
    const a = s.create(baseRec());
    const b = s.create(baseRec());
    expect(a.id).toBe('req-000001');
    expect(b.id).toBe('req-000002');
    expect(s.get(a.id)?.path).toBe('/');
  });

  it('evicts oldest records past the cap', () => {
    const s = new RequestStore(3);
    const a = s.create(baseRec({ path: '/a' }));
    s.create(baseRec({ path: '/b' }));
    s.create(baseRec({ path: '/c' }));
    s.create(baseRec({ path: '/d' }));
    expect(s.get(a.id)).toBeUndefined();
    expect(s.list(10).map((r) => r.path)).toEqual(['/d', '/c', '/b']);
  });

  it('lists newest first with a limit', () => {
    const s = new RequestStore();
    s.create(baseRec({ path: '/1' }));
    s.create(baseRec({ path: '/2' }));
    expect(s.list(1).map((r) => r.path)).toEqual(['/2']);
  });

  it('updates records in place', () => {
    const s = new RequestStore();
    const a = s.create(baseRec());
    s.update(a.id, {
      response: { statusCode: 200, statusMessage: 'OK', headers: {}, body: null },
      durationMs: 12,
    });
    expect(s.get(a.id)?.response?.statusCode).toBe(200);
    expect(s.get(a.id)?.durationMs).toBe(12);
  });

  it('emits start and end phases, and unsubscribes', () => {
    const s = new RequestStore();
    const events: string[] = [];
    const unsub = s.subscribe((rec, phase) => events.push(`${phase}:${rec.path}`));
    const a = s.create(baseRec({ path: '/evt' }));
    s.update(a.id, { response: { statusCode: 204, statusMessage: 'No Content', headers: {}, body: null } });
    expect(events).toEqual(['start:/evt', 'end:/evt']);
    unsub();
    s.create(baseRec({ path: '/after' }));
    expect(events).toHaveLength(2);
  });
});
