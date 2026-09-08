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

import { FareJourneyStore, type FareJourney } from '../../shared/data/store/fare-journey.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { ListFilters } from '../../shared/list-filters';

type FareJourneyStatus = FareJourney['status'];

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'needs_review', label: 'Needs review' },
];

const STATUS_TONE: Record<FareJourneyStatus, StatusPillTone> = {
  open: 'warning',
  closed: 'positive',
  needs_review: 'negative',
};

const STATUS_LABEL: Record<FareJourneyStatus, string> = {
  open: 'Open',
  closed: 'Closed',
  needs_review: 'Needs review',
};

/**
 * Staff read-only visibility over pay-as-you-go activity
 * (`tapngo.view`) — closes a real UI gap: passengers could already tap
 * in/out (`validator-app`/`record-tap`) but staff had no screen to see
 * any of it. Read-only, same posture `payment-list.ts` takes: the row
 * menu carries "View details" and nothing that writes.
 *
 * Scoped to the active Business since spec 14 slice 3b. Before that
 * `GET /fare-journeys/` had no `?business=` param, so this listed every
 * Business under the Client while the header switcher claimed one was
 * active.
 */
@Component({
  selector: 'app-fare-journey-list',
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
    StatusPill,
    Table,
  ],
  templateUrl: './fare-journey-list.html',
})
export class FareJourneyList {
  protected readonly store = inject(FareJourneyStore);
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
      chipValue: (value) => STATUS_LABEL[value as FareJourneyStatus] ?? value,
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
  protected readonly selected = signal<FareJourney | null>(null);
  protected readonly menuItems: ActionMenuItem[] = [
    { id: 'details', label: 'View details', icon: 'bolt' },
  ];

  // See RouteList's identical wiring for the full untracked()/effect()
  // reasoning. This is the only fetch trigger — the ngOnInit that used
  // to call getAll() is gone, since an unscoped fetch there would race
  // this scoped one and briefly show every Business's journeys.
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

  protected onMenuSelected(journey: FareJourney): void {
    this.selected.set(journey);
    this.drawers.open({
      title: journey.trip.route.name,
      description: 'Taps and fare for this journey.',
      bodyTemplate: this.detailBody(),
    });
  }

  /** The Board → Alight and Amount columns, hidden below `md` — see
   * `ui-table`'s note on the responsive-column tiers. The tap
   * timestamps are tier 3 and live in the row's detail drawer. */
  protected summaryLine(journey: FareJourney): string {
    return summaryLine([
      `${journey.board_stop} → ${journey.alight_stop ?? '—'}`,
      this.amountLabel(journey),
    ]);
  }

  protected amountLabel(journey: FareJourney): string {
    return journey.amount ? `${journey.currency} ${journey.amount}` : '—';
  }
}
