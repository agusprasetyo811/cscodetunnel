import { spawnCloudflared, type ManagedChild } from '../cloudflared/spawn';
import { extractUrl } from '../cloudflared/urlParser';
import { ensureQuickConfigFile } from '../config';
import { Backoff } from '../util/backoff';
import type { StartTunnelOptions, TunnelEvent, TunnelInfo } from './types';

const DEFAULT_SPAWN_TIMEOUT_MS = 60_000;
const STABLE_RESET_MS = 2 * 60 * 1000;

// Log lines that mean the tunnel can never work as configured — no restart loop.
const TERMINAL_PATTERNS: RegExp[] = [
  /Failed to create quick tunnel/i,
  /already registered/i,
  /is already being used/i,
  /invalid (api )?token/i,
  /authentication failed/i,
  /failed to authenticate/i,
  /tunnel credential validation failed/i,
  /no such host/i,
  /error parsing .*config/i,
];

function isTerminalLine(line: string): string | null {
  for (const re of TERMINAL_PATTERNS) {
    if (re.test(line)) return line.trim();
  }
  return null;
}

interface ManagedTunnel {
  info: TunnelInfo;
  opts: StartTunnelOptions;
  child: ManagedChild | null;
  backoff: Backoff;
  stopRequested: boolean;
  manualRestart: boolean;
  terminalError: string | null;
  seenUrls: Set<string>;
  restartTimer: NodeJS.Timeout | null;
  stableTimer: NodeJS.Timeout | null;
  spawnTimer: NodeJS.Timeout | null;
}

export interface TunnelManagerDeps {
  /** Resolve the cloudflared binary to spawn. */
  binProvider: () => Promise<string>;
  log: (msg: string) => void;
}

export class TunnelManager {
  private tunnels = new Map<string, ManagedTunnel>();
  private nextId = 1;
  private statusListeners = new Set<(info: TunnelInfo) => void>();
  private logListeners = new Set<(tunnelId: string, line: string) => void>();
  private exitListeners = new Set<(tunnelId: string, code: number | null) => void>();

  constructor(private deps: TunnelManagerDeps) {}

  on(event: 'status', cb: (info: TunnelInfo) => void): void;
  on(event: 'log', cb: (tunnelId: string, line: string) => void): void;
  on(event: 'exit', cb: (tunnelId: string, code: number | null) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'status' | 'log' | 'exit', cb: (...args: any[]) => void): void {
    if (event === 'status') this.statusListeners.add(cb as (info: TunnelInfo) => void);
    else if (event === 'log') this.logListeners.add(cb as (id: string, line: string) => void);
    else this.exitListeners.add(cb as (id: string, code: number | null) => void);
  }

  private emitStatus(info: TunnelInfo): void {
    for (const cb of this.statusListeners) cb(info);
  }

  private emitLog(id: string, line: string): void {
    for (const cb of this.logListeners) cb(id, line);
  }

  private emitExit(id: string, code: number | null): void {
    for (const cb of this.exitListeners) cb(id, code);
  }

  async start(opts: StartTunnelOptions): Promise<TunnelInfo> {
    const id = opts.id ?? `tun-${this.nextId++}`;
    if (this.tunnels.has(id)) throw new Error(`Tunnel id already in use: ${id}`);
    const displayName =
      opts.name || `${opts.kind}:${opts.displayTarget ?? opts.target.replace(/^[a-z]+:\/\//i, '')}`;
    const t: ManagedTunnel = {
      info: {
        id,
        kind: opts.kind,
        name: displayName,
        state: 'starting',
        url: opts.hostname ? `https://${opts.hostname}` : null,
        localTarget: opts.target,
        displayTarget: opts.displayTarget,
        proxyPort: null,
        startedAt: Date.now(),
        restarts: 0,
        exitCode: null,
      },
      opts,
      child: null,
      backoff: new Backoff(),
      stopRequested: false,
      manualRestart: false,
      terminalError: null,
      seenUrls: new Set(),
      restartTimer: null,
      stableTimer: null,
      spawnTimer: null,
    };
    this.tunnels.set(id, t);
    void this.spawn(t);
    return t.info;
  }

  private clearTimers(t: ManagedTunnel): void {
    if (t.restartTimer) clearTimeout(t.restartTimer);
    if (t.stableTimer) clearTimeout(t.stableTimer);
    if (t.spawnTimer) clearTimeout(t.spawnTimer);
    t.restartTimer = t.stableTimer = t.spawnTimer = null;
  }

  private buildArgs(t: ManagedTunnel): string[] {
    const { opts } = t;
    // Global flags come before the subcommand. --config is explicit for every
    // managed spawn so the user's own ~/.cloudflared/config.yml (and its
    // catch-all 404 ingress) can never hijack our tunnels.
    const args: string[] = [];
    if (opts.kind === 'named' && opts.configFile) {
      args.push('--config', opts.configFile);
    } else if (opts.kind !== 'named') {
      args.push('--config', ensureQuickConfigFile());
    }
    args.push('--no-autoupdate', 'tunnel');
    if (opts.kind === 'named') {
      args.push('run', opts.name!);
    } else {
      args.push('--url', opts.target);
    }
    if (opts.cloudflaredArgs) args.push(...opts.cloudflaredArgs);
    return args;
  }

  private async spawn(t: ManagedTunnel): Promise<void> {
    if (t.stopRequested) return;
    this.clearTimers(t);
    t.seenUrls.clear();
    t.info.state = t.info.restarts > 0 ? 'restarting' : 'starting';
    if (t.info.restarts > 0 && t.info.kind !== 'named') t.info.url = null;
    t.info.lastError = undefined;
    this.emitStatus({ ...t.info });

    let bin: string;
    try {
      bin = t.opts.bin ?? (await this.deps.binProvider());
    } catch (err) {
      this.markTerminal(t, `cloudflared unavailable: ${String(err)}`);
      return;
    }

    const prefix = t.opts.binArgsPrefix ?? [];
    const args = [...prefix, ...this.buildArgs(t)];
    this.deps.log(`spawn: ${bin} ${args.join(' ')}`);

    const child = spawnCloudflared(bin, args, (line) => this.parseLine(t, line));
    t.child = child;
    t.spawnTimer = setTimeout(() => {
      if (t.info.state === 'starting' || t.info.state === 'restarting') {
        this.deps.log(`tunnel ${t.info.id}: no URL within timeout, killing`);
        child.kill();
      }
    }, t.opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);

    child.child.on('close', (code) => this.onExit(t, code));
    child.child.on('error', (err) => {
      // ENOENT etc. — terminal.
      this.markTerminal(t, `failed to spawn: ${String(err)}`);
    });
  }

  private parseLine(t: ManagedTunnel, line: string): void {
    this.emitLog(t.info.id, line);

    const terminal = isTerminalLine(line);
    if (terminal) {
      this.markTerminal(t, terminal);
      return;
    }

    const url = extractUrl(line);
    if (url && !t.seenUrls.has(url)) {
      t.seenUrls.add(url);
      t.info.url = url;
      this.markOnline(t);
    } else if (/Registered tunnel connection/i.test(line) && t.info.state !== 'online') {
      // Named tunnels never print a URL; the connection line means we're live.
      this.markOnline(t);
    }
  }

  private markOnline(t: ManagedTunnel): void {
    if (t.info.state === 'online') return;
    t.info.state = 'online';
    t.info.lastError = undefined;
    t.backoff.markStable();
    if (t.spawnTimer) {
      clearTimeout(t.spawnTimer);
      t.spawnTimer = null;
    }
    // After 2 min of stability the restart counter resets.
    if (!t.stableTimer) {
      t.stableTimer = setTimeout(() => {
        t.backoff.markStable();
        t.stableTimer = null;
      }, STABLE_RESET_MS);
    }
    this.emitStatus({ ...t.info });
  }

  private markTerminal(t: ManagedTunnel, message: string): void {
    t.terminalError = message;
    t.info.state = 'error';
    t.info.lastError = message;
    this.clearTimers(t);
    if (t.child) t.child.kill();
    this.emitStatus({ ...t.info });
  }

  private onExit(t: ManagedTunnel, code: number | null): void {
    if (!this.tunnels.has(t.info.id)) return;
    t.child = null;
    t.info.exitCode = code;
    this.emitExit(t.info.id, code);

    if (t.stopRequested) {
      this.clearTimers(t);
      t.info.state = 'stopped';
      this.emitStatus({ ...t.info });
      return;
    }
    if (t.terminalError) return; // markTerminal already handled it

    // Unexpected exit (any code) → restart with backoff (manual restart = immediate).
    const delay = t.manualRestart ? 0 : t.backoff.nextDelayMs();
    t.manualRestart = false;
    t.info.state = 'restarting';
    t.info.restarts++;
    this.emitStatus({ ...t.info });
    t.restartTimer = setTimeout(() => void this.spawn(t), delay);
  }

  private getTunnel(id: string): ManagedTunnel {
    const t = this.tunnels.get(id);
    if (!t) throw new Error(`Unknown tunnel id: ${id}`);
    return t;
  }

  async stop(id: string): Promise<void> {
    const t = this.getTunnel(id);
    if (t.info.state === 'stopped') return;
    t.stopRequested = true;
    this.clearTimers(t);
    if (t.child) {
      t.child.kill();
    } else {
      t.info.state = 'stopped';
      this.emitStatus({ ...t.info });
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.tunnels.keys()].map((id) => this.stop(id)));
  }

  async restart(id: string): Promise<void> {
    const t = this.getTunnel(id);
    if (t.info.state === 'stopped') return;
    t.manualRestart = true;
    t.stopRequested = false;
    t.terminalError = null;
    t.backoff.reset();
    this.clearTimers(t);
    if (t.child) {
      t.child.kill();
    } else {
      // e.g. restarting a tunnel stuck in 'error' — no child to kill.
      t.info.state = 'starting';
      t.info.lastError = undefined;
      this.emitStatus({ ...t.info });
      void this.spawn(t);
    }
  }

  list(): TunnelInfo[] {
    return [...this.tunnels.values()].map((t) => ({ ...t.info }));
  }

  get(id: string): TunnelInfo | undefined {
    const t = this.tunnels.get(id);
    return t ? { ...t.info } : undefined;
  }
}
