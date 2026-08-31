export type TunnelKind = 'http' | 'tcp' | 'named';

export type TunnelState = 'starting' | 'online' | 'restarting' | 'error' | 'stopped';

export interface TunnelInfo {
  id: string;
  kind: TunnelKind;
  /** Display name: 'http:3000', 'tcp:4000', or the named tunnel name. */
  name: string;
  state: TunnelState;
  /** Public URL. Null while reconnecting (quick tunnel URLs change per run). */
  url: string | null;
  /** What cloudflared points at locally (proxy or tcp port). */
  localTarget: string;
  /** The user's real app address, shown in the dashboard. */
  displayTarget?: string;
  proxyPort: number | null;
  startedAt: number;
  restarts: number;
  lastError?: string;
  exitCode?: number | null;
}

export interface StartTunnelOptions {
  /** Fixed tunnel id (default: tun-N). Useful when the id must be known before start. */
  id?: string;
  kind: TunnelKind;
  /** Named tunnel name (kind === 'named'). */
  name?: string;
  /** Where cloudflared points at, e.g. http://127.0.0.1:40000 or tcp://127.0.0.1:5432. */
  target: string;
  /** User-facing target for the dashboard. */
  displayTarget?: string;
  /** Managed config path passed via --config (named tunnels). */
  configFile?: string;
  /** Public hostname for named tunnels (shown in the dashboard). */
  hostname?: string;
  /** Extra cloudflared args (e.g. --region us). */
  cloudflaredArgs?: string[];
  /** Override the cloudflared binary (tests inject node + fixture). */
  bin?: string;
  /** Args inserted before the tunnel args (used with node + fixture script). */
  binArgsPrefix?: string[];
  /** How long to wait for a URL before treating the spawn as failed (ms). */
  spawnTimeoutMs?: number;
}

export type TunnelStatusEvent = { type: 'status'; info: TunnelInfo };
export type TunnelLogEvent = { type: 'log'; tunnelId: string; line: string };
export type TunnelExitEvent = { type: 'exit'; tunnelId: string; code: number | null };
export type TunnelEvent = TunnelStatusEvent | TunnelLogEvent | TunnelExitEvent;
