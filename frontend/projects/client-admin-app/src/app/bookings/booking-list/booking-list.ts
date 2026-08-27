import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, EmptyState, Paginator, Select, StatusPill, Table } from '@shared-ui';
import type { SelectOption, StatusPillTone } from '@shared-ui';

import { BookingStore, type Booking } from '../../shared/data/store/booking.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

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
  completed: 'positive',
  cancelled: 'negative',
  expired: 'neutral',
};

const STATUS_LABEL: Record<BookingStatus, string> = {
  pending_payment: 'Pending payment',
  paid: 'Paid',
  completed: 'Completed',
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
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusFilterOptions = STATUS_FILTER_OPTIONS;
  protected readonly tripFilterOptions = signal<SelectOption[]>([ALL_TRIPS_OPTION]);

  ngOnInit(): void {
    void this.store.getAll();
  }

  // The Bookings table itself stays Client-scoped — `GET /bookings/` has
  // no `business` param and a Booking isn't owned by a Business — but the
  // Trip dropdown that filters it is scoped, same `effect()`/`untracked()`
  // pattern as `trip-list`'s own filter options.
  private readonly syncTripOptions = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => void this.loadTripOptions(businessId));
      }
    },
    { allowSignalWrites: true },
  );

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

  /** Scoped to the selected Business, like every other filter dropdown
   * in this app.
   *
   * This used to be unscoped, and its comment here said `GET /trips/`
   * had no `business` param to scope it with. That was true when it was
   * written and is no longer: `TripListQuerySerializer.business` exists
   * now, and `trip-list` already uses it. Left unscoped, this dropdown
   * offered every Trip under the Client regardless of which Business
   * the operator had selected in the header.
   *
   * Still bounded at 100 rows, which is a real remaining limitation —
   * `Trip.Meta.ordering` is ascending by `service_date`, so a Business
   * with more than 100 Trips offers its *oldest* hundred and no recent
   * one is selectable at all. Scoping shrinks the problem but does not
   * remove it; closing it needs either a searchable trip picker or a
   * date-bounded query, neither of which exists yet.
   */
  private async loadTripOptions(businessId: string): Promise<void> {
    const { data } = await this.api.GET('/api/v1/trips/', {
      params: { query: { limit: 100, offset: 0, business: businessId } },
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
