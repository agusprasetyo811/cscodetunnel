import type { ServerResponse } from 'node:http';

// Minimal hand-rolled Server-Sent Events hub (no dependency needed).
// Each client gets a 15s heartbeat so proxies never consider the stream dead.

const HEARTBEAT_MS = 15_000;

export class SseHub {
  private clients = new Set<ServerResponse>();
  private heartbeats = new Map<ServerResponse, NodeJS.Timeout>();

  add(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    this.clients.add(res);
    const t = setInterval(() => this.send(res, 'ping', null), HEARTBEAT_MS);
    this.heartbeats.set(res, t);
    res.on('close', () => this.remove(res));
  }

  remove(res: ServerResponse): void {
    this.clients.delete(res);
    const t = this.heartbeats.get(res);
    if (t) clearInterval(t);
    this.heartbeats.delete(res);
  }

  broadcast(event: string, data: unknown): void {
    for (const res of this.clients) this.send(res, event, data);
  }

  close(): void {
    for (const res of [...this.clients]) {
      this.remove(res);
      if (!res.writableEnded) res.end();
    }
  }

  private send(res: ServerResponse, event: string, data: unknown): void {
    if (res.writableEnded || res.destroyed) {
      this.remove(res);
      return;
    }
    if (event === 'ping') {
      res.write(': ping\n\n');
      return;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
