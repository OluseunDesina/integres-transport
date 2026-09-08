import { Injectable, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';

export type ActivityEntry = components['schemas']['ActivityEntry'];

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

interface ActivityState {
  entries: ActivityEntry[];
  initialLoad: boolean;
  error: string | null;
  pollError: string | null;
  pollIntervalSeconds: number;
}

/**
 * `GET /activity/mine/` — docs/specs/20-live-operations.md slice 4.
 *
 * A plain replace-on-poll store, deliberately with none of
 * `LiveOperationsStore`'s `ETag`/`?since=` merge machinery: that exists
 * to save bandwidth polling a whole fleet, and this is one passenger's
 * own small, bounded history — re-fetching it whole every poll is
 * simpler and cheap enough that inventing a delta protocol for it would
 * be complexity with no problem behind it.
 */
@Injectable({ providedIn: 'root' })
export class ActivityStore {
  private readonly api = inject(API_CLIENT);

  private readonly state = signal<ActivityState>({
    entries: [],
    initialLoad: true,
    error: null,
    pollError: null,
    pollIntervalSeconds: 30,
  });

  readonly entries = computed(() => this.state().entries);
  readonly loading = computed(() => this.state().initialLoad);
  readonly error = computed(() => this.state().error);
  readonly pollError = computed(() => this.state().pollError);
  readonly isEmpty = computed(
    () => !this.state().initialLoad && !this.state().error && this.entries().length === 0
  );
  readonly pollIntervalSeconds = computed(() => this.state().pollIntervalSeconds);

  async poll(): Promise<void> {
    const { data, error } = await this.api.GET('/api/v1/activity/mine/', {});

    if (!data) {
      const message = toErrorMessage(error, 'Failed to load your recent activity.');
      this.state.update((s) => ({
        ...s,
        initialLoad: false,
        error: s.entries.length === 0 ? message : s.error,
        pollError: s.entries.length > 0 ? message : null,
      }));
      return;
    }

    this.state.set({
      entries: data.results,
      initialLoad: false,
      error: null,
      pollError: null,
      pollIntervalSeconds: data.poll_interval_seconds,
    });
  }
}
