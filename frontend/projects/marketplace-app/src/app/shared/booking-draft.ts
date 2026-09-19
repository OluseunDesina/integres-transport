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

/**
 * Who is actually travelling — docs/specs/22-marketplace.md slice 2.
 * Collected on `seat-picker`, one per seat for a seats-mode booking or
 * a single lead traveler for a places-mode one (the same split
 * `apps.booking.services.create_booking`'s own docstring documents on
 * the backend), and sent as-is in `booking-confirm`'s POST body. Every
 * field is a plain string — including `dateOfBirth` (an ISO date from
 * a native `<input type="date">`) — so an incomplete entry is simply
 * an empty string rather than `undefined`, which is what lets
 * `seat-picker`'s own completeness check compare against `''` rather
 * than threading optionality through every field.
 */
export interface TravelerDetail {
  title: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  gender: string;
  nationality: string;
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
    | { kind: 'seats'; seats: SeatRef[]; travelers: Record<string, TravelerDetail> }
    | { kind: 'places'; passengerCount: number; traveler: TravelerDetail }
  );

export function readSeatPickerRequest(router: Router): SeatPickerRequest | null {
  const state = readNavigationState(router);
  return state && isSeatPickerRequest(state) ? state : null;
}

export function readBookingRequest(router: Router): BookingRequest | null {
  const state = readNavigationState(router);
  return state && isBookingRequest(state) ? state : null;
}

/**
 * The one exception to "this flow never persists anything" — docs/specs/22-marketplace.md
 * slice 2. A guest can reach `seat-picker` with no session at all; the
 * moment they choose to "Book now" is the one point a session is
 * actually required, so that handler navigates to `/login` instead of
 * `/book`, carrying the `BookingRequest` it already had as
 * `{ pendingBooking }` router state rather than losing it. `login`/
 * `register` read it back with this function and forward it to `/book`
 * on success — still router state throughout, never `sessionStorage`,
 * so a passenger who already has a session never takes this path at
 * all and nothing here changes for them.
 */
export function readPendingBooking(router: Router): BookingRequest | null {
  const state = readNavigationState(router);
  if (!isRecord(state)) {
    return null;
  }
  const pending = state['pendingBooking'];
  return isBookingRequest(pending) ? pending : null;
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

function isTravelerDetail(value: unknown): value is TravelerDetail {
  return (
    isRecord(value) &&
    isString(value['title']) &&
    isString(value['firstName']) &&
    isString(value['lastName']) &&
    isString(value['phone']) &&
    isString(value['email']) &&
    isString(value['dateOfBirth']) &&
    isString(value['gender']) &&
    isString(value['nationality'])
  );
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
    return (
      typeof count === 'number' &&
      Number.isInteger(count) &&
      count > 0 &&
      isTravelerDetail(value['traveler'])
    );
  }
  const seats = value['seats'];
  if (value['kind'] !== 'seats' || !Array.isArray(seats) || seats.length === 0 || !seats.every(isSeatRef)) {
    return false;
  }
  const travelers = value['travelers'];
  return isRecord(travelers) && seats.every((seat) => isTravelerDetail(travelers[seat.id]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
