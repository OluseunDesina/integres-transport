import { Injectable, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';

import { toErrorMessage } from './analytics-envelope.store';

export type TripPerformance = components['schemas']['TripPerformance'];

/**
 * `GET /analytics/trips/{id}/performance/`.
 *
 * Not an `AnalyticsEnvelopeStore`: this one is addressed by a path
 * parameter and takes no filter set at all, so it shares none of that
 * base's query handling. It keeps the same loading/error/data trio, and
 * distinguishes **not found** from a failure — a bookmarked link to a
 * deleted trip is an ordinary thing to happen and reads very differently
 * from "the server broke".
 */
@Injectable({ providedIn: 'root' })
export class TripPerformanceStore {
  private readonly api = inject(API_CLIENT);

  private readonly state = signal<{
    data: TripPerformance | null;
    loading: boolean;
    error: string | null;
    notFound: boolean;
  }>({ data: null, loading: false, error: null, notFound: false });

  readonly data = computed(() => this.state().data);
  readonly loading = computed(() => this.state().loading);
  readonly error = computed(() => this.state().error);
  readonly notFound = computed(() => this.state().notFound);

  async load(tripId: string): Promise<void> {
    this.state.set({ data: null, loading: true, error: null, notFound: false });
    const { data, error, response } = await this.api.GET(
      '/api/v1/analytics/trips/{id}/performance/',
      { params: { path: { id: tripId } } }
    );
    if (!data) {
      this.state.set({
        data: null,
        loading: false,
        notFound: response?.status === 404,
        error: response?.status === 404 ? null : toErrorMessage(error, 'Failed to load this trip.'),
      });
      return;
    }
    this.state.set({ data, loading: false, error: null, notFound: false });
  }
}
