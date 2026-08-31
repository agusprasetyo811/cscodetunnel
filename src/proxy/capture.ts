import type { BodyCapture } from '../store/types';

// Bounded body collector. Two guards prevent unbounded buffering:
// 1. `limit` — stop buffering past the cap (streaming continues untouched).
// 2. `deadlineMs` — a streaming response that drips 1 byte/sec would never hit
//    the cap; finalize with `truncated` after the deadline from the first byte.
// Binary detection: content-type heuristic or a NUL byte in the first chunk.

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql)|image\/svg\+xml)/i;

export interface BodyCollector {
  push(chunk: Buffer): void;
  finish(): BodyCapture;
  /** True when a deadline timer is armed (i.e. stream still being fed). */
  pending(): boolean;
}

export function createBodyCollector(opts: {
  limit: number;
  deadlineMs: number;
  contentType?: string;
}): BodyCollector {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let buffered = 0;
  let truncated = false;
  let finished = false;
  let binary = false;
  let deadline: NodeJS.Timeout | null = null;

  function checkBinary(chunk: Buffer): void {
    if (chunk.subarray(0, 1024).includes(0)) binary = true;
  }

  return {
    push(chunk: Buffer): void {
      if (finished) return;
      bytes += chunk.length;
      if (deadline === null && buffered < opts.limit) {
        deadline = setTimeout(() => {
          truncated = true;
        }, opts.deadlineMs);
        deadline.unref?.();
      }
      if (binary || !TEXT_TYPES.test(opts.contentType ?? '')) binary = true;
      if (!binary) checkBinary(chunk);
      if (buffered < opts.limit) {
        const room = opts.limit - buffered;
        const take = chunk.subarray(0, room);
        chunks.push(take);
        buffered += take.length;
        if (buffered >= opts.limit) {
          truncated = true;
          if (deadline) {
            clearTimeout(deadline);
            deadline = null;
          }
        }
      }
    },
    finish(): BodyCapture {
      if (finished) throw new Error('BodyCollector.finish() called twice');
      finished = true;
      if (deadline) {
        clearTimeout(deadline);
        deadline = null;
      }
      const capture: BodyCapture = { kind: binary ? 'binary' : 'text', bytes, truncated };
      if (!binary) capture.text = Buffer.concat(chunks).toString('utf8');
      return capture;
    },
    pending(): boolean {
      return deadline !== null && !finished;
    },
  };
}
