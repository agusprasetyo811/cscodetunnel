import * as crypto from 'node:crypto';

export interface BasicAuthCreds {
  user: string;
  pass: string;
}

/**
 * Validate an HTTP Basic `Authorization` header against credentials.
 * Constant-time comparison; malformed input never throws.
 */
export function checkBasicAuth(authHeader: string | undefined, creds: BasicAuthCreds): boolean {
  if (!authHeader) return false;
  const m = authHeader.match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, creds.user) && safeEqual(pass, creds.pass);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function unauthorizedResponse(): { status: number; body: string } {
  return {
    status: 401,
    body: 'Unauthorized — this tunnel is protected by basic auth.\n',
  };
}
