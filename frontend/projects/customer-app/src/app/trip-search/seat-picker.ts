import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, EmptyState } from '@shared-ui';

import type { BookingRequest, SeatPickerRequest } from '../shared/booking-draft';
import { readSeatPickerRequest } from '../shared/booking-draft';
import { formatMoney, multiplyDecimal } from '../shared/money';

type SeatAvailability = components['schemas']['SeatAvailability'];

interface SeatRow {
  row: number | null;
  seats: SeatAvailability[];
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

/**
 * Seat map for one Trip segment —
 * docs/specs/4-fares-seating-booking-frontend.md §4.3. Net-new
 * component: no seat-grid primitive exists anywhere in `shared-ui` or
 * any app, and per §4.4 this deliberately stays customer-app-local
 * rather than being promoted, since client-admin's own seat management
 * is a bulk-replace form with no map view.
 *
 * Availability is always fetched here, never carried forward from the
 * search screen — it is the most volatile thing in the flow, and a
 * segment-aware availability query (`?from_stop=&to_stop=`) is the only
 * thing that knows whether seat 4A is free for *this* leg range.
 *
 * Two states are load-bearing rather than incidental:
 * - a Trip with no Vehicle assigned returns an empty seat list (not an
 *   error) — shown as an empty state, per §5.
 * - an unpriced segment 404s on the fare endpoint — shown as a blocking
 *   alert *before* any seat is selectable, so a passenger never picks
 *   seats for a trip that cannot be priced.
 */
@Component({
  selector: 'app-seat-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Alert, Button, EmptyState],
  templateUrl: './seat-picker.html',
})
export class SeatPicker implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly request = signal<SeatPickerRequest | null>(readSeatPickerRequest(this.router));

  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly fareError = signal<string | null>(null);

  private readonly availability = signal<SeatAvailability[]>([]);
  private readonly farePerSeat = signal<string | null>(null);
  protected readonly currency = signal('');

  protected readonly selectedSeatIds = signal<ReadonlySet<string>>(new Set());

  protected readonly hasSeats = computed(() => this.availability().length > 0);

  /**
   * Groups seats into rows when the VehicleType defines `row`/`column`
   * geometry, and falls back to a single wrapped row of seat numbers
   * when it doesn't — both are valid per the backend's own seat-map
   * non-goal, so neither can be treated as the broken case.
   */
  protected readonly seatRows = computed<SeatRow[]>(() => {
    const seats = this.availability();
    if (seats.every((entry) => entry.seat.row === null)) {
      return [{ row: null, seats }];
    }
    const byRow = new Map<number | null, SeatAvailability[]>();
    for (const entry of seats) {
      const key = entry.seat.row;
      byRow.set(key, [...(byRow.get(key) ?? []), entry]);
    }
    return [...byRow.entries()]
      .sort((a, b) => (a[0] ?? Number.MAX_SAFE_INTEGER) - (b[0] ?? Number.MAX_SAFE_INTEGER))
      .map(([row, rowSeats]) => ({
        row,
        seats: [...rowSeats].sort(
          (a, b) => (a.seat.column ?? 0) - (b.seat.column ?? 0)
        ),
      }));
  });

  protected readonly selectedCount = computed(() => this.selectedSeatIds().size);

  protected readonly totalLabel = computed(() => {
    const fare = this.farePerSeat();
    if (fare === null) {
      return null;
    }
    return formatMoney(multiplyDecimal(fare, this.selectedCount()), this.currency());
  });

  protected readonly fareLabel = computed(() => {
    const fare = this.farePerSeat();
    return fare === null ? null : formatMoney(fare, this.currency());
  });

  protected readonly canContinue = computed(
    () => this.selectedCount() > 0 && this.farePerSeat() !== null
  );

  async ngOnInit(): Promise<void> {
    // A passenger who deep-links or refreshes into a lost navigation
    // state has no segment to price or seat — start the flow over
    // rather than render a half-populated screen.
    if (!this.request()) {
      await this.router.navigate(['/search']);
      return;
    }
    await this.load();
  }

  protected async load(): Promise<void> {
    const request = this.request();
    if (!request) {
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    this.fareError.set(null);
    this.selectedSeatIds.set(new Set());

    const path = { path: { id: request.tripId } };
    const query = { from_stop: request.fromStop.id, to_stop: request.toStop.id };
    const headers = { Authorization: `Bearer ${this.authStore.accessToken()}` };

    const [availability, fare] = await Promise.all([
      this.api.GET('/api/v1/trips/{id}/availability/', {
        params: { ...path, query },
        headers,
      }),
      this.api.GET('/api/v1/trips/{id}/fare/', { params: { ...path, query }, headers }),
    ]);

    this.loading.set(false);

    if (!availability.data) {
      this.loadError.set(
        toErrorMessage(availability.error, 'Could not load seats for this trip. Try again.')
      );
      return;
    }
    this.availability.set(availability.data);

    if (!fare.data) {
      // Not a load failure — the seats are real, there is just no fare
      // configured for this segment, which blocks booking rather than
      // blocking display.
      this.farePerSeat.set(null);
      this.fareError.set(
        toErrorMessage(
          fare.error,
          'No fare is configured for this journey yet, so it cannot be booked.'
        )
      );
      return;
    }
    this.farePerSeat.set(fare.data.amount);
    this.currency.set(fare.data.currency);
  }

  protected isSelected(seatId: string): boolean {
    return this.selectedSeatIds().has(seatId);
  }

  protected toggleSeat(entry: SeatAvailability): void {
    if (!entry.is_available || this.farePerSeat() === null) {
      return;
    }
    this.selectedSeatIds.update((current) => {
      const next = new Set(current);
      if (!next.delete(entry.seat.id)) {
        next.add(entry.seat.id);
      }
      return next;
    });
  }

  protected seatLabel(entry: SeatAvailability): string {
    return entry.is_available
      ? `Seat ${entry.seat.seat_number}`
      : `Seat ${entry.seat.seat_number}, unavailable`;
  }

  protected async back(): Promise<void> {
    await this.router.navigate(['/search']);
  }

  protected async continueToConfirm(): Promise<void> {
    const request = this.request();
    const fare = this.farePerSeat();
    if (!request || fare === null || this.selectedCount() === 0) {
      return;
    }
    const selected = this.selectedSeatIds();
    const state: BookingRequest = {
      ...request,
      seats: this.availability()
        .filter((entry) => selected.has(entry.seat.id))
        .map((entry) => ({ id: entry.seat.id, seatNumber: entry.seat.seat_number })),
      farePerSeat: fare,
      currency: this.currency(),
    };
    await this.router.navigate(['/book'], { state });
  }
}
