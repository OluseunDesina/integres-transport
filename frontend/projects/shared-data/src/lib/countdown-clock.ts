import { Injectable } from '@angular/core';

/**
 * One shared per-second tick for every `ui-countdown` (`@shared-ui`) on
 * screen at once — docs/specs/21-passenger-experience.md slice 2's own
 * edge case: "Multiple held bookings in the list: each row counts down
 * independently; one shared interval drives them." `providedIn: 'root'`
 * so every `Countdown` instance gets the same clock without a consumer
 * having to wire one up — `my-bookings`' several rows and
 * `booking-confirm`'s single one all share it for free.
 *
 * A distinct primitive from `Poller`, not a reuse of it, and
 * deliberately not a DI-free plain class the way `Poller` is: `Poller`
 * is one *screen's* own polling need (a fresh `new Poller(...)` per
 * consumer, since each screen polls a different endpoint at its own
 * pace) — this is one *tick source* several unrelated component
 * instances must all observe together, which is exactly what a
 * root-provided singleton is for. Reusing `Poller`'s
 * `tickFn: () => Promise<void>` shape here would also be forcing an
 * async, single-flight-guarded contract onto something that is a
 * synchronous local decrement with no server round-trip at all.
 *
 * Pauses on `visibilitychange`, the same reason `Poller`'s own hidden-
 * tab pause exists: a timer nobody is looking at should not run
 * forever. Ref-counted so the interval exists only while at least one
 * `Countdown` is actually mounted somewhere in the app.
 */
@Injectable({ providedIn: 'root' })
export class CountdownClock {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.stopTimer();
    } else {
      this.startTimerIfNeeded();
    }
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Registers `callback` to run once per second while the tab is
   * visible. Returns an unsubscribe function — call it from the
   * consumer's `ngOnDestroy`, the same obligation `Poller.destroy()`
   * carries. */
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    this.startTimerIfNeeded();
    return () => {
      this.listeners.delete(callback);
      if (this.listeners.size === 0) {
        this.stopTimer();
      }
    };
  }

  private startTimerIfNeeded(): void {
    if (this.timer !== null || document.hidden || this.listeners.size === 0) {
      return;
    }
    this.timer = setInterval(() => {
      for (const listener of this.listeners) {
        listener();
      }
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
