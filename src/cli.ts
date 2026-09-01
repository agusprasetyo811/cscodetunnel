#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { configFile, ensureQuickConfigFile, loadConfig, namedDir, saveConfig } from './config';
import { ensureCloudflared, managedBinaryPath, resolveCloudflared } from './cloudflared/binary';
import { runCloudflaredCapture, runCloudflaredInteractive } from './cloudflared/spawn';
import { TunnelManager } from './tunnel/manager';
import { RequestStore } from './store/requestStore';
import { createInspectionProxy } from './proxy/server';
import { startDashboard, type Dashboard } from './dashboard/server';
import type { StartTunnelOptions } from './tunnel/types';
import { log, useColor } from './util/log';
import { openBrowser } from './util/openBrowser';
import { track } from './util/telemetry';

// Read the version from package.json so --version can't drift from the publish.
const VERSION = (() => {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Random subdomain labels for wildcard hostnames (trycloudflare-style).
const RANDOM_ADJECTIVES = [
  'rapid', 'clever', 'silent', 'bold', 'swift', 'calm', 'brave', 'bright',
  'cozy', 'eager', 'fancy', 'gentle', 'happy', 'lively', 'mellow', 'neat',
  'proud', 'quick', 'sharp', 'sunny', 'tidy', 'vivid', 'warm', 'wild',
];
const RANDOM_NOUNS = [
  'cloud', 'creek', 'forest', 'garden', 'harbor', 'island', 'meadow', 'moon',
  'mountain', 'ocean', 'peak', 'river', 'shadow', 'spring', 'storm', 'stream',
  'summit', 'valley', 'wave', 'wind', 'woods', 'field', 'lake', 'stone',
];

function randomLabel(): string {
  const adj = RANDOM_ADJECTIVES[Math.floor(Math.random() * RANDOM_ADJECTIVES.length)];
  const noun = RANDOM_NOUNS[Math.floor(Math.random() * RANDOM_NOUNS.length)];
  const hex = Math.random().toString(36).slice(2, 6);
  return `${adj}-${noun}-${hex}`;
}

/** Replace a `*` wildcard in a hostname with a fresh random label. */
export function resolveWildcardHostname(hostname?: string): string | undefined {
  if (!hostname || !hostname.includes('*')) return hostname;
  return hostname.replace('*', randomLabel());
}

const program = new Command();
program
  .name('cscodetunnel')
  .description('Expose local services to the internet via Cloudflare Tunnel — ngrok-style')
  .version(VERSION)
  .exitOverride();

/* ------------------------------------------------------------------ */
/* Shared plumbing                                                     */
/* ------------------------------------------------------------------ */

let binPromise: Promise<string> | null = null;
function getCloudflared(): Promise<string> {
  binPromise ??= ensureCloudflared().catch((err) => {
    binPromise = null; // allow retry on a later spawn
    throw err;
  });
  return binPromise;
}

function parseAuth(value: string): { user: string; pass: string } {
  const sep = value.indexOf(':');
  if (sep === -1) throw new Error('--auth must be in user:password format');
  return { user: value.slice(0, sep), pass: value.slice(sep + 1) };
}

function toHttpUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The upstream URL the inspection proxy forwards to (--target overrides the default). */
function upstreamOf(port: number, target?: string): string {
  return target ?? toHttpUrl(port);
}

interface RunContext {
  store: RequestStore;
  manager: TunnelManager;
  dashboard: Dashboard | null;
  proxies: { close(): Promise<void> }[];
  tunnelIds: string[];
}

function makeContext(): RunContext {
  const store = new RequestStore();
  const manager = new TunnelManager({
    binProvider: getCloudflared,
    log: (m) => log.dim(`  ${m}`),
  });
  return { store, manager, dashboard: null, proxies: [], tunnelIds: [] };
}

async function startDashboardMaybe(
  ctx: RunContext,
  opts: { noDashboard: boolean; dashboardPort: number; noOpen: boolean },
): Promise<void> {
  if (opts.noDashboard) return;
  const cfg = loadConfig();
  const port = opts.dashboardPort || cfg.dashboardPort;
  ctx.dashboard = await startDashboard({
    port,
    store: ctx.store,
    manager: ctx.manager,
    log: (m) => log.dim(m),
  });
  const url = `http://127.0.0.1:${ctx.dashboard.port}`;
  log.ok(`Dashboard: ${url}`);
  if (cfg.openBrowser && !opts.noOpen) openBrowser(url);
}

function wireSignals(ctx: RunContext): () => Promise<void> {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down…');
    await ctx.manager.stopAll();
    for (const p of ctx.proxies) await p.close().catch(() => {});
    if (ctx.dashboard) await ctx.dashboard.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Interactive quit (type 'quit' in the terminal) + scripted trigger.
  // On Windows, programmatic SIGINT is a hard TerminateProcess, so the
  // stdin trigger is what the E2E script (and users) can rely on.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line: string) => {
    const l = line.trim().toLowerCase();
    if (l === 'cscodetunnel_shutdown' || (Boolean(process.stdin.isTTY) && ['quit', 'exit', 'q'].includes(l))) {
      void shutdown();
    }
  });

  return shutdown;
}

function wireStatusPrinting(ctx: RunContext): void {
  ctx.manager.on('status', (info) => {
    if (info.state === 'online' && info.url) {
      log.url(`${info.kind === 'tcp' ? 'tcp' : 'https'} tunnel ready:`, info.url);
      if (info.kind === 'tcp') {
        const host = info.url!.replace(/^[a-z]+:\/\//i, '').replace(/:\d+$/, '');
        log.dim(
          `  Connect from anywhere with:\n` +
            `  cloudflared access tcp --hostname ${host} --url 127.0.0.1:${localPortOf(info)}`,
        );
      }
    } else if (info.state === 'error') {
      log.error(`Tunnel ${info.name} failed: ${info.lastError ?? 'unknown error'}`);
    } else if (info.state === 'restarting') {
      log.warn(`Tunnel ${info.name} disconnected — reconnecting…`);
    }
  });
}

function localPortOf(info: { localTarget: string }): string {
  return info.localTarget.replace(/^[a-z]+:\/\/[^:]+:/i, '') || '?';
}

/* ------------------------------------------------------------------ */
/* http / tcp — quick tunnels                                          */
/* ------------------------------------------------------------------ */

interface QuickOpts {
  port: number;
  target?: string;
  auth?: string;
  hostHeader?: string;
  region?: string;
  noDashboard: boolean;
  dashboardPort: number;
  noOpen: boolean;
  /** Internal/testing: gracefully shut down after N ms (same path as SIGINT). */
  exitAfter?: number;
}

async function runQuickTunnel(kind: 'http' | 'tcp', opts: QuickOpts): Promise<void> {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`Invalid port: ${opts.port}`);
  }
  await getCloudflared();

  const ctx = makeContext();
  const shutdown = wireSignals(ctx);
  wireStatusPrinting(ctx);
  await startDashboardMaybe(ctx, opts);
  if (opts.exitAfter) {
    setTimeout(() => void shutdown(), opts.exitAfter);
  }

  const cloudflaredArgs: string[] = [];
  if (opts.region) cloudflaredArgs.push('--region', opts.region);

  const upstream = upstreamOf(opts.port, opts.target);
  let proxyPort: number | null = null;
  const tunId = `${kind}-${opts.port}`;

  if (kind === 'http') {
    const proxy = await createInspectionProxy({
      tunnelId: tunId,
      target: upstream,
      store: ctx.store,
      auth: opts.auth ? parseAuth(opts.auth) : undefined,
      hostHeader: opts.hostHeader,
    });
    ctx.proxies.push(proxy);
    proxyPort = proxy.port;
    log.ok(`Inspection proxy listening on 127.0.0.1:${proxy.port} → ${upstream}`);
  }

  const startOpts: StartTunnelOptions = {
    id: tunId,
    kind,
    target: kind === 'http' ? `http://127.0.0.1:${proxyPort!}` : `tcp://127.0.0.1:${opts.port}`,
    displayTarget: kind === 'http' ? upstream : `tcp://127.0.0.1:${opts.port}`,
    cloudflaredArgs,
  };
  ctx.tunnelIds.push((await ctx.manager.start(startOpts)).id);
}

/* ------------------------------------------------------------------ */
/* named tunnels                                                       */
/* ------------------------------------------------------------------ */

async function namedLogin(): Promise<void> {
  const bin = await getCloudflared();
  log.info('cloudflared tunnel login — a browser will open, authorize your account.');
  await runCloudflaredInteractive(bin, ['tunnel', 'login']);
}

async function namedCreate(name: string): Promise<void> {
  const bin = await getCloudflared();
  const { code, output } = await runCloudflaredCapture(bin, ['tunnel', 'create', name]);
  console.log(output.trim());
  if (code !== 0) process.exitCode = 1;
}

async function namedRoute(name: string, hostname: string, overwrite: boolean): Promise<void> {
  const bin = await getCloudflared();
  // Isolate from the user's ~/.cloudflared/config.yml — its `tunnel:` field would
  // otherwise hijack name-based lookup (cloudflared reads it as the default config).
  const args = ['--config', ensureQuickConfigFile(), 'tunnel', 'route', 'dns'];
  if (overwrite) args.push('--overwrite-dns');
  args.push(name, hostname);
  const { code, output } = await runCloudflaredCapture(bin, args);
  console.log(output.trim());
  if (code !== 0) process.exitCode = 1;
}

async function namedList(): Promise<void> {
  const bin = await getCloudflared();
  const { code, output } = await runCloudflaredCapture(bin, ['tunnel', 'list']);
  console.log(output.trim());
  if (code !== 0) process.exitCode = 1;
}

/**
 * Find a named tunnel's credentials file. The credentials JSON does not
 * contain the tunnel name, so resolve name→UUID via `cloudflared tunnel list`
 * and read `<uuid>.json` from ~/.cloudflared.
 */
async function findCredentials(
  bin: string,
  name: string,
): Promise<{ uuid: string; file: string } | null> {
  const { output } = await runCloudflaredCapture(bin, ['tunnel', 'list']);
  const uuid = parseTunnelList(output, name);
  if (!uuid) return null;
  const file = path.join(os.homedir(), '.cloudflared', `${uuid}.json`);
  if (!fs.existsSync(file)) return null;
  return { uuid, file };
}

/** Parse `cloudflared tunnel list` output for the UUID of a named tunnel. */
export function parseTunnelList(output: string, name: string): string | null {
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(name)) continue;
    const m = line.match(uuidRe);
    if (m) return m[0];
  }
  return null;
}

interface NamedRunOpts extends Omit<QuickOpts, 'port'> {
  name: string;
  port?: number;
  hostname?: string;
  raw: boolean;
}

async function runNamedTunnel(opts: NamedRunOpts): Promise<void> {
  await getCloudflared();

  const hostname = resolveWildcardHostname(opts.hostname);
  const ctx = makeContext();
  wireSignals(ctx);
  wireStatusPrinting(ctx);

  // Raw passthrough: run the user's own cloudflared config (no inspection).
  if (opts.raw) {
    const startOpts: StartTunnelOptions = {
      id: `named-${opts.name}`,
      kind: 'named',
      name: opts.name,
      target: '(user config)',
      displayTarget: '(user config)',
      hostname,
    };
    ctx.tunnelIds.push((await ctx.manager.start(startOpts)).id);
    return;
  }

  if (!opts.port) {
    throw new Error('named run <name> <port> — port required unless --raw is passed');
  }
  const creds = await findCredentials(await getCloudflared(), opts.name);
  if (!creds) {
    throw new Error(
      `No credentials found for tunnel '${opts.name}'. Run: cscodetunnel named create ${opts.name}`,
    );
  }

  await startDashboardMaybe(ctx, opts);

  const proxy = await createInspectionProxy({
    tunnelId: `named-${opts.name}`,
    target: upstreamOf(opts.port, opts.target),
    store: ctx.store,
    auth: opts.auth ? parseAuth(opts.auth) : undefined,
    hostHeader: opts.hostHeader,
  });
  ctx.proxies.push(proxy);

  // Managed config — never touches the user's own ~/.cloudflared/config.yml.
  const dir = namedDir();
  fs.mkdirSync(dir, { recursive: true });
  const configPath = `${dir}/${opts.name}.yml`;
  fs.writeFileSync(
    configPath,
    [
      `tunnel: ${creds.uuid}`,
      `credentials-file: ${JSON.stringify(creds.file)}`,
      `url: http://127.0.0.1:${proxy.port}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const startOpts: StartTunnelOptions = {
    id: `named-${opts.name}`,
    kind: 'named',
    name: opts.name,
    target: `http://127.0.0.1:${proxy.port}`,
    displayTarget: upstreamOf(opts.port, opts.target),
    configFile: configPath,
    hostname,
    cloudflaredArgs: opts.region ? ['--region', opts.region] : undefined,
  };
  ctx.tunnelIds.push((await ctx.manager.start(startOpts)).id);
}

/* ------------------------------------------------------------------ */
/* default tunnel                                                      */
/* ------------------------------------------------------------------ */

interface DefaultTunnelOpts {
  name?: string;
  hostname?: string;
  port?: number;
  target?: string;
  auth?: string;
  hostHeader?: string;
  region?: string;
  clear?: boolean;
}

async function setDefaultTunnel(opts: DefaultTunnelOpts): Promise<void> {
  const cfg = loadConfig();
  if (opts.clear) {
    cfg.defaultTunnel = null;
    saveConfig(cfg);
    log.ok('Default tunnel cleared.');
    return;
  }
  if (!opts.name) throw new Error('default <name> — a tunnel name is required (or use --clear)');
  cfg.defaultTunnel = {
    name: opts.name,
    hostname: opts.hostname,
    port: opts.port,
    target: opts.target,
    auth: opts.auth,
    hostHeader: opts.hostHeader,
    region: opts.region,
  };
  saveConfig(cfg);
  log.ok(`Default tunnel set: ${opts.name}${opts.hostname ? ` → https://${opts.hostname}` : ''}`);
}

interface StartOpts {
  port?: number;
  hostname?: string;
  target?: string;
  auth?: string;
  hostHeader?: string;
  region?: string;
  raw: boolean;
  noDashboard: boolean;
  dashboardPort: number;
  noOpen: boolean;
}

async function startDefaultTunnel(opts: StartOpts): Promise<void> {
  const d = loadConfig().defaultTunnel;
  if (!d?.name) {
    throw new Error(
      'No default tunnel set. Run: cscodetunnel default <name> --hostname <hostname> [--port <port>]',
    );
  }
  await runNamedTunnel({
    name: d.name,
    port: opts.port ?? d.port,
    hostname: opts.hostname ?? d.hostname,
    target: opts.target ?? d.target,
    auth: opts.auth ?? d.auth,
    hostHeader: opts.hostHeader ?? d.hostHeader,
    region: opts.region ?? d.region,
    raw: opts.raw,
    noDashboard: opts.noDashboard,
    dashboardPort: opts.dashboardPort,
    noOpen: opts.noOpen,
  });
}

/* ------------------------------------------------------------------ */
/* doctor                                                              */
/* ------------------------------------------------------------------ */

async function doctor(): Promise<void> {
  log.info(`Node: ${process.version} (${process.platform}/${process.arch})`);
  log.info(`Config: ${configFile()}`);
  log.info(`Managed binary: ${managedBinaryPath()}`);
  const onPath = await resolveCloudflared();
  log.info(`cloudflared on PATH: ${onPath ?? 'not found'}`);
  try {
    const bin = await getCloudflared();
    log.ok(`cloudflared ready at ${bin}`);
  } catch (err) {
    log.error(String(err));
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* Command registration                                                */
/* ------------------------------------------------------------------ */

function commonFlags(cmd: Command): Command {
  return cmd
    .option('--auth <user:pass>', 'protect the tunnel with basic auth')
    .option('--host-header <value>', 'rewrite the Host header (default: preserve)')
    .option('--target <url>', 'upstream URL to forward to (default: http://127.0.0.1:<port>)')
    .option('--region <region>', 'pass --region through to cloudflared')
    .option('--no-dashboard', 'do not start the inspection dashboard')
    .option('--dashboard-port <port>', 'dashboard port (default: 4040, auto-bumps if busy)', (v) => Number(v))
    .option('--no-open', 'do not auto-open the dashboard in the browser')
    .option('--exit-after <ms>', 'exit gracefully after N ms (internal/testing)', (v) => Number(v));
}

// commander v14 passes the parsed option VALUES (not the Command) as the
// last action-handler argument.
interface CommonOptionValues {
  auth?: string;
  hostHeader?: string;
  target?: string;
  region?: string;
  dashboard?: boolean;
  dashboardPort?: number;
  open?: boolean;
  exitAfter?: number;
  raw?: boolean;
  hostname?: string;
}

function toQuickOpts(port: string, o: CommonOptionValues, kind: 'http' | 'tcp'): QuickOpts {
  return {
    port: Number(port),
    auth: o.auth,
    hostHeader: o.hostHeader,
    target: o.target,
    region: o.region,
    noDashboard: o.dashboard === false,
    dashboardPort: o.dashboardPort || 0,
    noOpen: o.open === false,
    exitAfter: o.exitAfter,
  };
}

commonFlags(program.command('http <port>').description('Expose a local HTTP service (quick tunnel)'))
  .action((port: string, o: CommonOptionValues) => runQuickTunnel('http', toQuickOpts(port, o, 'http')));

commonFlags(program.command('tcp <port>').description('Expose a local TCP service (quick tunnel)'))
  .action((port: string, o: CommonOptionValues) => runQuickTunnel('tcp', toQuickOpts(port, o, 'tcp')));

const named = program.command('named').description('Manage named tunnels (Cloudflare account, custom domain)');
named.command('login').description('Authorize this machine with your Cloudflare account').action(() => namedLogin());
named.command('create <name>').description('Create a named tunnel').action((name: string) => namedCreate(name));
named
  .command('route <name> <hostname>')
  .description('Create a DNS route (CNAME) for a tunnel')
  .option('-f, --overwrite', 'overwrite existing DNS records with this hostname')
  .action((name: string, hostname: string, o: { overwrite?: boolean }) =>
    namedRoute(name, hostname, Boolean(o.overwrite)),
  );
named.command('list').description('List named tunnels').action(() => namedList());
named
  .command('run <name> [port]')
  .description('Run a named tunnel (with inspection proxy when port is given)')
  .option('--hostname <hostname>', 'public hostname (shown in the dashboard)')
  .option('--auth <user:pass>', 'protect the tunnel with basic auth')
  .option('--host-header <value>', 'rewrite the Host header')
  .option('--target <url>', 'upstream URL to forward to (default: http://127.0.0.1:<port>)')
  .option('--raw', "run the user's own cloudflared config without the inspection proxy")
  .option('--no-dashboard', 'do not start the inspection dashboard')
  .option('--dashboard-port <port>', 'dashboard port', (v) => Number(v))
  .option('--no-open', 'do not auto-open the dashboard')
  .action((name: string, port: string | undefined, o: CommonOptionValues) =>
    runNamedTunnel({
      name,
      port: port ? Number(port) : undefined,
      hostname: o.hostname,
      target: o.target,
      auth: o.auth,
      hostHeader: o.hostHeader,
      raw: Boolean(o.raw),
      noDashboard: o.dashboard === false,
      dashboardPort: o.dashboardPort || 0,
      noOpen: o.open === false,
    }),
  );

program
  .command('default [name]')
  .description('Set or clear the default named tunnel (saved to config)')
  .option('--hostname <hostname>', 'public hostname, e.g. xxx.cscode.xyz')
  .option('--port <port>', 'local port to expose', (v) => Number(v))
  .option('--target <url>', 'upstream URL to forward to (default: http://127.0.0.1:<port>)')
  .option('--auth <user:pass>', 'basic auth in front of the tunnel')
  .option('--host-header <value>', 'rewrite the Host header')
  .option('--region <region>', 'pass --region through to cloudflared')
  .option('--clear', 'clear the default tunnel')
  .action((name: string | undefined, o: CommonOptionValues & { port?: number; clear?: boolean }) =>
    setDefaultTunnel({
      name,
      hostname: o.hostname,
      port: o.port,
      target: o.target,
      auth: o.auth,
      hostHeader: o.hostHeader,
      region: o.region,
      clear: Boolean(o.clear),
    }),
  );

program
  .command('start [port]')
  .description('Run the default named tunnel (set with: cscodetunnel default ...)')
  .option('--hostname <hostname>', 'override the public hostname')
  .option('--auth <user:pass>', 'basic auth in front of the tunnel')
  .option('--host-header <value>', 'rewrite the Host header')
  .option('--target <url>', 'upstream URL to forward to (default: http://127.0.0.1:<port>)')
  .option('--region <region>', 'pass --region through to cloudflared')
  .option('--raw', "run the user's own cloudflared config without the inspection proxy")
  .option('--no-dashboard', 'do not start the inspection dashboard')
  .option('--dashboard-port <port>', 'dashboard port', (v) => Number(v))
  .option('--no-open', 'do not auto-open the dashboard')
  .action((port: string | undefined, o: CommonOptionValues) =>
    startDefaultTunnel({
      port: port ? Number(port) : undefined,
      hostname: o.hostname,
      target: o.target,
      auth: o.auth,
      hostHeader: o.hostHeader,
      region: o.region,
      raw: Boolean(o.raw),
      noDashboard: o.dashboard === false,
      dashboardPort: o.dashboardPort || 0,
      noOpen: o.open === false,
    }),
  );

program.command('doctor').description('Check environment and cloudflared setup').action(() => doctor());

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

const noColor = !process.stdout.isTTY;
useColor(!noColor);

// Anonymous usage ping (opt-out: CSCDFLARED_TELEMETRY=0).
{
  const [sub, nested] = process.argv.slice(2);
  const command = sub === 'named' && nested ? `named ${nested}` : sub || 'help';
  track('cscode_run', {
    command,
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
  });
}

program
  .parseAsync(process.argv)
  .then(() => {
    // Command ran and spawned children — keep the process alive.
  })
  .catch((err: unknown) => {
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: string }).code : undefined;
    // --help / --version are normal exits.
    if (code === 'commander.helpDisplayed' || code === 'commander.version') return;
    log.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  });
