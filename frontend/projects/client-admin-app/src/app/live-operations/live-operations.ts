import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { Poller } from '@shared-data';
import {
  Alert,
  EmptyState,
  PageHeader,
  Skeleton,
  UiMap,
  type MapMarker,
  type StatusPillTone,
} from '@shared-ui';

import {
  LiveOperationsStore,
  type TripLiveEnvelope,
} from '../shared/data/store/live-operations.store';

const NOT_RECORDED = 'Unknown';
const NO_SIGNAL = 'No signal';

/**
 * The operator live-monitoring board — docs/specs/20-live-operations.md
 * slice 3.
 *
 * ## Why this is not a `ListStore` screen
 *
 * Every other list screen in this app fetches once and re-fetches on a
 * filter change. This one never stops: a `Poller` (`@shared-data`)
 * drives `LiveOperationsStore.poll()` on the server's own
 * `poll_interval_seconds`, stopping when the tab is hidden and for good
 * on `ngOnDestroy` — "a leaked interval is invisible until it is a
 * production problem" is the spec's own phrase for why that discipline
 * lives in one tested class rather than being re-derived here.
 *
 * ## Selection survives a poll, disappearance does not
 *
 * `selectedTripId` is a local signal, not store state, so re-selecting
 * nothing on every poll would flicker the detail panel closed and
 * open again. `selectedEnvelope` reads the *current* poll's map by that
 * id — when a trip completes and a full reconciliation drops it, the
 * lookup simply returns `undefined` and the panel falls back to "select
 * a trip", rather than showing a form for a trip that no longer exists.
 *
 * ## The map only ever plots trips with a position
 *
 * "Trip in progress, no device" is `position: null` in the spec's own
 * edge-case table, "never a default coordinate" — `mapMarkers` filters
 * those out entirely rather than plotting a vehicle at `(0, 0)`. The
 * trip list still shows every trip, marked "No signal".
 */
@Component({
  selector: 'app-live-operations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Alert, EmptyState, PageHeader, Skeleton, UiMap],
  // `DatePipe` is used programmatically (`etaLabel` below), not from the
  // template, so it needs an explicit provider rather than an `imports`
  // entry — the latter only registers it for template pipe syntax.
  providers: [DatePipe],
  templateUrl: './live-operations.html',
})
export class LiveOperations implements OnInit, OnDestroy {
  protected readonly store = inject(LiveOperationsStore);
  private readonly datePipe = inject(DatePipe);

  protected readonly selectedTripId = signal<string | null>(null);
  protected readonly selectedEnvelope = computed(() =>
    this.store.trips().find((envelope) => envelope.trip.id === this.selectedTripId())
  );

  protected readonly mapMarkers = computed<MapMarker[]>(() =>
    this.store
      .trips()
      .filter((envelope) => envelope.position !== null)
      .map((envelope) => this.toMarker(envelope))
  );

  private readonly poller = new Poller(() => this.store.poll(), 12_000);

  constructor() {
    // The server names its own interval on every response
    // (`poll_interval_seconds`) so it can widen without a client
    // deploy — applied to the poller as soon as it changes.
    effect(() => {
      this.poller.setIntervalMs(this.store.pollIntervalSeconds() * 1000);
    });
  }

  ngOnInit(): void {
    this.poller.start();
  }

  ngOnDestroy(): void {
    this.poller.destroy();
  }

  protected selectTrip(id: string): void {
    this.selectedTripId.set(id);
  }

  protected readonly notRecorded = NOT_RECORDED;

  protected stalenessLabel(envelope: TripLiveEnvelope): string {
    if (!envelope.position) {
      return NO_SIGNAL;
    }
    const seconds = envelope.position.staleness_seconds;
    return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
  }

  protected stalenessTone(envelope: TripLiveEnvelope): StatusPillTone {
    if (!envelope.position) {
      return 'negative';
    }
    return envelope.position.staleness_seconds > 120 ? 'warning' : 'positive';
  }

  protected delayLabel(envelope: TripLiveEnvelope): string {
    const delay = envelope.punctuality.delay_minutes;
    if (delay === null) {
      return NOT_RECORDED;
    }
    return delay <= 0 ? 'On time' : `${delay} min late`;
  }

  protected occupancyLabel(envelope: TripLiveEnvelope): string {
    const { boarded, capacity } = envelope.occupancy;
    // `null` means no vehicle is assigned — unknowable, not zero, the
    // same rule `trip-manifest`'s own capacity label follows.
    return capacity === null ? 'No vehicle assigned' : `${boarded} / ${capacity}`;
  }

  protected etaLabel(envelope: TripLiveEnvelope): string {
    if (!envelope.eta) {
      return NOT_RECORDED;
    }
    const time = envelope.eta.next_stop_at
      ? this.datePipe.transform(envelope.eta.next_stop_at, 'shortTime')
      : null;
    return time ? `${time} (est.)` : NOT_RECORDED;
  }

  private toMarker(envelope: TripLiveEnvelope): MapMarker {
    const position = envelope.position!;
    return {
      id: envelope.trip.id,
      label: envelope.trip.vehicle ?? envelope.trip.route,
      latitude: Number(position.latitude),
      longitude: Number(position.longitude),
      // `LivePosition` carries no heading (spec 20 slice 2's envelope
      // never added one) — the marker draws unrotated rather than
      // guessing a direction of travel.
      tone: this.stalenessTone(envelope),
      lastStop: envelope.progress?.last_stop ?? null,
      nextStop: envelope.progress?.next_stop ?? null,
      etaLabel: this.etaLabel(envelope),
      stalenessLabel: this.stalenessLabel(envelope),
      simulated: position.source === 'simulated',
    };
  }
}
