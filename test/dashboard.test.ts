import { afterEach, describe, expect, it } from 'vitest';
import { TunnelManager } from '../src/tunnel/manager';
import { RequestStore } from '../src/store/requestStore';
import type { RequestRecord } from '../src/store/types';
import { startDashboard, type Dashboard } from '../src/dashboard/server';

let dash: Dashboard | null = null;

async function makeDashboard(): Promise<{ dash: Dashboard; store: RequestStore; manager: TunnelManager }> {
  const store = new RequestStore(20);
  const manager = new TunnelManager({ binProvider: async () => 'cloudflared', log: () => {} });
  // port 0 lets the OS assign a free ephemeral port — avoids Windows
  // reserved/excluded port ranges that surface as EACCES.
  dash = await startDashboard({ port: 0, store, manager, log: () => {} });
  return { dash, store, manager };
}

afterEach(async () => {
  if (dash) {
    await dash.close();
    dash = null;
  }
});

function baseRec(partial: Partial<RequestRecord> = {}): Omit<RequestRecord, 'id'> {
  return {
    tunnelId: 'tun-1',
    timestamp: Date.now(),
    method: 'GET',
    path: '/',
    query: {},
    httpVersion: '1.1',
    ws: false,
    request: { headers: { host: 'x.trycloudflare.com' }, body: null },
    response: null,
    durationMs: null,
    ...partial,
  };
}

const api = (port: number, path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}${path}`, init).then((r) => r.json());

describe('dashboard', () => {
  it('serves health and tunnel lists', async () => {
    const { dash } = await makeDashboard();
    const health = await api(dash.port, '/api/health');
    expect(health.ok).toBe(true);
    const tunnels = await api(dash.port, '/api/tunnels');
    expect(Array.isArray(tunnels)).toBe(true);
  });

  it('serves request metadata in the list and full bodies in detail', async () => {
    const { dash, store } = await makeDashboard();
    const rec = store.create(
      baseRec({
        path: '/secret',
        request: { headers: {}, body: { kind: 'text', text: 'request-body', bytes: 12, truncated: false } },
        response: {
          statusCode: 200,
          statusMessage: 'OK',
          headers: {},
          body: { kind: 'text', text: 'response-body', bytes: 13, truncated: false },
        },
        durationMs: 5,
      }),
    );
    const list = (await api(dash.port, '/api/requests')) as RequestRecord[];
    expect(list[0].id).toBe(rec.id);
    expect(list[0].request.body).toBeNull();
    expect(list[0].response?.body).toBeNull();

    const detail = (await api(dash.port, `/api/requests/${rec.id}`)) as RequestRecord;
    expect(detail.request.body?.text).toBe('request-body');
    expect(detail.response?.body?.text).toBe('response-body');
  });

  it('filters requests by tunnelId', async () => {
    const { dash, store } = await makeDashboard();
    store.create(baseRec({ path: '/a' }));
    store.create(baseRec({ path: '/b', tunnelId: 'tun-2' }));
    const list = (await api(dash.port, '/api/requests?tunnelId=tun-2')) as RequestRecord[];
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe('/b');
  });

  it('404s on unknown tunnel stop/restart/start and unknown request', async () => {
    const { dash } = await makeDashboard();
    const res = await fetch(`http://127.0.0.1:${dash.port}/api/tunnels/nope/stop`, { method: 'POST' });
    expect(res.status).toBe(404);
    const res2 = await fetch(`http://127.0.0.1:${dash.port}/api/tunnels/nope/start`, { method: 'POST' });
    expect(res2.status).toBe(404);
    const res3 = await fetch(`http://127.0.0.1:${dash.port}/api/requests/nope`);
    expect(res3.status).toBe(404);
  });

  it('pushes request events over SSE', async () => {
    const { dash, store } = await makeDashboard();
    const res = await fetch(`http://127.0.0.1:${dash.port}/api/stream`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // drain initial bytes until we've seen at least one event after create
    let buf = '';
    const readUntil = async (pred: (s: string) => boolean, timeoutMs = 4000): Promise<string> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (pred(buf)) return buf;
      }
      throw new Error('SSE event not received');
    };

    store.create(baseRec({ path: '/sse-probe' }));
    const text = await readUntil((s) => s.includes('/sse-probe'));
    expect(text).toContain('event: request');
    expect(text).toContain('/sse-probe');

    reader.cancel().catch(() => {});
  });
});
