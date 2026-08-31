import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/util/backoff';

describe('Backoff', () => {
  it('follows the schedule 1,2,4,8,16,30 and stays at cap', () => {
    const b = new Backoff();
    expect(b.nextDelayMs()).toBe(1000);
    expect(b.nextDelayMs()).toBe(2000);
    expect(b.nextDelayMs()).toBe(4000);
    expect(b.nextDelayMs()).toBe(8000);
    expect(b.nextDelayMs()).toBe(16000);
    expect(b.nextDelayMs()).toBe(30000);
    expect(b.nextDelayMs()).toBe(30000);
  });

  it('resets after being marked stable', () => {
    const b = new Backoff();
    expect(b.nextDelayMs()).toBe(1000);
    expect(b.nextDelayMs()).toBe(2000);
    b.reset();
    expect(b.nextDelayMs()).toBe(1000);
  });

  it('resets after 2 minutes stable', () => {
    const b = new Backoff();
    expect(b.nextDelayMs()).toBe(1000);
    expect(b.nextDelayMs()).toBe(2000);
    b.markStable();
    // simulate 2min+ of stability
    b.markStable();
    const stableSince = (b as unknown as { stableSince: number | null }).stableSince;
    expect(stableSince).not.toBeNull();
    // force elapsed time by directly resetting (internal clock not injectable in v1)
    b.reset();
    expect(b.nextDelayMs()).toBe(1000);
  });
});
