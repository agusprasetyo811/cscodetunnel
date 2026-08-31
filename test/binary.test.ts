import { describe, expect, it } from 'vitest';
import { assetFileNameFor, parseVersion } from '../src/cloudflared/binary';

describe('assetFileNameFor', () => {
  it('maps macOS to .tgz archives', () => {
    expect(assetFileNameFor('darwin', 'arm64')).toBe('cloudflared-darwin-arm64.tgz');
    expect(assetFileNameFor('darwin', 'x64')).toBe('cloudflared-darwin-amd64.tgz');
  });

  it('maps linux/windows to single binaries', () => {
    expect(assetFileNameFor('linux', 'x64')).toBe('cloudflared-linux-amd64');
    expect(assetFileNameFor('linux', 'arm64')).toBe('cloudflared-linux-arm64');
    expect(assetFileNameFor('win32', 'x64')).toBe('cloudflared-windows-amd64.exe');
    expect(assetFileNameFor('win32', 'ia32')).toBe('cloudflared-windows-386.exe');
  });

  it('returns null for unsupported platforms', () => {
    expect(assetFileNameFor('freebsd', 'x64')).toBeNull();
  });
});

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
