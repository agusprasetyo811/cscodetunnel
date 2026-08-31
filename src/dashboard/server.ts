import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import express from 'express';
import type { TunnelManager } from '../tunnel/manager';
import { RequestStore } from '../store/requestStore';
import type { RequestRecord } from '../store/types';
import { SseHub } from './sse';

// The web/ dir is static assets (not compiled by tsc). Resolve it whether we
// run from dist/ (build copies it) or src/ (tsx dev mode).
function webDir(): string {
  const candidates = [
    path.join(__dirname, 'web'),
    path.join(__dirname, '..', '..', 'src', 'dashboard', 'web'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  throw new Error('dashboard web assets not found');
}

/** Strip bodies for list views — keeps SSE/list payloads small. */
function metadata(rec: RequestRecord): RequestRecord {
  const copy = { ...rec } as RequestRecord;
  copy.request = { headers: rec.request.headers, body: null };
  if (copy.response) copy.response = { ...copy.response, body: null };
  return copy;
}

export interface DashboardOptions {
  port: number;
  store: RequestStore;
  manager: TunnelManager;
  log: (msg: string) => void;
}

export interface Dashboard {
  port: number;
  close(): Promise<void>;
}

export function startDashboard(opts: DashboardOptions): Promise<Dashboard> {
  const app = express();
  const hub = new SseHub();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, clients: hub.clientCount });
  });

  app.get('/api/tunnels', (_req, res) => {
    res.json(opts.manager.list());
  });

  app.get('/api/requests', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const tunnelId = typeof req.query.tunnelId === 'string' ? req.query.tunnelId : undefined;
    const all = opts.store.list(limit).filter((r) => !tunnelId || r.tunnelId === tunnelId);
    res.json(all.map(metadata));
  });

  app.get('/api/requests/:id', (req, res) => {
    const rec = opts.store.get(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(rec);
  });

  app.post('/api/tunnels/:id/stop', async (req, res) => {
    try {
      await opts.manager.stop(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  app.post('/api/tunnels/:id/start', async (req, res) => {
    try {
      await opts.manager.resume(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  app.post('/api/tunnels/:id/restart', async (req, res) => {
    try {
      await opts.manager.restart(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  app.get('/api/stream', (req, res) => {
    hub.add(res);
  });

  app.use(express.static(webDir()));

  // Live updates → SSE
  opts.store.subscribe((rec, phase) => hub.broadcast('request', { phase, record: metadata(rec) }));
  opts.manager.on('status', (info) => hub.broadcast('status', info));
  opts.manager.on('log', (tunnelId, line) => hub.broadcast('log', { tunnelId, line }));

  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    const maxAttempts = 5;
    const done = () => {
      server.removeAllListeners('error');
      // With port 0 the OS picks a free port — report the actual bound port.
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : opts.port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            hub.close();
            server.close(() => res());
          }),
      });
    };
    const tryListen = (port: number, attempt: number) => {
      // Re-attach the error handler on every attempt — `once` consumes itself,
      // so a second consecutive failure would otherwise be unhandled.
      server.once('error', (err: NodeJS.ErrnoException) => {
        // EACCES is how Windows reports ports in a reserved/excluded range
        // (e.g. Hyper-V), so treat it like a busy port and bump.
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempt < maxAttempts) {
          opts.log(`port ${port} busy, trying ${port + 1}`);
          tryListen(port + 1, attempt + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => done());
    };
    tryListen(opts.port, 0);
  });
}
