import { Injectable, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';

import { toErrorMessage } from './analytics-envelope.store';

export type Passenger = components['schemas']['Passenger'];
export type StaffBooking = components['schemas']['StaffBooking'];
export type TripBookability = components['schemas']['TripBookability'];
export type SeatAvailability = components['schemas']['SeatAvailability'];

export interface SeatRequest {
  seat: string;
  from_stop: string;
  to_stop: string;
}

export interface CounterBookingRequest {
  trip: string;
  passenger: string;
  seats?: SeatRequest[];
  passenger_count?: number;
  from_stop?: string;
  to_stop?: string;
  pay_from_wallet: boolean;
}

/**
 * The counter-booking flow's three server calls —
 * docs/specs/18-manifest-and-staff-booking.md slice 2.
 *
 * One store rather than three, because the three are one act: an agent
 * resolves a passenger, sees what is bookable on a trip, and books.
 * Splitting them would make the screen own the sequencing, which is
 * where a half-completed booking would come from.
 *
 * **`lookupError` is not `error`.** "No passenger with that address" is
 * an ordinary answer to an ordinary question — the person standing
 * there has probably never registered — and rendering it in the same
 * red box as "the server broke" would tell an agent to give up rather
 * than to ask them to sign up.
 */
@Injectable({ providedIn: 'root' })
export class CounterBookingStore {
  private readonly api = inject(API_CLIENT);

  private readonly state = signal<{
    passenger: Passenger | null;
    lookupError: string | null;
    lookingUp: boolean;
    bookability: TripBookability | null;
    bookabilityError: string | null;
    loadingSeats: boolean;
    result: StaffBooking | null;
    submitting: boolean;
  }>({
    passenger: null,
    lookupError: null,
    lookingUp: false,
    bookability: null,
    bookabilityError: null,
    loadingSeats: false,
    result: null,
    submitting: false,
  });

  readonly passenger = computed(() => this.state().passenger);
  readonly lookupError = computed(() => this.state().lookupError);
  readonly lookingUp = computed(() => this.state().lookingUp);
  readonly bookability = computed(() => this.state().bookability);
  readonly bookabilityError = computed(() => this.state().bookabilityError);
  readonly loadingSeats = computed(() => this.state().loadingSeats);
  readonly result = computed(() => this.state().result);
  readonly submitting = computed(() => this.state().submitting);

  /** Free seats only, sorted the way a person reads seat numbers —
   * `numeric: true`, or 10A sorts before 2A. */
  readonly availableSeats = computed<SeatAvailability[]>(() => {
    const seats = this.state().bookability?.seats ?? [];
    return [...seats]
      .filter((entry) => entry.is_available)
      .sort((a, b) =>
        a.seat.seat_number.localeCompare(b.seat.seat_number, undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      );
  });

  async lookup(email: string): Promise<void> {
    this.state.update((s) => ({
      ...s,
      lookingUp: true,
      lookupError: null,
      passenger: null,
      result: null,
    }));
    const { data, error, response } = await this.api.GET('/api/v1/passengers/lookup/', {
      params: { query: { email } },
    });
    if (!data) {
      this.state.update((s) => ({
        ...s,
        lookingUp: false,
        lookupError:
          response?.status === 404
            ? 'No passenger account uses that email address. They need to register before you can book for them.'
            : toErrorMessage(error, 'Could not look that passenger up.'),
      }));
      return;
    }
    this.state.update((s) => ({ ...s, lookingUp: false, passenger: data, lookupError: null }));
  }

  /** Clears the resolved passenger — the agent is serving someone else
   * now, and a stale name beside a new booking is how the wrong person
   * gets charged. */
  clearPassenger(): void {
    this.state.update((s) => ({ ...s, passenger: null, lookupError: null, result: null }));
  }

  async loadBookability(tripId: string, fromStop: string, toStop: string): Promise<void> {
    this.state.update((s) => ({
      ...s,
      loadingSeats: true,
      bookability: null,
      bookabilityError: null,
    }));
    const { data, error } = await this.api.GET('/api/v1/trips/{id}/availability/', {
      params: { path: { id: tripId }, query: { from_stop: fromStop, to_stop: toStop } },
    });
    if (!data) {
      this.state.update((s) => ({
        ...s,
        loadingSeats: false,
        bookabilityError: toErrorMessage(error, 'Could not load this trip’s availability.'),
      }));
      return;
    }
    this.state.update((s) => ({ ...s, loadingSeats: false, bookability: data }));
  }

  clearBookability(): void {
    this.state.update((s) => ({ ...s, bookability: null, bookabilityError: null }));
  }

  /**
   * A fresh `Idempotency-Key` per submission attempt is **wrong** here
   * and is deliberately not what this does: the key is generated once
   * per assembled booking and reused across retries, which is the only
   * way a network failure that actually reached the server does not
   * become two held seats.
   */
  async book(
    request: CounterBookingRequest,
    idempotencyKey: string
  ): Promise<{ ok: boolean; error: unknown }> {
    this.state.update((s) => ({ ...s, submitting: true, result: null }));
    const { data, error } = await this.api.POST('/api/v1/bookings/staff/', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: request as never,
    });
    if (!data) {
      this.state.update((s) => ({ ...s, submitting: false }));
      // The raw body, not a message: the screen distributes DRF's
      // `{field: [...]}` across its controls with `applyServerErrors`,
      // and flattening it here would discard which field each
      // complaint belonged to — the exact loss that helper exists to
      // stop.
      return { ok: false, error };
    }
    this.state.update((s) => ({ ...s, submitting: false, result: data }));
    return { ok: true, error: null };
  }

  /** Everything except the resolved passenger: an agent booking a
   * second leg for the same person should not have to type their
   * address again. */
  resetBooking(): void {
    this.state.update((s) => ({
      ...s,
      bookability: null,
      bookabilityError: null,
      result: null,
    }));
  }
}
