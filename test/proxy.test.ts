import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { RequestStore } from '../src/store/requestStore';
import { createInspectionProxy, type InspectionProxy } from '../src/proxy/server';

async function startUpstream(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.stringify({
        method: req.method,
        path: req.url,
        host: req.headers.host,
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no addr');
  return { server, port: addr.port };
}

function fetchLocal(port: number, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

async function makeProxy(
  upstreamPort: number,
  extra: Partial<Parameters<typeof createInspectionProxy>[0]> = {},
): Promise<{ proxy: InspectionProxy; store: RequestStore }> {
  const store = new RequestStore(50);
  const proxy = await createInspectionProxy({
    tunnelId: 'tun-test',
    target: `http://127.0.0.1:${upstreamPort}`,
    store,
    ...extra,
  });
  return { proxy, store };
}

const open: { proxy: InspectionProxy; upstream: http.Server }[] = [];

afterEach(async () => {
  for (const { proxy, upstream } of open.splice(0)) {
    await proxy.close();
    upstream.close();
  }
});

describe('inspection proxy', () => {
  it('forwards requests and captures both bodies', async () => {
    const upstream = await startUpstream();
    const { proxy, store } = await makeProxy(upstream.port);
    open.push({ proxy, upstream: upstream.server });

    const res = await fetchLocal(proxy.port, '/hello?x=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"hi":"there"}',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { body: string; path: string };
    expect(json.body).toBe('{"hi":"there"}');
    expect(json.path).toBe('/hello?x=1');

    await new Promise((r) => setTimeout(r, 50)); // let end events flush
    const recs = store.list(5);
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    expect(rec.method).toBe('POST');
    expect(rec.path).toBe('/hello');
    expect(rec.query).toEqual({ x: '1' });
    expect(rec.request.body?.text).toBe('{"hi":"there"}');
    expect(rec.response?.statusCode).toBe(200);
    expect(rec.response?.body?.text).toContain('hi');
    expect(rec.response?.body?.text).toContain('there');
    expect(rec.durationMs).not.toBeNull();
  });

  it('rewrites the Host header when asked', async () => {
    const upstream = await startUpstream();
    const { proxy, store } = await makeProxy(upstream.port, { hostHeader: 'myapp.dev:3000' });
    open.push({ proxy, upstream: upstream.server });

    const res = await fetchLocal(proxy.port, '/host-check');
    const json = (await res.json()) as { host: string };
    expect(json.host).toBe('myapp.dev:3000');
    expect(store.list(1)[0].request.headers.host).toContain('127.0.0.1'); // original, pre-rewrite
  });

  it('returns 401 for missing or wrong basic auth', async () => {
    const upstream = await startUpstream();
    const { proxy, store } = await makeProxy(upstream.port, { auth: { user: 'u', pass: 'p' } });
    open.push({ proxy, upstream: upstream.server });

    const noAuth = await fetchLocal(proxy.port, '/');
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toContain('Basic');

    const bad = await fetchLocal(proxy.port, '/', {
      headers: { authorization: `Basic ${Buffer.from('u:wrong').toString('base64')}` },
    });
    expect(bad.status).toBe(401);

    const good = await fetchLocal(proxy.port, '/ok', {
      headers: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` },
    });
    expect(good.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    // 401s are recorded too — three records total.
    expect(store.list(10).length).toBe(3);
  });

  it('returns 502 and records the failure when the upstream is down', async () => {
    const upstream = await startUpstream();
    const { proxy, store } = await makeProxy(upstream.port);
    open.push({ proxy, upstream: upstream.server });
    upstream.server.close(); // kill the upstream

    const res = await fetchLocal(proxy.port, '/dead');
    expect(res.status).toBe(502);
    await new Promise((r) => setTimeout(r, 50));
    const rec = store.list(5)[0];
    expect(rec.error).toBe('upstream_down');
    expect(rec.response?.statusCode).toBe(502);
    // proxy must still be alive for the next test request
    const again = await fetchLocal(proxy.port, '/dead-2');
    expect(again.status).toBe(502);
  });

  it('passes WebSocket upgrades through', async () => {
    // Raw socket server for the upgrade test instead of a ws library:
    const wsServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    wsServer.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    await new Promise<void>((r) => wsServer.listen(0, '127.0.0.1', r));
    const wsAddr = wsServer.address();
    if (wsAddr === null || typeof wsAddr === 'string') throw new Error('no addr');
    const { proxy, store } = await makeProxy(wsAddr.port);
    open.push({ proxy, upstream: wsServer });

    const { client } = await rawUpgrade(proxy.port, '/ws');
    const lines: string[] = [];
    client.on('data', (d: Buffer) => lines.push(d.toString()));
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.join('')).toContain('101 Switching Protocols');

    client.destroy();
    await waitUntil(() => {
      const wsRec = store.list(5).find((r) => r.ws);
      return wsRec?.response !== null && wsRec?.response !== undefined;
    });
    const rec = store.list(5).find((r) => r.ws);
    expect(rec).toBeDefined();
    expect(rec?.response?.statusCode).toBe(101);
    // also: HTTP requests still work after an upgrade (server not wedged)
    const still = await fetchLocal(proxy.port, '/after-ws');
    expect(still.status).toBe(200);
  });
});

async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function rawUpgrade(port: number, path: string): Promise<{ client: net.Socket }> {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => {
      client.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    client.on('error', reject);
    resolve({ client });
  });
}
