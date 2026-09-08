import { Injectable, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';

export type Dashboard = components['schemas']['Dashboard'];
export type Granularity = 'day' | 'week' | 'month';

export interface DashboardQuery {
  business?: string;
  date_from?: string;
  date_to?: string;
  granularity?: Granularity;
}

/**
 * The message the operator actually needs, out of whichever shape the
 * backend used.
 *
 * Every 400 this screen can provoke comes from
 * `AnalyticsFilterSerializer`, so it is **field-keyed** —
 * `{"date_from": ["date_from must not be after date_to."]}`,
 * `{"granularity": ["A day trend covers at most 92 days; …"]}` — not the
 * `{"detail": …}` shape a permission or typed-exception failure uses.
 * Both are handled: this store originally read `detail` alone, which was
 * a guess, and a live call against a 97-day range showed it flattening a
 * message naming the exact fix ("use granularity=week") into a generic
 * "failed to load". Every one of these is something the operator can
 * correct from the filter bar, which is the whole reason it has to reach
 * them verbatim.
 */
function toErrorMessage(error: unknown): string {
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
  return 'Failed to load the dashboard.';
}

/**
 * `GET /analytics/dashboard/` — spec 16 slice 3.
 *
 * **Not a `ListStore`**, deliberately, and the spec says so: this is one
 * envelope, not a paginated collection, and forcing it into
 * `items`/`total`/`page` would be abstraction theatre. The
 * loading/error/data signal trio is the whole shape it needs.
 *
 * **One request, not fifteen.** Every count, total, trend and recent
 * row on the dashboard comes out of this single call — which is the
 * point of the envelope, and the reason none of these numbers is
 * derived in the browser. `CLAUDE.md` records four separate production
 * bugs from "fetch a bounded page, then reduce locally"; a dashboard
 * doing it would be that class of bug at its most plausible-looking.
 */
@Injectable({ providedIn: 'root' })
export class AdminDashboardStore {
  private readonly api = inject(API_CLIENT);

  private readonly state = signal<{
    data: Dashboard | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: false, error: null });

  readonly data = computed(() => this.state().data);
  readonly loading = computed(() => this.state().loading);
  readonly error = computed(() => this.state().error);

  /**
   * Which request the screen is currently waiting on.
   *
   * **Only the newest response is allowed to write.** Adjusting two
   * filters in quick succession issues two overlapping requests, and
   * they do not come back in order — a 400 is answered almost
   * immediately while a real aggregation takes as long as it takes. Sent
   * A then B, the screen could end up showing A's answer under B's
   * filters: found live, where typing a reversed date range rendered a
   * *successful* dashboard for the previous range with no error at all,
   * and the period line quietly disagreed with the two date fields above
   * it. On a screen whose entire job is to be trusted, that is the worst
   * available failure.
   */
  private latestRequest = 0;

  async load(query: DashboardQuery): Promise<void> {
    const request = ++this.latestRequest;
    this.state.update((s) => ({ ...s, loading: true, error: null }));
    const { data, error } = await this.api.GET('/api/v1/analytics/dashboard/', {
      params: {
        query: {
          business: query.business,
          date_from: query.date_from,
          date_to: query.date_to,
          granularity: query.granularity,
        },
      },
    });
    if (request !== this.latestRequest) {
      // A newer request is in flight; it owns the state, including
      // `loading`, which must stay true until *it* settles.
      return;
    }
    if (!data) {
      // The previous envelope is cleared rather than left on screen
      // under an error banner: a stale total beside "this range is too
      // long" reads as the answer to the question just asked.
      this.state.set({ data: null, loading: false, error: toErrorMessage(error) });
      return;
    }
    this.state.set({ data, loading: false, error: null });
  }
}
