import { describe, expect, it } from 'vitest';
import { extractUrl } from '../src/cloudflared/urlParser';

describe('extractUrl', () => {
  it('parses a plain URL line', () => {
    expect(extractUrl('https://random-words-here.trycloudflare.com')).toBe(
      'https://random-words-here.trycloudflare.com',
    );
  });

  it('parses INFO-prefixed log lines', () => {
    expect(extractUrl('INFO[0000] | https://cool-name.trycloudflare.com |')).toBe(
      'https://cool-name.trycloudflare.com',
    );
  });

  it('parses the table-mode banner with box-drawing characters', () => {
    const line =
      'INFO[0000] | https://table-mode.trycloudflare.com                                                                  |';
    expect(extractUrl(line)).toBe('https://table-mode.trycloudflare.com');
  });

  it('handles ANSI color codes', () => {
    expect(extractUrl('\x1b[32mhttps://colored.trycloudflare.com\x1b[0m')).toBe(
      'https://colored.trycloudflare.com',
    );
  });

  it('handles trailing carriage returns', () => {
    expect(extractUrl('https://crlf.trycloudflare.com\r')).toBe('https://crlf.trycloudflare.com');
  });

  it('parses tcp:// URLs with a port', () => {
    expect(extractUrl('tcp://tcp-mode.trycloudflare.com:443')).toBe(
      'tcp://tcp-mode.trycloudflare.com:443',
    );
  });

  it('falls back to bare hostnames without a scheme', () => {
    expect(extractUrl('INFO[0000] bare-mode.trycloudflare.com')).toBe(
      'https://bare-mode.trycloudflare.com',
    );
  });

  it('ignores bare hostname fallback when a scheme URL is present', () => {
    const line = 'Your quick Tunnel has been created! Visit it at: https://scheme.trycloudflare.com';
    expect(extractUrl(line)).toBe('https://scheme.trycloudflare.com');
  });

  it('returns null for unrelated log lines', () => {
    expect(extractUrl('INFO[0000] Registered tunnel connection connIndex=0')).toBeNull();
    expect(extractUrl('')).toBeNull();
  });

  it('does not match lookalike domains', () => {
    expect(extractUrl('https://evil.trycloudflare.com.evil.com')).toBeNull();
    expect(extractUrl('https://not-real.trycloudflare.co.uk')).toBeNull();
  });
});
