import { describe, expect, it } from 'vitest';
import { parseTunnelList } from '../src/cli';

const REAL_OUTPUT = `
ID                                   NAME         CREATED              CONNECTIONS
abc12345-1111-2222-3333-444455556666  myapp       2025-01-15T10:00:00Z  1xAMS
def67890-aaaa-bbbb-cccc-ddddeeeeffff  other       2025-03-01T08:30:00Z
`;

describe('parseTunnelList', () => {
  it('finds the UUID for a named tunnel', () => {
    expect(parseTunnelList(REAL_OUTPUT, 'myapp')).toBe('abc12345-1111-2222-3333-444455556666');
    expect(parseTunnelList(REAL_OUTPUT, 'other')).toBe('def67890-aaaa-bbbb-cccc-ddddeeeeffff');
  });

  it('returns null when the tunnel is unknown', () => {
    expect(parseTunnelList(REAL_OUTPUT, 'nope')).toBeNull();
    expect(parseTunnelList('', 'myapp')).toBeNull();
  });

  it('handles CRLF line endings', () => {
    const out = 'ID                                   NAME\r\n12345678-1111-2222-3333-444455556666  crlf-tunnel\r\n';
    expect(parseTunnelList(out, 'crlf-tunnel')).toBe('12345678-1111-2222-3333-444455556666');
  });
});
