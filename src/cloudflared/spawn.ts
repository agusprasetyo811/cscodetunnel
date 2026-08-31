import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

export interface ManagedChild {
  child: ChildProcess;
  kill(): void;
}

/**
 * Spawn cloudflared with line-buffered stdout+stderr piped to onLine.
 * shell is always false; windowsHide hides the console window on Windows.
 */
export function spawnCloudflared(
  bin: string,
  args: string[],
  onLine: (line: string) => void,
): ManagedChild {
  const child = spawn(bin, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line: string) => onLine(line.replace(/\r$/, '')));
  }

  return {
    child,
    kill() {
      if (!child.killed) child.kill();
    },
  };
}

/**
 * Run a cloudflared command interactively (stdio inherited) — used for
 * `tunnel login`, which prints a browser URL and blocks on user action.
 */
export function runCloudflaredInteractive(bin: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { shell: false, stdio: 'inherit', windowsHide: false });
    child.on('error', (err) => {
      console.error(`Failed to run cloudflared: ${String(err)}`);
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
}

/**
 * Run a cloudflared command capturing stdout — used for `tunnel create`/`tunnel list`.
 */
export function runCloudflaredCapture(bin: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve({ code: null, output: out }));
    child.on('close', (code) => resolve({ code, output: out }));
  });
}
