import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  TemplateRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HasPermissionDirective } from '@auth';
import {
  ActionMenu,
  Alert,
  DensityToggle,
  DrawerService,
  EmptyState,
  FilterBar,
  PageHeader,
  Paginator,
  Select,
  Skeleton,
  StatusPill,
  Table,
  summaryLine,
} from '@shared-ui';
import type { ActionMenuItem, Density, SelectOption, StatusPillTone } from '@shared-ui';

import { BookingStore, type Booking } from '../../shared/data/store/booking.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { ListFilters } from '../../shared/list-filters';

type BookingStatus = Booking['status'];

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'pending_payment', label: 'Pending payment' },
  { value: 'paid', label: 'Paid' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
];

// Keyed on the closed status union, so a status added to the API fails
// compilation here rather than rendering a raw `pending_payment`.
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
 * docs/specs/4-fares-seating-booking-frontend.md §4.3, rebuilt in spec
 * 14 slice 3b.
 *
 * Deliberately read-only. There is no `booking.manage` codename:
 * cancelling is the passenger's own action on their own booking
 * (`POST /bookings/{id}/cancel/` rejects anyone else), so a write
 * affordance here would be one the server refuses. The row menu carries
 * "View details" and nothing more.
 *
 * Two things changed in 3b beyond the chrome:
 *
 * 1. **The list is scoped to the active Business.** `GET /bookings/` had
 *    no `business` param, so this screen showed every Business under the
 *    Client while the header switcher claimed one was active. The param
 *    exists now, and this effect uses it.
 * 2. **The trip dropdown is gone**, replaced by search. It fetched
 *    `limit=100` against ascending `Trip.Meta.ordering`, so a Business
 *    with more than 100 trips was offered its *oldest* hundred and no
 *    recent one was selectable — the known-red recorded in
 *    docs/self-check-2026-08-26-spec11.md. Searching by route name or
 *    passenger email removes the bounded fetch rather than re-bounding
 *    it, and matches what a support call actually gives you.
 */
@Component({
  selector: 'app-booking-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    ActionMenu,
    Alert,
    DensityToggle,
    EmptyState,
    FilterBar,
    HasPermissionDirective,
    PageHeader,
    Paginator,
    Select,
    Skeleton,
    StatusPill,
    Table,
  ],
  templateUrl: './booking-list.html',
})
export class BookingList {
  protected readonly store = inject(BookingStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly densityStore = inject(TableDensityStore);
  private readonly drawers = inject(DrawerService);

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusFilterOptions = STATUS_FILTER_OPTIONS;

  protected readonly filters = new ListFilters([
    {
      key: 'status',
      label: 'Status',
      chipValue: (value) => STATUS_LABEL[value as BookingStatus] ?? value,
    },
  ]);
  protected readonly skeletonRows = [0, 1, 2, 3, 4];

  protected readonly density = this.densityStore.density;
  protected readonly cellClass = computed(() =>
    this.density() === 'compact' ? 'py-1' : 'py-3'
  );
  protected readonly densityStyle = computed(() =>
    this.density() === 'compact' ? '--ui-control-height: 1.75rem' : null
  );

  private readonly detailBody = viewChild.required<TemplateRef<unknown>>('detailBody');
  protected readonly selected = signal<Booking | null>(null);

  protected readonly menuItems: ActionMenuItem[] = [
    { id: 'details', label: 'View details', icon: 'document-check' },
  ];

  // See RouteList's identical wiring for the full untracked()/effect()
  // reasoning — required on every business-scoped list screen. This is
  // the only fetch trigger: an ngOnInit calling getAll() would race it
  // and briefly show every Business's bookings.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => void this.store.updateQuery({ business: businessId }));
      }
    },
    { allowSignalWrites: true }
  );

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onDensityChange(next: Density): void {
    this.densityStore.set(next);
  }

  protected applyFilters(): void {
    void this.store.updateQuery({
      business: this.selectedBusinessStore.selectedBusinessId() ?? undefined,
      ...this.filters.query(),
    });
  }

  protected onSearchChange(value: string): void {
    this.filters.setSearch(value);
    this.applyFilters();
  }

  protected onStatusFilterChange(value: string): void {
    this.filters.setExtra('status', value);
    this.applyFilters();
  }

  protected onChipRemoved(chipId: string): void {
    this.filters.remove(chipId);
    this.applyFilters();
  }

  protected onFiltersCleared(): void {
    this.filters.clear();
    this.applyFilters();
  }

  protected onMenuSelected(booking: Booking): void {
    this.selected.set(booking);
    this.drawers.open({
      title: `${booking.trip.route.name} — ${booking.trip.service_date}`,
      description: 'Seats, passenger and totals for this booking.',
      bodyTemplate: this.detailBody(),
    });
  }

  /** The Service date and Total columns, hidden below `md` — see
   * `ui-table`'s note on the responsive-column tiers. Departure, seats
   * and booked-at are tier 3 and live in the row's detail drawer. */
  protected summaryLine(booking: Booking): string {
    return summaryLine([booking.trip.service_date, this.totalLabel(booking)]);
  }

  protected seatNumbers(booking: Booking): string {
    return booking.seats.map((seat) => seat.seat).join(', ') || '—';
  }

  /** Same shape as customer-app's formatMoney — kept local because
   * that helper lives in the customer app, not a shared library. */
  protected totalLabel(booking: Booking): string {
    return `${booking.currency} ${booking.total_amount}`;
  }
}
