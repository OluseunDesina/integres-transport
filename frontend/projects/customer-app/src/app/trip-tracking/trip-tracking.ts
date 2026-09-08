import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Poller } from '@shared-data';
import { Alert, EmptyState, PageHeader, Skeleton, UiMap, type MapMarker } from '@shared-ui';

import { TripTrackingStore, type TripLiveEnvelope } from '../shared/data/store/trip-tracking.store';

const UNKNOWN = 'Unknown';

/**
 * Passenger vehicle tracking — docs/specs/20-live-operations.md slice 4,
 * the "passenger-facing vehicle tracking with estimated arrival" half of
 * doc 1's brief. Reachable from a "Track this trip" row action on
 * `my-bookings` (any paid or completed booking — `GET /trips/{id}/live/`
 * itself has no status gate, so this is reachable before departure too,
 * showing "No signal yet" rather than an error), never from the nav
 * bar: it needs a trip id, so it is contextual the same way
 * `/my-bookings/:id/tickets` is.
 *
 * Reuses `ui-map` with a single marker rather than inventing a
 * one-vehicle variant — the same primitive `client-admin-app`'s
 * live-operations board uses, so a white-labelled tenant's brand colour
 * follows through here too.
 *
 * **Occupancy and open-incidents are deliberately not shown.** Both are
 * in the envelope, but neither answers a question a passenger riding
 * their own trip is asking — occupancy is an operator's capacity
 * concern, not "where is my bus" — so this screen surfaces route,
 * vehicle, last update, progress and ETA only.
 */
@Component({
  selector: 'app-trip-tracking',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Alert, EmptyState, PageHeader, Skeleton, UiMap],
  // `DatePipe` is used programmatically (`etaLabel` below), not from the
  // template, so it needs an explicit provider rather than an `imports`
  // entry — the latter only registers it for template pipe syntax.
  providers: [DatePipe],
  templateUrl: './trip-tracking.html',
})
export class TripTracking implements OnInit, OnDestroy {
  protected readonly store = inject(TripTrackingStore);
  private readonly route = inject(ActivatedRoute);
  private readonly datePipe = inject(DatePipe);

  private readonly tripId = this.route.snapshot.paramMap.get('id') ?? '';

  protected readonly mapMarkers = computed<MapMarker[]>(() => {
    const envelope = this.store.data();
    if (!envelope?.position) {
      return [];
    }
    return [this.toMarker(envelope)];
  });

  private readonly poller = new Poller(() => this.store.poll(this.tripId), 15_000);

  constructor() {
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

  protected readonly notRecorded = UNKNOWN;

  protected stalenessLabel(envelope: TripLiveEnvelope): string {
    if (!envelope.position) {
      return 'No signal yet';
    }
    const seconds = envelope.position.staleness_seconds;
    return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
  }

  protected etaLabel(envelope: TripLiveEnvelope): string {
    if (!envelope.eta) {
      return UNKNOWN;
    }
    const time = envelope.eta.next_stop_at
      ? this.datePipe.transform(envelope.eta.next_stop_at, 'shortTime')
      : null;
    return time ? `${time} (estimated)` : UNKNOWN;
  }

  private toMarker(envelope: TripLiveEnvelope): MapMarker {
    const position = envelope.position!;
    return {
      id: envelope.trip.id,
      label: envelope.trip.vehicle ?? envelope.trip.route,
      latitude: Number(position.latitude),
      longitude: Number(position.longitude),
      lastStop: envelope.progress?.last_stop ?? null,
      nextStop: envelope.progress?.next_stop ?? null,
      etaLabel: this.etaLabel(envelope),
      stalenessLabel: this.stalenessLabel(envelope),
      simulated: position.source === 'simulated',
    };
  }
}
