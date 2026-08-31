import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { binDir } from '../config';
import { log } from '../util/log';

const BASE_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

export function platformAsset(): { fileName: string; url: string } | null {
  const { platform, arch } = process;
  const map: Record<string, string> = {
    win32_x64: 'cloudflared-windows-amd64.exe',
    win32_ia32: 'cloudflared-windows-386.exe',
    win32_arm64: 'cloudflared-windows-amd64.exe',
    linux_x64: 'cloudflared-linux-amd64',
    linux_arm64: 'cloudflared-linux-arm64',
    darwin_x64: 'cloudflared-darwin-amd64',
    darwin_arm64: 'cloudflared-darwin-arm64',
  };
  const fileName = map[`${platform}_${arch}`];
  if (!fileName) return null;
  return { fileName, url: `${BASE_URL}/${fileName}` };
}

export function managedBinaryPath(): string {
  const asset = platformAsset();
  if (!asset) return path.join(binDir(), 'cloudflared');
  return path.join(binDir(), asset.fileName);
}

async function runVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

/** "cloudflared version 2025.2.1 (built ...)" → {major:2025, minor:2, patch:1} or null */
export function parseVersion(output: string): { major: number; minor: number; patch: number } | null {
  const m = output.match(/cloudflared version (\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

const MIN_VERSION = { major: 2023, minor: 10, patch: 0 };

function versionTooOld(v: { major: number; minor: number; patch: number }): boolean {
  return (
    v.major < MIN_VERSION.major ||
    (v.major === MIN_VERSION.major && v.minor < MIN_VERSION.minor)
  );
}

/** Find cloudflared on PATH (or via overrides). Returns absolute path or null. */
export async function resolveCloudflared(): Promise<string | null> {
  // Explicit overrides win: env var, then config.
  const env = process.env.CSCDFLARED_BIN;
  if (env && fs.existsSync(env)) return env;

  const managed = managedBinaryPath();
  if (fs.existsSync(managed)) return managed;

  // PATH lookup — `where` on Windows, `which` elsewhere.
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    const child = spawn(finder, ['cloudflared'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let first = '';
    child.stdout.on('data', (d: Buffer) => {
      if (!first) first = d.toString().split(/\r?\n/)[0].trim();
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && first ? first : null));
  });
}

export async function downloadCloudflared(dir: string): Promise<string> {
  const asset = platformAsset();
  if (!asset) {
    throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset.fileName);
  log.dim(`Downloading cloudflared from ${asset.url} ...`);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(asset.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from GitHub releases`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buf);
      if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
      return dest;
    } catch (err) {
      lastErr = err;
      log.warn(`Download attempt ${attempt} failed: ${String(err)}`);
    }
  }
  throw new Error(
    `Failed to download cloudflared (${String(lastErr)}).\n` +
      `Download manually from ${asset.url} and put it in ${dir}`,
  );
}

/**
 * Resolve a working cloudflared: PATH → managed download → verify version.
 * Throws with a helpful message when it cannot be satisfied.
 */
export async function ensureCloudflared(): Promise<string> {
  const existing = await resolveCloudflared();
  if (existing) {
    const ver = await runVersion(existing);
    const parsed = ver ? parseVersion(ver) : null;
    if (!parsed) {
      throw new Error(
        `Found ${existing} but it does not look like cloudflared (could not read its --version).`,
      );
    }
    if (versionTooOld(parsed)) {
      log.warn(`${existing} is version ${ver} — too old, downloading a fresh copy`);
    } else {
      return existing;
    }
  }
  const downloaded = await downloadCloudflared(binDir());
  const ver = await runVersion(downloaded);
  const parsed = ver ? parseVersion(ver) : null;
  if (!parsed) {
    throw new Error(`Downloaded binary at ${downloaded} failed its --version check.`);
  }
  log.ok(`cloudflared ready (${ver})`);
  return downloaded;
}
