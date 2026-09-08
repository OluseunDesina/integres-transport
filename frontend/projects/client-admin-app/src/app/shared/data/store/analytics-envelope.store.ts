import { computed, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';

/**
 * Query shape shared by the payments-summary and revenue endpoints.
 * `granularity` is only meaningful to the ones that bucket a trend.
 */
export interface AnalyticsQuery {
  business?: string;
  route?: string;
  trip_class?: string;
  date_from?: string;
  date_to?: string;
  status?: string;
  channel?: string;
  granularity?: 'day' | 'week' | 'month';
}

/**
 * Base for the non-paginated analytics stores — spec 16.
 *
 * **Not `ListStore`**, deliberately, and the spec says so: these are
 * single envelopes, not collections, and forcing them into
 * `items`/`total`/`page` would be abstraction theatre. The shape they do
 * share is a loading/error/data trio plus one thing that is easy to
 * forget and expensive to omit — see `latestRequest`.
 *
 * Written once here after `AdminDashboardStore` proved the shape in
 * slice 3; that store keeps its own copy because it is the only one with
 * a hand-written envelope type, and a third repetition is where a
 * divergence starts.
 */
export abstract class AnalyticsEnvelopeStore<T> {
  protected readonly api = inject(API_CLIENT);

  private readonly state = signal<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: false,
    error: null,
  });

  readonly data = computed(() => this.state().data);
  readonly loading = computed(() => this.state().loading);
  readonly error = computed(() => this.state().error);

  /**
   * Which request the screen is waiting on. **Only the newest response
   * may write.**
   *
   * Adjusting two filters in quick succession issues two overlapping
   * requests and they do not return in order — a validation 400 is
   * answered almost immediately while a real aggregation takes as long
   * as it takes. Sent A then B, the screen could show A's answer under
   * B's filters, with the period line quietly disagreeing with the date
   * fields above it. That was a real bug on the dashboard in slice 3,
   * found by Playwright rather than by reasoning.
   */
  private latestRequest = 0;

  protected abstract fetch(query: AnalyticsQuery): Promise<{ data?: T; error?: unknown }>;

  protected abstract fallbackMessage(): string;

  async load(query: AnalyticsQuery): Promise<void> {
    const request = ++this.latestRequest;
    this.state.update((s) => ({ ...s, loading: true, error: null }));
    const { data, error } = await this.fetch(query);
    if (request !== this.latestRequest) {
      // A newer request owns the state, `loading` included — it must
      // stay true until that one settles.
      return;
    }
    if (!data) {
      // The previous envelope is cleared rather than left under an error
      // banner: a stale total beside "this range is too long" reads as
      // the answer to the question just asked.
      this.state.set({
        data: null,
        loading: false,
        error: toErrorMessage(error, this.fallbackMessage()),
      });
      return;
    }
    this.state.set({ data, loading: false, error: null });
  }
}

/**
 * The message the operator can act on, out of whichever shape the
 * backend used.
 *
 * Every 400 these endpoints answer comes from
 * `AnalyticsFilterSerializer` and is **field-keyed** —
 * `{"granularity": ["… Use granularity=week for a longer range."]}` —
 * not the `{"detail": …}` a permission failure uses. Reading `detail`
 * alone flattens a message naming the exact fix into a generic failure,
 * which is a bug slice 3 shipped once already.
 */
export function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const body = error as Record<string, unknown>;
    for (const value of [body['detail'], ...Object.values(body)]) {
      if (typeof value === 'string' && value) {
        return value;
      }
      if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) {
        return value[0];
      }
    }
  }
  return fallback;
}
