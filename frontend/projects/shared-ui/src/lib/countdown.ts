import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { CountdownClock } from '@shared-data';

import { Icon } from './icon';

/** Under this many seconds remaining, appearance *and* wording change —
 * never colour alone. Two minutes, not some finer-grained warning
 * ramp: the spec names exactly one threshold for this. */
const EXPIRING_SOON_SECONDS = 120;

/** The only moments `liveMessage` updates — docs/specs/21-passenger-
 * experience.md slice 2: "Renders aria-live='polite' at coarse
 * intervals only — five minutes, one minute, thirty seconds — not
 * every second. A per-second live region is unusable with a screen
 * reader." Zero is announced too, alongside these, since reaching zero
 * is exactly the moment a screen reader user most needs to know. */
const ANNOUNCE_AT_SECONDS = new Set([300, 60, 30, 0]);

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * A live countdown to a seat hold's expiry — docs/specs/21-passenger-
 * experience.md slice 2, `booking-confirm` and `my-bookings`' own rows.
 *
 * **Renders from seconds, never a timestamp.** `secondsRemaining`
 * seeds a local counter that this component decrements itself, once a
 * second, via `CountdownClock` — it never compares against
 * `Date.now()`. A wrong device clock still produces a correct
 * countdown this way, which is the entire reason the backend sends a
 * duration rather than only an absolute expiry (see that spec's own
 * data-model section). Renders nothing at all when `secondsRemaining`
 * is `null` — an open-seating or already-paid booking holds nothing to
 * count down.
 *
 * **On reaching zero this does not assert expiry.** It emits `expired`
 * and stops ticking; the *consumer* re-fetches the booking and renders
 * whatever the server actually says, per the spec's own edge case — a
 * client that declares a seat lost the instant its own timer hits zero
 * will sometimes be wrong, and telling someone they lost a seat they
 * still hold is the worse error. This component has no knowledge of
 * bookings or HTTP at all; that is deliberately the caller's job.
 *
 * **One shared interval, not one per instance.** `CountdownClock`
 * (`@shared-data`) is a single root-provided tick source every mounted
 * `Countdown` subscribes to — the spec's own edge case for `my-
 * bookings`' several held rows: "each row counts down independently;
 * one shared interval drives them."
 */
@Component({
  selector: 'ui-countdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  imports: [Icon],
  template: `
    @if (remaining() !== null) {
      <span
        class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap"
        [class.bg-warning-surface]="isExpiringSoon()"
        [class.text-warning]="isExpiringSoon()"
        [class.text-muted]="!isExpiringSoon()"
      >
        <ui-icon name="clock" [size]="14" />
        {{ label() }}
      </span>
      <span class="sr-only" aria-live="polite">{{ liveMessage() }}</span>
    }
  `,
})
export class Countdown implements OnDestroy {
  /** Server-computed remaining seconds (`Booking.hold_expires_in_seconds`).
   * `null` renders nothing — see this component's own docstring. */
  readonly secondsRemaining = input<number | null>(null);

  /** Fires once, the instant the local counter reaches zero. Does
   * **not** mean the hold has actually expired server-side — see the
   * docstring above. */
  readonly expired = output<void>();

  protected readonly remaining = signal<number | null>(null);
  protected readonly liveMessage = signal('');

  protected readonly isExpiringSoon = computed(() => {
    const value = this.remaining();
    return value !== null && value > 0 && value <= EXPIRING_SOON_SECONDS;
  });

  protected readonly label = computed(() => {
    const value = this.remaining();
    if (value === null) {
      return '';
    }
    if (value <= 0) {
      return 'Hold expiring';
    }
    const duration = formatDuration(value);
    return this.isExpiringSoon() ? `Expiring soon — ${duration}` : `Held for ${duration}`;
  });

  private readonly clock = inject(CountdownClock);
  private unsubscribe: (() => void) | null = null;

  constructor() {
    // Reseeds the local counter whenever the input changes — a fresh
    // booking load, or the consumer's own re-fetch after `expired`
    // (which may hand back a longer, refreshed hold rather than a
    // null one, e.g. `refresh_seat_holds` at checkout start). Reads
    // only `secondsRemaining()`, so this never depends on `remaining`
    // itself — `untracked()` still wraps the body, on principle, so a
    // read added here later can't silently turn this into a
    // self-retriggering effect.
    effect(() => {
      const initial = this.secondsRemaining();
      untracked(() => this.reset(initial));
    });
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
  }

  private reset(initial: number | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.remaining.set(initial);
    this.liveMessage.set('');
    if (initial !== null && initial > 0) {
      this.unsubscribe = this.clock.subscribe(() => this.tick());
    }
  }

  private tick(): void {
    const current = this.remaining();
    if (current === null || current <= 0) {
      return;
    }
    const next = current - 1;
    this.remaining.set(next);
    if (ANNOUNCE_AT_SECONDS.has(next)) {
      this.liveMessage.set(next <= 0 ? 'Hold expiring' : `${formatDuration(next)} remaining`);
    }
    if (next <= 0) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.expired.emit();
    }
  }
}
