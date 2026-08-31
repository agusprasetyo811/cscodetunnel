// Minimal ANSI-colored logger — avoids the chalk dependency (v5 is ESM-only).

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

export function useColor(enabled: boolean): void {
  for (const key of Object.keys(colors)) {
    (colors as Record<string, string>)[key] = enabled ? (colors as Record<string, string>)[key] : '';
  }
}

function color(c: string, s: string): string {
  return `${c}${s}${colors.reset}`;
}

export const log = {
  info(msg: string): void {
    console.log(msg);
  },
  ok(msg: string): void {
    console.log(`${color(colors.green, '✔')} ${msg}`);
  },
  warn(msg: string): void {
    console.log(`${color(colors.yellow, '⚠')} ${msg}`);
  },
  error(msg: string): void {
    console.error(`${color(colors.red, '✖')} ${msg}`);
  },
  /** Banner-style line for the public URL, similar to cloudflared's table. */
  url(label: string, url: string): void {
    const line = `  ${label} ${url}`;
    const width = line.length;
    console.log(`  ${'─'.repeat(width)}`);
    console.log(line);
    console.log(`  ${'─'.repeat(width)}`);
  },
  dim(msg: string): void {
    console.log(color(colors.dim, msg));
  },
};
