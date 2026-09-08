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
import { ActivatedRoute, Router } from '@angular/router';
import {
  ActionMenu,
  Alert,
  DensityToggle,
  DrawerService,
  EmptyState,
  ExportButton,
  FilterBar,
  PageHeader,
  Paginator,
  Select,
  Skeleton,
  Stat,
  StatusPill,
  Table,
  TextField,
} from '@shared-ui';
import type { ActionMenuItem, Density, SelectOption, StatusPillTone } from '@shared-ui';

import { ExportStore } from '../../shared/data/store/export.store';
import { PaymentSummaryStore } from '../../shared/data/store/payment-summary.store';
import {
  PaymentIntentStore,
  type PaymentIntent,
  type PaymentIntentQuery,
} from '../../shared/data/store/payment-intent.store';
import { GRANULARITY_OPTIONS, PeriodFilters } from '../../shared/period-filters';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { ListFilters } from '../../shared/list-filters';

type PaymentStatus = PaymentIntent['status'];

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

// Keyed on the closed status union, same idiom as booking-list.ts's own
// status map — a status added to the API fails compilation here rather
// than rendering an untranslated raw value.
const STATUS_TONE: Record<PaymentStatus, StatusPillTone> = {
  pending: 'warning',
  succeeded: 'positive',
  failed: 'negative',
  cancelled: 'neutral',
};

const STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'Pending',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Staff ops visibility over a Business's PaymentIntent history
 * (`payments.view`) — docs/specs/5-payments-wallet-ledger.md's
 * client-admin frontend slice.
 *
 * Deliberately list-only, same posture `booking-list.ts` already takes
 * for its own domain: no action column (a PaymentIntent has no staff
 * action to take on it — refunds/manual intervention aren't built),
 * and `booking`/`passenger` render as truncated ids rather than chasing
 * a second lookup, since `PaymentIntent` nests neither.
 */
@Component({
  selector: 'app-payment-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    ActionMenu,
    Alert,
    DensityToggle,
    EmptyState,
    FilterBar,
    PageHeader,
    Paginator,
    Select,
    Skeleton,
    Stat,
    StatusPill,
    Table,
    TextField,
    ExportButton,
  ],
  templateUrl: './payment-list.html',
})
export class PaymentList {
  protected readonly store = inject(PaymentIntentStore);
  protected readonly summary = inject(PaymentSummaryStore);
  protected readonly exports = inject(ExportStore);
  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);
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
      chipValue: (value) => STATUS_LABEL[value as PaymentStatus] ?? value,
    },
  ]);
  protected readonly skeletonRows = [0, 1, 2, 3, 4];
  protected readonly granularityOptions = GRANULARITY_OPTIONS;

  /** The same period the dashboard and the revenue screen filter by, so
   * a date range means one thing across the console. Round-trips
   * through the URL, so a filtered view is linkable. */
  protected readonly period = new PeriodFilters();

  constructor() {
    this.period.seed(this.activatedRoute.snapshot.queryParamMap);
  }

  protected readonly density = this.densityStore.density;
  protected readonly cellClass = computed(() =>
    this.density() === 'compact' ? 'py-1' : 'py-3'
  );
  protected readonly densityStyle = computed(() =>
    this.density() === 'compact' ? '--ui-control-height: 1.75rem' : null
  );

  private readonly detailBody = viewChild.required<TemplateRef<unknown>>('detailBody');
  protected readonly selected = signal<PaymentIntent | null>(null);
  protected readonly menuItems: ActionMenuItem[] = [
    { id: 'details', label: 'View details', icon: 'banknotes' },
  ];

  // Same untracked()-wrapped effect route-list.ts documents at length —
  // required so the write inside updateQuery() doesn't get swept into
  // this effect's own dependency tracking and retrigger itself forever.
  // No store.getAll() anywhere in this class: the effect fires the
  // first scoped fetch once SelectedBusinessStore resolves an id.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => this.applyFilters());
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

  /**
   * One place that decides what "the current view" is.
   *
   * The table and the metrics strip above it are refreshed together,
   * from the same query — which is the frontend half of the guarantee
   * the shared backend filter module makes. If they were refreshed
   * separately, a strip describing the previous filter set would be
   * indistinguishable from one describing this one.
   */
  protected applyFilters(): void {
    const query = this.currentQuery();
    void this.store.updateQuery(query);
    void this.summary.load(query);
  }

  private currentQuery(): PaymentIntentQuery {
    return {
      business: this.selectedBusinessStore.selectedBusinessId() ?? undefined,
      ...this.filters.query(),
      ...this.period.dateQuery(),
    };
  }

  protected onDateFromChange(value: string): void {
    this.period.dateFrom.set(value);
    this.onPeriodChanged();
  }

  protected onDateToChange(value: string): void {
    this.period.dateTo.set(value);
    this.onPeriodChanged();
  }

  private onPeriodChanged(): void {
    this.applyFilters();
    void this.router.navigate([], {
      relativeTo: this.activatedRoute,
      queryParams: this.period.urlParams(),
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Both filter sets' chips in one strip, so nothing narrowing this
   * table is invisible. */
  protected readonly allChips = computed(() => [...this.filters.chips(), ...this.period.chips()]);

  /**
   * The `search` term goes with it.
   *
   * It is not an aggregation dimension — the backend keeps it local to
   * the list for that reason — but for an export *of the current view*
   * it absolutely is one: an operator who searched a reference and then
   * exported would otherwise get the unsearched set.
   */
  protected exportRows(): void {
    void this.exports.download('transactions', this.currentQuery());
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
    if (chipId === 'date_from' || chipId === 'date_to' || chipId === 'granularity') {
      this.period.remove(chipId);
      this.onPeriodChanged();
      return;
    }
    this.filters.remove(chipId);
    this.applyFilters();
  }

  protected onFiltersCleared(): void {
    this.filters.clear();
    this.period.clear();
    this.onPeriodChanged();
  }

  protected onMenuSelected(payment: PaymentIntent): void {
    this.selected.set(payment);
    this.drawers.open({
      title: this.amountLabel(payment),
      description: 'PSP reference and timeline for this payment.',
      bodyTemplate: this.detailBody(),
    });
  }

  protected amountLabel(payment: PaymentIntent): string {
    return `${payment.currency} ${payment.amount}`;
  }

  // Phase 7: a wallet-top-up PaymentIntent has no booking at all — the
  // "Booking" column shows a plain dash rather than crashing on a
  // null id or, worse, silently rendering "null…".
  protected truncatedId(id: string | null): string {
    return id ? `${id.slice(0, 8)}…` : '—';
  }
}
