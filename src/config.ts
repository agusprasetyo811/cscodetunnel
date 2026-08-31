import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// All state lives under ~/.cscodetunnel/ (or $CSCDETUNNEL_HOME for tests/isolation).
// We deliberately never touch ~/.cloudflared — that belongs to the user's own
// cloudflared setup.
export function dataDir(): string {
  return process.env.CSCDETUNNEL_HOME || path.join(os.homedir(), '.cscodetunnel');
}

export function binDir(): string {
  return path.join(dataDir(), 'bin');
}

export function namedDir(): string {
  return path.join(dataDir(), 'named');
}

/**
 * Quick tunnels must run with an explicit (empty) config: if cloudflared
 * finds the user's own ~/.cloudflared/config.yml it loads its ingress rules
 * and the catch-all `http_status:404` hijacks every quick-tunnel request.
 */
export function quickConfigFile(): string {
  return path.join(dataDir(), 'quick.yml');
}

export function ensureQuickConfigFile(): string {
  const file = quickConfigFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '# managed by cscodetunnel — do not edit\n', 'utf8');
  }
  return file;
}

export function configFile(): string {
  return path.join(dataDir(), 'config.json');
}

export interface DefaultTunnelConfig {
  name: string;
  hostname?: string;
  port?: number;
  /** Upstream URL the inspection proxy forwards to (overrides the default http://127.0.0.1:<port>). */
  target?: string;
  auth?: string;
  hostHeader?: string;
  region?: string;
}

export interface AppConfig {
  version: 1;
  dashboardPort: number;
  openBrowser: boolean;
  cloudflaredPath?: string;
  /** `null` means the user explicitly cleared the (baked-in) default tunnel. */
  defaultTunnel?: DefaultTunnelConfig | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  dashboardPort: 4040,
  openBrowser: true,
  // Baked-in default tunnel — `cscodetunnel start` works out of the box without
  // running `cscodetunnel default ...` first. Override per-machine in
  // ~/.cscodetunnel/config.json or clear with `cscodetunnel default --clear`.
  defaultTunnel: {
    name: 'cscode-tunnel',
    hostname: '*.cscode.xyz',
    port: 3000,
    target: 'http://127.0.0.1:3000',
  },
};

export function loadConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // Missing or corrupt config never crashes the CLI — fall back to defaults.
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: AppConfig): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8');
}
