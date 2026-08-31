#!/usr/bin/env node
// Manual E2E: exercises a REAL quick tunnel end to end.
//   npm run build && npm run e2e
// Requires internet access. Uses Node fetch (undici ignores HTTP_PROXY).
'use strict';

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const HELLO = path.join(ROOT, 'test', 'fixtures', 'hello-server.mjs');
const MANAGED_BIN = path.join(os.homedir(), '.cscodetunnel', 'bin', 'cloudflared-windows-amd64.exe');

let failures = 0;
const step = (name) => console.log(`\n== ${name}`);
const pass = (msg) => console.log(`  PASS ${msg}`);
const fail = (msg) => {
  failures++;
  console.error(`  FAIL ${msg}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, what) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await pred()) return true;
    } catch {
      /* keep polling */
    }
    await sleep(500);
  }
  fail(`${what} (timed out after ${timeoutMs}ms)`);
  return false;
}

function countCloudflared() {
  return new Promise((resolve) => {
    const p = spawn('tasklist', ['/FI', 'IMAGENAME eq cloudflared-windows-amd64.exe', '/FO', 'CSV', '/NH'], {
      windowsHide: true,
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim() ? out.trim().split(/\r?\n/).length : 0));
  });
}

/* ---------- 1. local hello server ---------- */
step('1. start local hello server');
const hello = spawn(process.execPath, [HELLO], { stdio: ['ignore', 'pipe', 'inherit'] });
let helloPort = null;
await new Promise((resolve, reject) => {
  const rl = readline.createInterface({ input: hello.stdout });
  rl.on('line', (line) => {
    const m = line.match(/^HELLO_LISTENING (\d+)/);
    if (m) {
      helloPort = Number(m[1]);
      rl.close();
      resolve();
    }
  });
  hello.on('exit', (code) => reject(new Error(`hello server died with ${code}`)));
});
pass(`listening on ${helloPort}`);

/* ---------- 2. start the CLI ---------- */
step('2. start cscodetunnel http');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cscodetunnel-e2e-'));
const dashPort = 40000 + Math.floor(Math.random() * 5000);
const env = { ...process.env, CSCDETUNNEL_HOME: tmpHome, NO_COLOR: '1' };
if (fs.existsSync(MANAGED_BIN)) env.CSCDFLARED_BIN = MANAGED_BIN;
const cli = spawn(process.execPath, [CLI, 'http', String(helloPort), '--no-open', '--dashboard-port', String(dashPort)], {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let cliOut = '';
let publicUrl = null;
cli.stdout.on('data', (d) => {
  cliOut += d;
  const m = cliOut.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m && !publicUrl) {
    publicUrl = m[0];
    pass(`public URL: ${publicUrl}`);
  }
});
cli.stderr.on('data', (d) => (cliOut += d));

/* ---------- 3. wait for the public URL ---------- */
step('3. wait for public URL');
const gotUrl = await waitFor(() => publicUrl !== null, 60_000, 'cloudflared never printed a trycloudflare URL');
if (!gotUrl) {
  console.error('--- CLI captured output ---');
  console.error(cliOut);
  console.error('--- end CLI output ---');
  cli.kill();
  process.exit(1);
}
const actualDashPort = await (async () => {
  // dashboard may have bumped ports; discover it
  for (let p = dashPort; p < dashPort + 6; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/health`);
      if (r.ok) return p;
    } catch {
      /* try next */
    }
  }
  return null;
})();
if (actualDashPort === null) fail('dashboard not reachable');
else pass(`dashboard on ${actualDashPort}`);

/* ---------- 4. fetch through the public URL ---------- */
step('4. fetch through the public URL');
const probe = async () => {
  const res = await fetch(`${publicUrl}/?probe=1`, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  return res.status === 200 && text.includes('hello');
};
const probed = await waitFor(probe, 90_000, 'public URL did not serve the hello server');
if (probed) pass('public URL served the local server');

/* ---------- 5. dashboard API: tunnels ---------- */
step('5. dashboard /api/tunnels');
const tunnels = await (await fetch(`http://127.0.0.1:${actualDashPort}/api/tunnels`)).json();
const tun = tunnels.find((t) => t.kind === 'http');
if (!tun || tun.state !== 'online') fail(`tunnel not online: ${JSON.stringify(tunnels)}`);
else if (tun.url !== publicUrl) fail(`url mismatch: ${tun.url} vs ${publicUrl}`);
else pass(`tunnel online with matching URL (${tun.id})`);

/* ---------- 6. dashboard API: request record ---------- */
step('6. dashboard /api/requests');
let record = null;
await waitFor(async () => {
  const recs = await (await fetch(`http://127.0.0.1:${actualDashPort}/api/requests?limit=10`)).json();
  record = recs.find((r) => r.path === '/' && r.query?.probe === '1');
  return Boolean(record);
}, 15_000, 'request record did not appear');
if (!record) process.exit(1);
if (record.response?.statusCode !== 200) fail(`expected 200, got ${record.response?.statusCode}`);
else pass('request recorded with 200');

/* ---------- 7. dashboard API: detail with bodies ---------- */
step('7. dashboard /api/requests/:id');
const detail = await (await fetch(`http://127.0.0.1:${actualDashPort}/api/requests/${record.id}`)).json();
if (!detail.request?.headers || !detail.response?.headers) fail('detail missing headers');
else if (!detail.response?.body?.text?.includes('hello')) fail('detail missing response body');
else pass('detail includes headers and captured response body');

/* ---------- 8. graceful shutdown ---------- */
step('8. graceful shutdown via stdin trigger');
const beforeCount = await countCloudflared();
const exitPromise = new Promise((resolve) => cli.on('exit', resolve));
cli.stdin.write('CSCODETUNNEL_SHUTDOWN\n');
const code = await Promise.race([exitPromise, sleep(20_000).then(() => 'timeout')]);
if (code === 0) pass('CLI exited cleanly with code 0');
else {
  fail(`CLI exit: ${code}`);
  console.error('--- CLI captured output (tail) ---');
  console.error(cliOut.slice(-1500));
  console.error('--- end ---');
  cli.kill();
}
await sleep(1500); // allow the cloudflared child to fully die
const afterCount = await countCloudflared();
if (afterCount <= beforeCount) pass(`cloudflared processes gone (${beforeCount} → ${afterCount})`);
else fail(`cloudflared orphaned (${beforeCount} → ${afterCount})`);

/* ---------- done ---------- */
hello.kill();
fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(failures === 0 ? '\n✅ E2E: all steps passed' : `\n❌ E2E: ${failures} step(s) failed`);
process.exit(failures === 0 ? 0 : 1);
