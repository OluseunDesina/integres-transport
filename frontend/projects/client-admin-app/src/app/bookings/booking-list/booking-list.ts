import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, EmptyState, Paginator, Select, StatusPill, Table } from '@shared-ui';
import type { SelectOption, StatusPillTone } from '@shared-ui';

import { BookingStore, type Booking } from '../../shared/data/store/booking.store';

type BookingStatus = Booking['status'];

const ALL_TRIPS_OPTION: SelectOption = { value: '', label: 'All trips' };

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'pending_payment', label: 'Pending payment' },
  { value: 'paid', label: 'Paid' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
];

// Keyed on the closed status union, so a status added to the API fails
// compilation here rather than rendering a raw `pending_payment`.
// `paid` (Phase 5) added purely for enum coverage here — this screen
// stays read-only-list-only, no payments visibility yet (a separate,
// not-yet-built client-admin frontend slice).
const STATUS_TONE: Record<BookingStatus, StatusPillTone> = {
  pending_payment: 'warning',
  paid: 'positive',
  cancelled: 'negative',
  expired: 'neutral',
};

const STATUS_LABEL: Record<BookingStatus, string> = {
  pending_payment: 'Pending payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

/**
 * Staff ops visibility over Bookings —
 * docs/specs/4-fares-seating-booking-frontend.md §4.3.
 *
 * Deliberately list-only. There is no `booking.manage` codename this
 * phase: cancelling is the passenger's own action on their own booking
 * (`POST /bookings/{id}/cancel/` rejects anyone else), so an action
 * column here would be an affordance the server refuses. Staff see, and
 * do not act.
 *
 * No passenger column either — `BookingSerializer` exposes `passenger`
 * as a bare UUID, and a column of UUIDs helps nobody. Showing who
 * booked needs the serializer to nest an email, which is a backend
 * change this slice explicitly does not depend on.
 */
@Component({
  selector: 'app-booking-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, Alert, EmptyState, Paginator, Select, StatusPill, Table],
  templateUrl: './booking-list.html',
})
export class BookingList implements OnInit {
  protected readonly store = inject(BookingStore);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusFilterOptions = STATUS_FILTER_OPTIONS;
  protected readonly tripFilterOptions = signal<SelectOption[]>([ALL_TRIPS_OPTION]);

  ngOnInit(): void {
    void this.store.getAll();
    void this.loadTripOptions();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onTripFilterChange(value: string): void {
    void this.store.updateQuery({ trip: value || undefined });
  }

  protected onStatusFilterChange(value: string): void {
    void this.store.updateQuery({ status: value || undefined });
  }

  protected seatNumbers(booking: Booking): string {
    return booking.seats.map((seat) => seat.seat).join(', ') || '—';
  }

  /** Same shape as customer-app's formatMoney — kept local because
   * that helper lives in the customer app, not a shared library. */
  protected totalLabel(booking: Booking): string {
    return `${booking.currency} ${booking.total_amount}`;
  }

  /** Unlike `trip-list`'s route/schedule filters, this one is not scoped
   * to the selected Business: `GET /trips/` has no `business` param to
   * scope it with, and the Bookings list it filters isn't business-scoped
   * either. Client-level scoping still applies server-side. */
  private async loadTripOptions(): Promise<void> {
    const { data } = await this.api.GET('/api/v1/trips/', {
      params: { query: { limit: 100, offset: 0 } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.tripFilterOptions.set([
      ALL_TRIPS_OPTION,
      ...(data?.results ?? []).map((trip) => ({
        value: trip.id,
        label: `${trip.route.name} — ${trip.service_date}`,
      })),
    ]);
  }
}
