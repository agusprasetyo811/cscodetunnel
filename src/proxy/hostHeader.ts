// Host header policy for the inspection proxy.
// - preserve (default): pass the original Host through unchanged
//   (http-proxy does this by default — changeOrigin is false).
// - rewrite: replace with the policy value, e.g. 'localhost:3000' — needed for
//   dev servers (Vite/Next.js) that reject foreign Host headers.

export type HostHeaderPolicy = { mode: 'preserve' } | { mode: 'rewrite'; value: string };

export function parseHostHeader(value: string | undefined): HostHeaderPolicy {
  if (!value || value === 'preserve') return { mode: 'preserve' };
  return { mode: 'rewrite', value };
}
