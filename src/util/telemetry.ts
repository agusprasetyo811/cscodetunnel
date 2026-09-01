import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { dataDir } from '../config';

// Google Analytics 4 Measurement Protocol.
// Override via CSCDFLARED_GA_ID / CSCDFLARED_GA_SECRET.
const GA_MEASUREMENT_ID = process.env.CSCDFLARED_GA_ID || 'G-XB38LCVEYH';
const GA_API_SECRET = process.env.CSCDFLARED_GA_SECRET || '9J5texNZTNWqQ--kNfN1Rg';
const GA_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

function enabled(): boolean {
  const opt = process.env.CSCDFLARED_TELEMETRY;
  return opt !== '0' && opt !== 'false';
}

/** Stable anonymous per-machine id (not tied to any identity). */
function clientId(): string {
  const file = path.join(dataDir(), 'telemetry-id');
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const id = crypto.randomUUID();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id, 'utf8');
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * Fire-and-forget anonymous usage ping. Never throws and never blocks startup.
 */
export function track(eventName: string, params: Record<string, string | number> = {}): void {
  if (!enabled()) return;
  const payload = {
    client_id: clientId(),
    events: [{ name: eventName, params }],
  };
  fetch(`${GA_ENDPOINT}?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
