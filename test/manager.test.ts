import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TunnelManager } from '../src/tunnel/manager';
import type { StartTunnelOptions } from '../src/tunnel/types';

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-cloudflared.mjs');
const NODE = process.execPath;

function makeManager(logs: string[] = []) {
  return new TunnelManager({
    binProvider: async () => NODE,
    log: (m) => logs.push(m),
  });
}

function opts(extra: Partial<StartTunnelOptions> = {}): StartTunnelOptions {
  return {
    kind: 'http',
    target: 'http://127.0.0.1:12345',
    displayTarget: 'http://127.0.0.1:3000',
    bin: NODE,
    binArgsPrefix: [FIXTURE],
    spawnTimeoutMs: 3000,
    ...extra,
  };
}

// The fixture reads env vars, so set them on process.env around the test.
function withEnv(env: Record<string, string>) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function waitFor(
  pred: () => boolean,
  timeoutMs = 5000,
  step = 50,
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = setInterval(() => {
      if (pred()) {
        clearInterval(tick);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(tick);
        resolve(false);
      }
    }, step);
  });
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cscodetunnel-mgr-'));
  process.env.CSCDETUNNEL_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.CSCDETUNNEL_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FAKE_')) delete process.env[key];
  }
});

describe('TunnelManager', () => {
  it('extracts the URL and goes online', async () => {
    const restore = withEnv({ FAKE_URL: 'https://my-test-host.trycloudflare.com' });
    try {
      const m = makeManager();
      const info = await m.start(opts({}));
      expect(info.state).toBe('starting');
      const ok = await waitFor(() => m.get(info.id)?.state === 'online');
      expect(ok).toBe(true);
      expect(m.get(info.id)?.url).toBe('https://my-test-host.trycloudflare.com');
      await m.stopAll();
    } finally {
      restore();
    }
  });

  it('restarts with backoff after an unexpected exit and picks up a new URL', async () => {
    const restore = withEnv({ FAKE_URL: 'https://first-url.trycloudflare.com', FAKE_EXIT_MS: '300' });
    try {
      const m = makeManager();
      const info = await m.start(opts({}));
      expect(await waitFor(() => m.get(info.id)?.state === 'online')).toBe(true);

      // Switch URL for the restarted process before the old one dies.
      process.env.FAKE_URL = 'https://second-url.trycloudflare.com';
      expect(await waitFor(() => m.get(info.id)?.state === 'online' && m.get(info.id)?.url === 'https://second-url.trycloudflare.com', 8000)).toBe(true);
      expect(m.get(info.id)?.restarts).toBeGreaterThanOrEqual(1);
      await m.stopAll();
    } finally {
      restore();
    }
  });

  it('treats terminal log lines as error with no restart loop', async () => {
    const restore = withEnv({ FAKE_TERMINAL: '1' });
    try {
      const m = makeManager();
      const info = await m.start(opts({}));
      expect(await waitFor(() => m.get(info.id)?.state === 'error')).toBe(true);
      const t = m.get(info.id)!;
      expect(t.lastError).toContain('already being used');
      expect(t.restarts).toBe(0);
      // give a backoff window time to (wrongly) restart — state must stay error
      await new Promise((r) => setTimeout(r, 700));
      expect(m.get(info.id)?.state).toBe('error');
      await m.stopAll();
    } finally {
      restore();
    }
  });

  it('kills the process on stop', async () => {
    const restore = withEnv({ FAKE_URL: 'https://stop-test.trycloudflare.com' });
    try {
      const m = makeManager();
      const info = await m.start(opts({}));
      expect(await waitFor(() => m.get(info.id)?.state === 'online')).toBe(true);
      await m.stop(info.id);
      expect(await waitFor(() => m.get(info.id)?.state === 'stopped')).toBe(true);
    } finally {
      restore();
    }
  });

  it('kills a spawn that never prints a URL and schedules a restart', async () => {
    const restore = withEnv({ FAKE_DELAY_MS: '100000' });
    try {
      const m = makeManager();
      const info = await m.start(opts({ spawnTimeoutMs: 400 }));
      expect(await waitFor(() => m.get(info.id)?.state === 'restarting', 3000)).toBe(true);
      expect(m.get(info.id)?.restarts).toBeGreaterThanOrEqual(1);
      await m.stopAll();
    } finally {
      restore();
    }
  });

  it('manual restart respawns and extracts the new URL', async () => {
    const restore = withEnv({ FAKE_URL: 'https://before-restart.trycloudflare.com' });
    try {
      const m = makeManager();
      const info = await m.start(opts({}));
      expect(await waitFor(() => m.get(info.id)?.state === 'online')).toBe(true);
      process.env.FAKE_URL = 'https://after-restart.trycloudflare.com';
      await m.restart(info.id);
      expect(
        await waitFor(
          () => m.get(info.id)?.state === 'online' && m.get(info.id)?.url === 'https://after-restart.trycloudflare.com',
          5000,
        ),
      ).toBe(true);
      await m.stopAll();
    } finally {
      restore();
    }
  });
});
