// Extract the public *.trycloudflare.com URL from any cloudflared log line.
// cloudflared prints it in several formats across versions:
//   INFO[0000] | https://random-words.trycloudflare.com            |
//   https://random-words.trycloudflare.com
//   tcp://random-words.trycloudflare.com:443                       (TCP quick tunnels)
// plus ANSI colors, box-drawing table borders, and \r line endings.

const ANSI = /\x1b\[[0-9;]*m/g;

const URL_WITH_SCHEME = /((?:https?|tcp):\/\/[^\s"'`<>|\\]+\.trycloudflare\.com(?::\d+)?(?![\w.-]))/i;
const BARE_HOSTNAME = /(^|[^\w-])([a-z0-9-]+\.trycloudflare\.com)(?![\w.-])/i;

export function extractUrl(line: string): string | null {
  const cleaned = line.replace(ANSI, '').trim();

  const schemeMatch = cleaned.match(URL_WITH_SCHEME);
  if (schemeMatch) {
    // The regex may have grabbed a trailing box-drawing char; strip non-URL chars.
    return schemeMatch[1].replace(/[^\x21-\x7e]/g, '');
  }

  // Some cloudflared versions print a bare hostname (no scheme).
  const bareMatch = cleaned.match(BARE_HOSTNAME);
  if (bareMatch) {
    return `https://${bareMatch[2]}`;
  }
  return null;
}

export function isTrycloudflareUrl(url: string): boolean {
  return url.includes('.trycloudflare.com');
}
