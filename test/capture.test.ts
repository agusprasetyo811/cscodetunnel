import { describe, expect, it, vi } from 'vitest';
import { createBodyCollector } from '../src/proxy/capture';

const LIMIT = 100;

function make(contentType?: string) {
  return createBodyCollector({ limit: LIMIT, deadlineMs: 30_000, contentType });
}

describe('createBodyCollector', () => {
  it('captures text bodies under the cap', () => {
    const c = make('text/plain');
    c.push(Buffer.from('hello '));
    c.push(Buffer.from('world'));
    expect(c.finish()).toEqual({
      kind: 'text',
      text: 'hello world',
      bytes: 11,
      truncated: false,
    });
  });

  it('truncates at the cap and keeps counting bytes', () => {
    const c = make('text/plain');
    c.push(Buffer.from('x'.repeat(80)));
    c.push(Buffer.from('y'.repeat(80)));
    const out = c.finish();
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBe(160);
    // first 100 stream bytes: 80 x's + 20 y's
    expect(out.text).toBe('x'.repeat(80) + 'y'.repeat(20));
  });

  it('finalizes truncated when the deadline passes on a drip feed', () => {
    vi.useFakeTimers();
    try {
      const c = make('text/plain');
      c.push(Buffer.from('a'));
      vi.advanceTimersByTime(31_000);
      const out = c.finish();
      expect(out.truncated).toBe(true);
      expect(out.text).toBe('a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects binary by content-type', () => {
    const c = make('image/png');
    c.push(Buffer.from('not actually png bytes'));
    const out = c.finish();
    expect(out.kind).toBe('binary');
    expect(out.text).toBeUndefined();
  });

  it('detects binary by NUL byte even with a text content-type', () => {
    const c = make('text/plain');
    c.push(Buffer.from([0x41, 0x00, 0x42]));
    expect(c.finish().kind).toBe('binary');
  });

  it('handles empty bodies', () => {
    const c = make('application/json');
    expect(c.finish()).toEqual({ kind: 'text', text: '', bytes: 0, truncated: false });
  });

  it('ignores pushes after finish', () => {
    const c = make('text/plain');
    c.push(Buffer.from('ab'));
    const out = c.finish();
    c.push(Buffer.from('cd'));
    expect(out.text).toBe('ab');
    expect(out.bytes).toBe(2);
  });
});
