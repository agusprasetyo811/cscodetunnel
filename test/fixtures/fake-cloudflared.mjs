// Fake cloudflared used by manager tests. Prints a banner with a URL, then
// optionally exits — controlled via env vars so tests can script behavior:
//   FAKE_URL        URL to print (default https://fake-host.trycloudflare.com)
//   FAKE_DELAY_MS   delay before printing the URL
//   FAKE_EXIT_MS    exit after N ms (0 = keep running)
//   FAKE_EXIT_CODE  exit code to use
//   FAKE_TERMINAL   print a terminal-error line and exit 1
import { setTimeout as sleep } from 'node:timers/promises';

const url = process.env.FAKE_URL ?? 'https://fake-host.trycloudflare.com';
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
const exitMs = Number(process.env.FAKE_EXIT_MS ?? 0);
const exitCode = Number(process.env.FAKE_EXIT_CODE ?? 0);
const terminal = process.env.FAKE_TERMINAL === '1';

if (delay > 0) await sleep(delay);

if (terminal) {
  console.error('ERR Failed to create quick tunnel: hostname is already being used');
  process.exit(1);
}

// mimic cloudflared's banner (stderr, INFO-prefixed, box-drawing chars)
console.error(
  `INFO[0000] +--------------------------------------------------------------------------------------------+`,
);
console.error(`INFO[0000] |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |`);
console.error(`INFO[0000] |  ${url}                                                                                     |`);
console.error(
  `INFO[0000] +--------------------------------------------------------------------------------------------+`,
);

if (exitMs > 0) {
  await sleep(exitMs);
  process.exit(exitCode);
}

// keep the process alive so the manager can kill it
await sleep(60 * 60 * 1000);
