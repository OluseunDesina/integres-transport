/**
 * Drives a repeating `tick()` for the polling screens
 * `docs/specs/20-live-operations.md` describes — the live-operations
 * board today, passenger tracking and the activity feed in slice 4.
 *
 * Three rules the spec calls out by name, all enforced here rather than
 * per screen:
 *
 * 1. **Stops when the tab is hidden.** "Polling stops when the tab is
 *    hidden (`visibilitychange`) and on screen teardown. A live screen
 *    left open on a forgotten tab all weekend is otherwise a
 *    self-inflicted load test." Resuming does one immediate tick rather
 *    than waiting out whatever was left of the old interval — a tab
 *    hidden for an hour should not sit on stale data for another twelve
 *    seconds once it is looked at again.
 * 2. **Stops for good on `destroy()`.** "A leaked interval is invisible
 *    until it is a production problem" — every consumer must call this
 *    from `ngOnDestroy`, which is exactly what this class's own spec
 *    asserts.
 * 3. **The interval is server-controlled.** `poll_interval_seconds`
 *    arrives on every response so it can widen without a client
 *    deploy; `setIntervalMs` lets a caller apply that without
 *    restarting the whole poller.
 *
 * One tick in flight at a time: a slow response does not stack a second
 * request behind it, and a tab-visible flip arriving mid-request is a
 * no-op rather than a second, overlapping run.
 */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private inFlight = false;
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.stop();
    } else if (!this.destroyed && this.timer === null && !this.inFlight) {
      void this.run();
    }
  };

  constructor(
    private readonly tickFn: () => Promise<void> | void,
    private intervalMs: number
  ) {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Runs one tick immediately, then repeats on the current interval. */
  start(): void {
    if (this.destroyed) {
      return;
    }
    void this.run();
  }

  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
  }

  /** Cancels the pending scheduled tick without releasing the
   * `visibilitychange` listener — `start()` or a later visibility
   * change can resume it. A tick already in flight still completes. */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Call from `ngOnDestroy`. Irreversible — a destroyed poller never
   * schedules again, including from a subsequent `visibilitychange`. */
  destroy(): void {
    this.destroyed = true;
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  private async run(): Promise<void> {
    if (this.destroyed || document.hidden || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      await this.tickFn();
    } finally {
      this.inFlight = false;
    }
    if (!this.destroyed && !document.hidden) {
      this.timer = setTimeout(() => void this.run(), this.intervalMs);
    }
  }
}
