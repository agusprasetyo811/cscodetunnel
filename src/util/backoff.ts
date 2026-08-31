// Exponential backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s (cap), then stays at cap.
// The counter resets after the tunnel has been stable for `resetAfterMs`.

const SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000];
const RESET_AFTER_MS = 2 * 60 * 1000;

export class Backoff {
  private attempts = 0;
  private stableSince: number | null = null;

  /** Called when the tunnel goes online / stays healthy. */
  markStable(): void {
    if (this.stableSince === null) this.stableSince = Date.now();
    else if (Date.now() - this.stableSince > RESET_AFTER_MS) this.reset();
  }

  /** Delay to wait before the next restart attempt (ms). */
  nextDelayMs(): number {
    const delay = SCHEDULE[Math.min(this.attempts, SCHEDULE.length - 1)];
    this.attempts++;
    this.stableSince = null;
    return delay;
  }

  reset(): void {
    this.attempts = 0;
    this.stableSince = null;
  }

  get attemptCount(): number {
    return this.attempts;
  }
}
