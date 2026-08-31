import { describe, expect, it } from 'vitest';
import { parseVersion } from '../src/cloudflared/binary';

describe('parseVersion', () => {
  it('parses real cloudflared version output', () => {
    expect(parseVersion('cloudflared version 2025.2.1 (built 2025-02-11-1749 UTC)')).toEqual({
      major: 2025,
      minor: 2,
      patch: 1,
    });
  });

  it('handles dev builds', () => {
    expect(parseVersion('cloudflared version 2025.8.0-rc1')).toEqual({
      major: 2025,
      minor: 8,
      patch: 0,
    });
  });

  it('returns null for garbage', () => {
    expect(parseVersion('cloudflared: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});
