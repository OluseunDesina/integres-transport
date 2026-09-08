import { Injectable, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';

import { toErrorMessage } from './analytics-envelope.store';

export type TripManifest = components['schemas']['TripManifest'];
export type ManifestRow = components['schemas']['ManifestRow'];
export type ManifestPrepaidRow = components['schemas']['ManifestPrepaidRow'];
export type ManifestJourneyRow = components['schemas']['ManifestJourneyRow'];

const PAGE_SIZE = 50;

/**
 * `GET /trips/{id}/manifest/` — docs/specs/18-manifest-and-staff-booking.md
 * slice 1.
 *
 * **Not a `ListStore`.** That base models a bare `{count, results}`
 * list, and this response is an envelope: `trip`, `kind` and `totals`
 * sit beside `results` and are counted over the whole trip rather than
 * the current page. Shaped after `TripPerformanceStore` instead, which
 * is the other path-addressed envelope in this app — including its
 * distinction between **not found** and a failure, since a bookmarked
 * link to a deleted trip is an ordinary thing to happen and reads very
 * differently from "the server broke".
 *
 * `kind` is the discriminator: a pay-as-you-go trip sells no bookings
 * and issues no tickets, so its rows are `ManifestJourneyRow` and a
 * consumer must branch rather than assume. `isPrepaid`/`isJourney`
 * below are that branch, written once.
 *
 * 50 a page, not 25. A manifest is read as a list of everyone aboard,
 * and a 44-seat coach paging twice would be an odd way to answer "who
 * is on this bus".
 */
@Injectable({ providedIn: 'root' })
export class ManifestStore {
  private readonly api = inject(API_CLIENT);

  private readonly state = signal<{
    data: TripManifest | null;
    tripId: string | null;
    offset: number;
    includeCancelled: boolean;
    loading: boolean;
    error: string | null;
    notFound: boolean;
  }>({
    data: null,
    tripId: null,
    offset: 0,
    includeCancelled: false,
    loading: false,
    error: null,
    notFound: false,
  });

  readonly data = computed(() => this.state().data);
  readonly loading = computed(() => this.state().loading);
  readonly error = computed(() => this.state().error);
  readonly notFound = computed(() => this.state().notFound);
  readonly includeCancelled = computed(() => this.state().includeCancelled);
  readonly page = computed(() => ({ limit: PAGE_SIZE, offset: this.state().offset }));
  readonly total = computed(() => this.state().data?.count ?? 0);
  readonly rows = computed<readonly ManifestRow[]>(() => this.state().data?.results ?? []);

  /** Empty **and** settled — not merely "no rows yet". Distinguishing
   * the two is what keeps a loading skeleton from reading as an empty
   * bus. */
  readonly isEmpty = computed(
    () => !this.state().loading && this.state().data !== null && this.rows().length === 0
  );

  async load(tripId: string): Promise<void> {
    this.state.update((s) => ({ ...s, tripId, offset: 0 }));
    await this.fetch();
  }

  async changePage(offset: number): Promise<void> {
    this.state.update((s) => ({ ...s, offset }));
    await this.fetch();
  }

  /** Back to the first page, deliberately: widening the set while
   * sitting on page 3 would show a different page 3. */
  async setIncludeCancelled(includeCancelled: boolean): Promise<void> {
    this.state.update((s) => ({ ...s, includeCancelled, offset: 0 }));
    await this.fetch();
  }

  private async fetch(): Promise<void> {
    const { tripId, offset, includeCancelled } = this.state();
    if (!tripId) {
      return;
    }
    this.state.update((s) => ({ ...s, loading: true, error: null, notFound: false }));

    const { data, error, response } = await this.api.GET('/api/v1/trips/{id}/manifest/', {
      params: {
        path: { id: tripId },
        // Absent when off, never `false`. The server reads
        // `?include_cancelled=false` as a filter rather than as the
        // absence of one — the recorded rule for boolean query params.
        query: includeCancelled ? { include_cancelled: true, limit: PAGE_SIZE, offset } : {
          limit: PAGE_SIZE,
          offset,
        },
      },
    });

    if (!data) {
      this.state.update((s) => ({
        ...s,
        data: null,
        loading: false,
        notFound: response?.status === 404,
        error:
          response?.status === 404
            ? null
            : toErrorMessage(error, 'Failed to load this trip’s manifest.'),
      }));
      return;
    }
    this.state.update((s) => ({ ...s, data, loading: false, error: null, notFound: false }));
  }
}

/** The `kind` branch, written once. A row's shape is decided by the
 * envelope, never guessed from which keys happen to be present. */
export function isJourneyManifest(manifest: TripManifest | null): boolean {
  return manifest?.kind === 'pay_as_you_go';
}

export function asPrepaidRow(row: ManifestRow): ManifestPrepaidRow {
  return row as ManifestPrepaidRow;
}

export function asJourneyRow(row: ManifestRow): ManifestJourneyRow {
  return row as ManifestJourneyRow;
}
