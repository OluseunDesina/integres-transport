import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';

export type Trip = components['schemas']['Trip'];
export type TapEvent = components['schemas']['TapEvent'];
export type TapType = components['schemas']['TapTypeEnum'];

export interface RouteStopOption {
  id: string;
  name: string;
  sequence: number;
}

export type RecordTapResult =
  | { ok: true; data: TapEvent }
  | { ok: false; status: number; message: string };

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

/**
 * Everything the validator screen needs from the API — see
 * docs/specs/4b-tap-and-go.md's "Operator harness" section. Kept as one
 * small service co-located with its single consumer (`RecordTap`),
 * matching `apps/client-admin-app`'s precedent for a narrow,
 * single-screen options fetcher (e.g. `business-options.service.ts`)
 * rather than a full `ListStore` — this screen has no paginated table
 * to drive, just two dropdowns and a submit action.
 */
@Injectable({ providedIn: 'root' })
export class RecordTapService {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  private authHeader(): { Authorization: string } {
    return { Authorization: `Bearer ${this.authStore.accessToken()}` };
  }

  /**
   * Every trip open for tapping on `serviceDate`, in **both** fare
   * collection modes. `TripListQuerySerializer.status` only accepts one
   * value per request, so `scheduled` and `in_progress` are fetched
   * separately and merged. A generous `limit` accepts the same
   * "unpaginated picker" tradeoff CLAUDE.md already documents for other
   * pickers in this codebase.
   *
   * **No `fare_collection_mode` filter any more.** A tap credential is
   * universal fare media as of docs/specs/10-booking-modes.md — on a
   * pay-as-you-go trip it opens or closes a journey, on a prepaid one it
   * boards the ticket the passenger already holds. Filtering either mode
   * out of this picker would make one of those unreachable; the screen
   * branches on the *selected* trip's mode instead.
   */
  async loadTripsForDate(serviceDate: string): Promise<Trip[]> {
    const headers = this.authHeader();
    const [scheduled, inProgress] = await Promise.all([
      this.api.GET('/api/v1/trips/', {
        params: { query: { service_date: serviceDate, status: 'scheduled', limit: 100 } },
        headers,
      }),
      this.api.GET('/api/v1/trips/', {
        params: { query: { service_date: serviceDate, status: 'in_progress', limit: 100 } },
        headers,
      }),
    ]);
    const trips = [...(scheduled.data?.results ?? []), ...(inProgress.data?.results ?? [])];
    return trips.sort((a, b) =>
      a.scheduled_departure_at.localeCompare(b.scheduled_departure_at)
    );
  }

  /**
   * A trip's route, stops in route order. `RouteSerializer.stops` is
   * already `.order_by("sequence")` server-side
   * (`apps/network/serializers.py`), so no re-sort is needed here.
   * There's no single-route GET (`RouteUpdateView` is PATCH-only) — this
   * reuses the existing `network.view`-gated list endpoint every default
   * Manager/Staff role that can reach `tapngo.record` already has access
   * to (both are granted together in `DEFAULT_ROLE_PERMISSIONS`).
   */
  async loadRouteStops(businessId: string, routeId: string): Promise<RouteStopOption[]> {
    const { data } = await this.api.GET('/api/v1/routes/', {
      params: { query: { business: businessId, limit: 100 } },
      headers: this.authHeader(),
    });
    const route = data?.results.find((candidate) => candidate.id === routeId);
    return (route?.stops ?? []).map((stop) => ({
      id: stop.id,
      name: stop.name,
      sequence: stop.sequence,
    }));
  }

  /** A fresh `Idempotency-Key` per submit (not per screen visit, unlike
   * `booking-confirm`'s one-per-visit key) — each tap is its own
   * deliberate action a conductor takes once per physical event, not a
   * single form resubmitted after a timeout. */
  async recordTap(params: {
    tripId: string;
    token: string;
    tapType: TapType;
    stopId: string;
  }): Promise<RecordTapResult> {
    const { data, error, response } = await this.api.POST('/api/v1/trips/{trip_id}/taps/', {
      params: {
        path: { trip_id: params.tripId },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body: { token: params.token, tap_type: params.tapType, stop_id: params.stopId },
      headers: this.authHeader(),
    });
    if (data) {
      return { ok: true, data };
    }
    return {
      ok: false,
      status: response?.status ?? 0,
      message: toErrorMessage(error, 'Could not record this tap. Try again.'),
    };
  }
}
