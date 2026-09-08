import type { Router } from '@angular/router';

/**
 * The booking flow is three screens deep (search → seats → confirm) and
 * each step needs what the previous one selected. Per
 * docs/specs/4-fares-seating-booking-frontend.md §4.3 that selection
 * travels in **router state**, not re-fetched and not held in an
 * app-wide store: it is short-lived, single-flow data, and a store would
 * outlive the flow and need explicit invalidation on every exit path.
 *
 * Angular writes `navigate(..., { state })` through to `history.state`,
 * so these readers fall back to it — that keeps the flow working across
 * a page refresh mid-booking, where `getCurrentNavigation()` is already
 * gone. Nothing here is trusted for correctness: ids are re-validated
 * server-side on every subsequent request, and seat availability is
 * always refetched rather than carried forward.
 *
 * Each reader returns `null` when state is absent or malformed (a
 * passenger who deep-links straight to `/search/seats`); every consumer
 * treats that as "start over" and redirects to the search screen.
 */

export interface StopRef {
  id: string;
  name: string;
}

export interface SeatRef {
  id: string;
  seatNumber: string;
}

/** What `trip-search` hands to `seat-picker`. */
export interface SeatPickerRequest {
  tripId: string;
  routeName: string;
  serviceDate: string;
  scheduledDepartureAt: string;
  fromStop: StopRef;
  toStop: StopRef;
  /**
   * The service class this departure runs as
   * (docs/specs/15-trip-classes.md).
   *
   * **Optional, and it has to stay optional.** These guards run against
   * `history.state`, so a passenger who is mid-flow when a new build
   * ships is carrying a state object written by the old one. A required
   * field would fail `isSeatPickerRequest` and bounce them back to
   * search with a half-made booking behind them — for a label.
   *
   * `seat-picker` shows the class from the freshly-fetched availability
   * envelope rather than from this, per the note above about nothing
   * here being trusted for correctness. This exists so the search
   * screen's own result card and the confirm screen agree with it.
   */
  tripClass?: string;
  /** Set only when `booking-confirm` bounces the passenger back here
   * after a seat conflict, so the seat map can say why their previous
   * selection is gone. */
  notice?: string;
}

/**
 * What `seat-picker` hands to `booking-confirm`.
 *
 * A discriminated union rather than one shape with optional halves —
 * docs/specs/10-booking-modes.md. There are two genuinely different
 * things a passenger can buy: named seats they chose, or a number of
 * places (open seating, or reservation mode with seat choice turned
 * off). Modelling that as `seats?` plus `passengerCount?` would make
 * "both" and "neither" representable, and `booking-confirm` sends a
 * *different request body* for each — the one place where getting it
 * wrong books the wrong thing.
 */
export type BookingRequest = SeatPickerRequest & {
  farePerSeat: string;
  currency: string;
} & (
    | { kind: 'seats'; seats: SeatRef[] }
    | { kind: 'places'; passengerCount: number }
  );

export function readSeatPickerRequest(router: Router): SeatPickerRequest | null {
  const state = readNavigationState(router);
  return state && isSeatPickerRequest(state) ? state : null;
}

export function readBookingRequest(router: Router): BookingRequest | null {
  const state = readNavigationState(router);
  return state && isBookingRequest(state) ? state : null;
}

function readNavigationState(router: Router): unknown {
  const fromNavigation = router.getCurrentNavigation()?.extras.state;
  if (fromNavigation) {
    return fromNavigation;
  }
  return typeof history === 'undefined' ? null : history.state;
}

function isStopRef(value: unknown): value is StopRef {
  return isRecord(value) && isString(value['id']) && isString(value['name']);
}

function isSeatRef(value: unknown): value is SeatRef {
  return isRecord(value) && isString(value['id']) && isString(value['seatNumber']);
}

function isSeatPickerRequest(value: unknown): value is SeatPickerRequest {
  if (!isRecord(value)) {
    return false;
  }
  const notice = value['notice'];
  const tripClass = value['tripClass'];
  return (
    isString(value['tripId']) &&
    isString(value['routeName']) &&
    isString(value['serviceDate']) &&
    isString(value['scheduledDepartureAt']) &&
    isStopRef(value['fromStop']) &&
    isStopRef(value['toStop']) &&
    (tripClass === undefined || isString(tripClass)) &&
    (notice === undefined || isString(notice))
  );
}

function isBookingRequest(value: unknown): value is BookingRequest {
  if (!isSeatPickerRequest(value) || !isRecord(value)) {
    return false;
  }
  if (!isString(value['farePerSeat']) || !isString(value['currency'])) {
    return false;
  }
  if (value['kind'] === 'places') {
    const count = value['passengerCount'];
    return typeof count === 'number' && Number.isInteger(count) && count > 0;
  }
  const seats = value['seats'];
  return value['kind'] === 'seats' && Array.isArray(seats) && seats.length > 0 && seats.every(isSeatRef);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
