import { spawn } from 'node:child_process';

// Open a URL in the default browser, detached so it survives the CLI's lifetime.
export function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // Browser opening is best-effort — never crash the CLI over it.
  });
  child.unref();
}
