import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HasPermissionDirective } from '@auth';
import {
  Alert,
  Chart,
  EmptyState,
  PageHeader,
  Skeleton,
  Stat,
  StatusPill,
  formatMoney,
  type ChartSeries,
  type StatusPillTone,
} from '@shared-ui';

import { TripPerformanceStore } from '../../shared/data/store/trip-performance.store';
import { tripClassLabel } from '../../shared/trip-class';

/** Every value on this screen that can legitimately be unknown renders
 * this, not a zero. */
const NOT_AVAILABLE = 'Not available';

/**
 * One trip's operational and financial outcome — spec 16 slice 4.
 *
 * ## Nulls are the design, not an edge case
 *
 * Three values here are `null` in cases where a zero would be a lie, and
 * the screen has to keep them distinguishable:
 *
 * - **No occupancy without a vehicle.** There is no denominator, and 0%
 *   would read as "nobody bought a seat" on a departure nobody has
 *   assigned a bus to.
 * - **No punctuality before departure.** A trip that has not left is not
 *   "0 minutes late".
 * - **No revenue per seat with nothing sold.**
 *
 * A cancelled trip is reported in full, with occupancy and punctuality
 * suppressed: it counts in the totals but must not drag an average.
 *
 * ## Reached from the trip list's own row, not its action menu
 *
 * That menu sits entirely behind `scheduling.manage`, and the people
 * this screen exists for are exactly the `scheduling.view`-only staff it
 * would hide it from. The link follows this route's own
 * `analytics.view` guard instead.
 */
@Component({
  selector: 'app-trip-performance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    HasPermissionDirective,
    Alert,
    Chart,
    EmptyState,
    PageHeader,
    Skeleton,
    Stat,
    StatusPill,
  ],
  templateUrl: './trip-performance.html',
})
export class TripPerformance {
  protected readonly store = inject(TripPerformanceStore);
  private readonly activatedRoute = inject(ActivatedRoute);

  protected readonly notAvailable = NOT_AVAILABLE;
  protected readonly tripClassLabel = tripClassLabel;

  /** Held rather than read inline, because the manifest cross-link in
   * the header needs it before the store has answered. */
  protected readonly tripId = this.activatedRoute.snapshot.paramMap.get('id') ?? '';

  constructor() {
    void this.store.load(this.tripId);
  }

  protected readonly trip = computed(() => this.store.data()?.trip ?? null);
  protected readonly capacity = computed(() => this.store.data()?.capacity ?? null);
  protected readonly punctuality = computed(() => this.store.data()?.punctuality ?? null);
  protected readonly money = computed(() => this.store.data()?.money ?? []);

  protected readonly occupancyLabel = computed(() => {
    const rate = this.capacity()?.occupancy_rate;
    return rate == null ? NOT_AVAILABLE : `${Math.round(Number(rate) * 100)}%`;
  });

  protected readonly totalSeatsLabel = computed(() => {
    const total = this.capacity()?.total_seats;
    return total == null ? NOT_AVAILABLE : String(total);
  });

  protected readonly occupancyHint = computed(() => {
    const capacity = this.capacity();
    if (!capacity) {
      return null;
    }
    if (capacity.total_seats == null) {
      return 'No vehicle assigned, so there is no capacity to measure against.';
    }
    if (this.store.data()?.cancelled) {
      return 'Suppressed for a cancelled trip, so it drags no average.';
    }
    return `${capacity.seats_sold} of ${capacity.total_seats} places sold.`;
  });

  /**
   * Sold against remaining, as this console's first doughnut.
   *
   * Empty when there is no denominator — a ring drawn from one slice
   * would read as "100% full" on a trip whose capacity is simply not
   * known, which is the exact misreading `total_seats: null` exists to
   * prevent.
   */
  protected readonly occupancySeries = computed<ChartSeries[]>(() => {
    const capacity = this.capacity();
    if (!capacity || capacity.total_seats == null || this.store.data()?.cancelled) {
      return [{ name: 'Places', points: [] }];
    }
    return [
      {
        name: 'Places',
        points: [
          // Explicit colours, not the palette's positional ones. By
          // index, "Empty" got `success` green — so a trip that sold
          // nothing rendered as a solid green ring, which reads as
          // *full* at a glance. Sold is the brand colour and empty is
          // the track behind it, so the ring fills as the bus does.
          {
            label: 'Sold',
            value: capacity.seats_sold,
            color: 'var(--color-brand-600)',
          },
          {
            label: 'Empty',
            value: Math.max(capacity.total_seats - capacity.seats_sold, 0),
            color: 'var(--color-surface-sunken)',
          },
        ],
      },
    ];
  });

  protected readonly placesFormatter = (value: number): string =>
    `${value} place${value === 1 ? '' : 's'}`;

  protected readonly delayLabel = computed(() => {
    const punctuality = this.punctuality();
    if (!punctuality) {
      return NOT_AVAILABLE;
    }
    const minutes = punctuality.delay_minutes;
    if (minutes <= 0) {
      return minutes === 0 ? 'On time' : `${Math.abs(minutes)} min early`;
    }
    return `${minutes} min late`;
  });

  protected readonly punctualityTone = computed<StatusPillTone>(() => {
    const punctuality = this.punctuality();
    if (!punctuality) {
      return 'neutral';
    }
    return punctuality.on_time ? 'positive' : 'warning';
  });

  protected statusTone(status: string): StatusPillTone {
    switch (status) {
      case 'completed':
        return 'positive';
      case 'in_progress':
        return 'warning';
      case 'cancelled':
        return 'negative';
      default:
        return 'neutral';
    }
  }

  protected moneyLabel(amount: string | null | undefined, currency: string): string {
    return amount == null ? NOT_AVAILABLE : formatMoney(amount, currency);
  }
}
