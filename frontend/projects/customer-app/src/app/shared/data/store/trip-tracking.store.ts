import { Injectable, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';

export type TripLiveEnvelope = components['schemas']['TripLiveEnvelope'];

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

interface TripTrackingState {
  data: TripLiveEnvelope | null;
  initialLoad: boolean;
  notFound: boolean;
  error: string | null;
  pollError: string | null;
  pollIntervalSeconds: number;
}

/**
 * `GET /trips/{id}/live/` for the passenger tracking screen —
 * docs/specs/20-live-operations.md slice 4.
 *
 * Deliberately simpler than `client-admin-app`'s `LiveOperationsStore`:
 * that one merges a fleet-wide `?since=` delta into an id-keyed map,
 * which exists to save bandwidth polling *many* trips. This tracks
 * exactly one, so every poll just replaces `data` outright — but keeps
 * the same `error` (replaces) vs `pollError` (does not) split, because
 * a passenger watching their bus is exactly the audience a momentary
 * network hiccup should not blank the screen for: the last known
 * position stays up, with a small notice above it, until the next
 * successful poll.
 *
 * `notFound` mirrors `ManifestStore`'s own distinction: a bookmarked
 * link to a trip the passenger holds no ticket on is a `404`, an
 * ordinary thing to happen, and reads nothing like a failure.
 */
@Injectable({ providedIn: 'root' })
export class TripTrackingStore {
  private readonly api = inject(API_CLIENT);

  private readonly state = signal<TripTrackingState>({
    data: null,
    initialLoad: true,
    notFound: false,
    error: null,
    pollError: null,
    // `GET /trips/{id}/live/`'s envelope carries no interval of its
    // own — adding one would mean repeating it on every row of
    // `GET /trips/live/` too, since both endpoints share
    // `TripLiveEnvelopeSerializer`. A fixed client-side interval,
    // deliberately wider than the fleet board's default: a passenger
    // watching one vehicle on a phone is a different bandwidth/battery
    // budget than an operator's console.
    pollIntervalSeconds: 15,
  });

  readonly data = computed(() => this.state().data);
  readonly loading = computed(() => this.state().initialLoad);
  readonly notFound = computed(() => this.state().notFound);
  readonly error = computed(() => this.state().error);
  readonly pollError = computed(() => this.state().pollError);
  readonly pollIntervalSeconds = computed(() => this.state().pollIntervalSeconds);

  async poll(tripId: string): Promise<void> {
    const { data, error, response } = await this.api.GET('/api/v1/trips/{id}/live/', {
      params: { path: { id: tripId } },
    });

    if (!data) {
      if (response?.status === 404) {
        this.state.update((s) => ({
          ...s,
          initialLoad: false,
          notFound: true,
          data: null,
          error: null,
          pollError: null,
        }));
        return;
      }
      const message = toErrorMessage(error, 'Failed to load this trip’s live position.');
      this.state.update((s) => ({
        ...s,
        initialLoad: false,
        error: s.data === null ? message : s.error,
        pollError: s.data !== null ? message : null,
      }));
      return;
    }

    this.state.update((s) => ({
      ...s,
      data,
      initialLoad: false,
      notFound: false,
      error: null,
      pollError: null,
    }));
  }
}
