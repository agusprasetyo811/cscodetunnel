import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import httpProxy from 'http-proxy';
import { RequestStore } from '../store/requestStore';
import type { RequestRecord } from '../store/types';
import { createBodyCollector, type BodyCollector } from './capture';
import { checkBasicAuth, unauthorizedResponse, type BasicAuthCreds } from './basicAuth';
import { parseHostHeader, type HostHeaderPolicy } from './hostHeader';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface InspectionProxyOptions {
  tunnelId: string;
  /** Where to forward, e.g. http://127.0.0.1:3000. Prefer 127.0.0.1 — `localhost` may resolve to IPv6 `::1`. */
  target: string;
  store: RequestStore;
  auth?: BasicAuthCreds;
  hostHeader?: string;
  captureLimit?: number;
  captureDeadlineMs?: number;
  proxyTimeoutMs?: number;
}

export interface InspectionProxy {
  port: number;
  close(): Promise<void>;
}

interface PendingState {
  rec: RequestRecord;
  reqCollector: BodyCollector;
  resCollector: BodyCollector | null;
  startedAt: number;
}

export function createInspectionProxy(opts: InspectionProxyOptions): Promise<InspectionProxy> {
  const captureLimit = opts.captureLimit ?? 256 * 1024;
  const captureDeadlineMs = opts.captureDeadlineMs ?? 30_000;
  const policy: HostHeaderPolicy = parseHostHeader(opts.hostHeader);
  const pending = new WeakMap<http.IncomingMessage, PendingState>();

  const proxy = httpProxy.createProxyServer({
    target: opts.target,
    selfHandleResponse: true,
    proxyTimeout: opts.proxyTimeoutMs ?? 60_000,
  });

  // Rewrite Host when requested (http-proxy passes the original through by default).
  proxy.on('proxyReq', (proxyReq, req) => {
    if (policy.mode === 'rewrite') proxyReq.setHeader('host', policy.value);
  });

  function finalize(state: PendingState, patch: Partial<RequestRecord>): void {
    const dur = { ...patch, durationMs: patch.durationMs ?? Date.now() - state.startedAt };
    opts.store.update(state.rec.id, dur);
  }

  proxy.on('proxyRes', (proxyRes, req, res) => {
    const state = pending.get(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
    }
    res.writeHead(proxyRes.statusCode ?? 502, headers);
    proxyRes.pipe(res);

    const collector = createBodyCollector({
      limit: captureLimit,
      deadlineMs: captureDeadlineMs,
      contentType: String(proxyRes.headers['content-type'] ?? ''),
    });
    if (state) state.resCollector = collector;
    proxyRes.on('data', (chunk: Buffer) => collector.push(chunk));
    proxyRes.on('end', () => {
      if (state) {
        state.rec.response = {
          statusCode: proxyRes.statusCode ?? 502,
          statusMessage: proxyRes.statusMessage ?? '',
          headers,
          body: collector.finish(),
        };
        finalize(state, { response: state.rec.response });
      }
    });
    proxyRes.on('error', () => res.destroy());
  });

  // Mandatory: without this, ECONNREFUSED crashes the whole process.
  proxy.on('error', (err: NodeJS.ErrnoException, req, res) => {
    const state = pending.get(req);
    const isSocket = !(res instanceof http.ServerResponse);
    const code = err.code === 'ECONNREFUSED' ? 'upstream_down' : 'proxy_error';
    if (state) {
      if (!state.rec.response) {
        state.rec.response = {
          statusCode: 502,
          statusMessage: 'Bad Gateway',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: { kind: 'text', text: `Upstream unavailable (${err.code ?? err.message})\n`, bytes: 0, truncated: false },
        };
        state.rec.error = code;
      }
      finalize(state, { response: state.rec.response, error: code });
    }
    if (isSocket) {
      (res as unknown as Duplex).destroy();
    } else if (!(res as http.ServerResponse).headersSent) {
      const r = res as http.ServerResponse;
      r.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      r.end(`Upstream unavailable (${err.code ?? err.message})\n`);
    } else {
      (res as http.ServerResponse).destroy();
    }
  });

  const server = http.createServer((req, res) => {
    // Basic auth gate.
    if (opts.auth && !checkBasicAuth(req.headers.authorization, opts.auth)) {
      const u = unauthorizedResponse();
      const parsed = parseTarget(req);
      const rec = opts.store.create({
        tunnelId: opts.tunnelId,
        timestamp: Date.now(),
        method: req.method ?? 'GET',
        path: parsed.path,
        query: parsed.query,
        httpVersion: req.httpVersion,
        ws: false,
        request: { headers: lowercaseHeaders(req.headers), body: null },
        response: {
          statusCode: u.status,
          statusMessage: 'Unauthorized',
          headers: { 'www-authenticate': 'Basic realm="cscodetunnel"', 'content-type': 'text/plain; charset=utf-8' },
          body: { kind: 'text', text: u.body, bytes: u.body.length, truncated: false },
        },
        durationMs: 0,
      });
      opts.store.update(rec.id, { durationMs: 0 });
      res.writeHead(u.status, { 'www-authenticate': 'Basic realm="cscodetunnel"', 'content-type': 'text/plain; charset=utf-8' });
      res.end(u.body);
      return;
    }

    const parsed = parseTarget(req);
    const rec = opts.store.create({
      tunnelId: opts.tunnelId,
      timestamp: Date.now(),
      method: req.method ?? 'GET',
      path: parsed.path,
      query: parsed.query,
      httpVersion: req.httpVersion,
      ws: false,
      request: { headers: lowercaseHeaders(req.headers), body: null },
      response: null,
      durationMs: null,
    });
    const state: PendingState = {
      rec,
      reqCollector: createBodyCollector({
        limit: captureLimit,
        deadlineMs: captureDeadlineMs,
        contentType: String(req.headers['content-type'] ?? ''),
      }),
      resCollector: null,
      startedAt: Date.now(),
    };
    pending.set(req, state);

    req.on('data', (chunk: Buffer) => state.reqCollector.push(chunk));
    req.on('end', () => {
      rec.request.body = state.reqCollector.finish();
      opts.store.update(rec.id, { request: rec.request });
    });

    // Client went away before the response finished.
    res.on('close', () => {
      if (rec.response === null) {
        rec.error = 'client_aborted';
        finalize(state, {});
      }
    });

    proxy.web(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    if (opts.auth && !checkBasicAuth(req.headers.authorization, opts.auth)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const parsed = parseTarget(req);
    const rec = opts.store.create({
      tunnelId: opts.tunnelId,
      timestamp: Date.now(),
      method: req.method ?? 'GET',
      path: parsed.path,
      query: parsed.query,
      httpVersion: req.httpVersion,
      ws: true,
      request: { headers: lowercaseHeaders(req.headers), body: null },
      response: null,
      durationMs: null,
    });
    const startedAt = Date.now();
    // Finalize on close, but also on 'end'/'error': a raw TCP drop only
    // delivers FIN ('end'), leaving the server socket half-open.
    const finalizeWs = () => {
      if (rec.response === null) {
        rec.response = {
          statusCode: 101,
          statusMessage: 'Switching Protocols',
          headers: {},
          body: null,
        };
        opts.store.update(rec.id, { response: rec.response, durationMs: Date.now() - startedAt });
      }
    };
    socket.on('close', finalizeWs);
    socket.on('end', finalizeWs);
    socket.on('error', finalizeWs);
    proxy.ws(req, socket, head, { target: opts.target });
  });

  return new Promise((resolve, reject) => {
    // Track live sockets so close() can force-destroy them (server.close
    // otherwise waits forever for lingering upgraded/keep-alive connections).
    const sockets = new Set<import('node:net').Socket>();
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('proxy did not bind'));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            proxy.close();
            server.close(() => res());
            for (const s of sockets) s.destroy();
          }),
      });
    });
  });
}

function parseTarget(req: http.IncomingMessage): { path: string; query: Record<string, string> } {
  try {
    const u = new URL(req.url ?? '/', 'http://local');
    return { path: u.pathname, query: Object.fromEntries(u.searchParams) };
  } catch {
    return { path: req.url ?? '/', query: {} };
  }
}

function lowercaseHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
  }
  return out;
}
