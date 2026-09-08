import { Dialog } from '@angular/cdk/dialog';
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
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { HasPermissionDirective, PermissionsService } from '@auth';
import {
  ActionMenu,
  Alert,
  Button,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
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
import type { ActionMenuItem, ConfirmDialogData, ConfirmDialogResult, Density } from '@shared-ui';

import { ScheduleStore, type Schedule } from '../../shared/data/store/schedule.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { extractFirstErrorMessage } from '../../shared/error-message';
import { ACTIVE_FILTER_OPTIONS, ListFilters } from '../../shared/list-filters';
import { tripClassLabel } from '../../shared/trip-class';

const DAY_ABBREVIATIONS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

@Component({
  selector: 'app-schedule-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    HasPermissionDirective,
    ActionMenu,
    Alert,
    Button,
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
  templateUrl: './schedule-list.html',
})
export class ScheduleList {
  protected readonly store = inject(ScheduleStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionsService);
  private readonly api = inject(API_CLIENT);
  private readonly dialog = inject(Dialog);
  private readonly drawers = inject(DrawerService);
  private readonly densityStore = inject(TableDensityStore);

  protected readonly canManage = computed(() => this.permissions.has('scheduling.manage'));

  protected readonly activeError = signal<string | null>(null);
  protected readonly filters = new ListFilters();
  protected readonly activeFilterOptions = ACTIVE_FILTER_OPTIONS;
  protected readonly skeletonRows = [0, 1, 2, 3, 4];

  protected readonly density = this.densityStore.density;
  protected readonly cellClass = computed(() =>
    this.density() === 'compact' ? 'py-1' : 'py-3'
  );
  protected readonly densityStyle = computed(() =>
    this.density() === 'compact' ? '--ui-control-height: 1.75rem' : null
  );

  private readonly detailBody = viewChild.required<TemplateRef<unknown>>('detailBody');
  private readonly confirmBody = viewChild.required<TemplateRef<unknown>>('confirmBody');

  protected readonly selected = signal<Schedule | null>(null);
  protected readonly confirmLabel = computed(() =>
    this.isSelectedActive() ? 'Deactivate' : 'Activate'
  );
  protected readonly confirmDanger = computed(() => this.isSelectedActive());
  protected readonly confirmDisabled = signal(false);

  // See RouteList's identical wiring for the full untracked()/effect()
  // reasoning — required on every business-scoped list screen.
  //
  // No `ngOnInit` loading RouteStore any more. This screen used to build
  // a route-name map from that shared root store, which meant a schedule
  // whose route sat outside the store's loaded page rendered as a raw
  // UUID — and any other screen filtering or paginating the same store
  // could cause that mid-session. `ScheduleSerializer.route_name` now
  // carries the name on the row itself.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => void this.store.updateQuery({ business: businessId }));
      }
    },
    { allowSignalWrites: true }
  );

  protected isActive(schedule: Schedule): boolean {
    // `?? true` mirrors the model default.
    return schedule.is_active ?? true;
  }

  protected isSelectedActive(): boolean {
    const schedule = this.selected();
    return schedule ? this.isActive(schedule) : false;
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onDensityChange(next: Density): void {
    this.densityStore.set(next);
  }

  /** The Days and Departure columns, hidden below `md` — see
   * `ui-table`'s note on the responsive-column tiers. The effective
   * window is tier 3 and lives in the row's detail drawer. */
  protected readonly tripClassLabel = tripClassLabel;

  protected summaryLine(schedule: Schedule): string {
    return summaryLine([
      this.formatDays(schedule.days_of_week),
      schedule.departure_time,
      tripClassLabel(schedule.trip_class),
    ]);
  }

  protected formatDays(days: number[]): string {
    return [...days]
      .sort((a, b) => a - b)
      .map((day) => DAY_ABBREVIATIONS[day] ?? String(day))
      .join('/');
  }

  protected async goToNewSchedule(): Promise<void> {
    await this.router.navigate(['/schedules/new']);
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

  protected onActiveFilterChange(value: string): void {
    this.filters.setActiveFilter(value);
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

  protected menuItems(schedule: Schedule): ActionMenuItem[] {
    const items: ActionMenuItem[] = [
      { id: 'details', label: 'View details', icon: 'calendar-days' },
    ];
    if (this.canManage()) {
      items.push({ id: 'edit', label: 'Edit', icon: 'swatch' });
      items.push(
        this.isActive(schedule)
          ? {
              id: 'deactivate',
              label: 'Deactivate',
              icon: 'x-mark',
              danger: true,
            }
          : { id: 'activate', label: 'Activate', icon: 'check' }
      );
    }
    return items;
  }

  protected onMenuSelected(schedule: Schedule, id: string): void {
    switch (id) {
      case 'details':
        this.openDetails(schedule);
        return;
      case 'edit':
        void this.router.navigate(['/schedules', schedule.id, 'edit']);
        return;
      default:
        this.confirmActiveChange(schedule);
    }
  }

  private openDetails(schedule: Schedule): void {
    this.selected.set(schedule);
    this.drawers.open({
      title: schedule.route_name,
      description: 'When this schedule runs, and the window it is effective for.',
      bodyTemplate: this.detailBody(),
    });
  }

  /**
   * Replaces the in-table switch — docs/specs/14's one behavioural
   * change. Deactivating a schedule stops the nightly job generating
   * trips from it, which is a consequential write to make on one tap.
   */
  private confirmActiveChange(schedule: Schedule): void {
    this.selected.set(schedule);
    this.activeError.set(null);

    const next = !this.isActive(schedule);
    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `${next ? 'Activate' : 'Deactivate'} the ${schedule.departure_time} ${schedule.route_name} schedule?`,
        bodyTemplate: this.confirmBody(),
        confirmLabel: this.confirmLabel,
        danger: this.confirmDanger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitActiveChange(schedule, next),
      },
    });

    // Deferred one tick — see trip-list.ts's identical reasoning.
    ref.closed.subscribe((confirmed) => {
      if (confirmed) {
        setTimeout(() => void this.store.getAll());
      }
    });
  }

  private async submitActiveChange(
    schedule: Schedule,
    next: boolean
  ): Promise<ConfirmDialogResult> {
    const { error } = await this.api.PATCH('/api/v1/schedules/{id}/', {
      params: { path: { id: schedule.id } },
      body: { is_active: next },
    });

    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(
            error,
            `Could not ${next ? 'activate' : 'deactivate'} the ${schedule.route_name} schedule.`
          ),
        }
      : { ok: true };
  }
}
