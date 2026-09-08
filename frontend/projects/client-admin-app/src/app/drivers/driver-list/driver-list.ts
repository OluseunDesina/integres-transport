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
  plural,
  summaryLine,
} from '@shared-ui';
import type { ActionMenuItem, ConfirmDialogData, ConfirmDialogResult, Density } from '@shared-ui';

import { DriverStore, type Driver } from '../../shared/data/store/driver.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { extractFirstErrorMessage } from '../../shared/error-message';
import { ACTIVE_FILTER_OPTIONS, ListFilters } from '../../shared/list-filters';

@Component({
  selector: 'app-driver-list',
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
  templateUrl: './driver-list.html',
})
export class DriverList {
  protected readonly store = inject(DriverStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionsService);
  private readonly api = inject(API_CLIENT);
  private readonly dialog = inject(Dialog);
  private readonly drawers = inject(DrawerService);
  private readonly densityStore = inject(TableDensityStore);

  protected readonly canManage = computed(() => this.permissions.has('fleet.manage'));

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

  protected readonly selected = signal<Driver | null>(null);
  protected readonly confirmLabel = computed(() =>
    this.isSelectedActive() ? 'Deactivate' : 'Activate'
  );
  protected readonly confirmDanger = computed(() => this.isSelectedActive());
  protected readonly confirmDisabled = signal(false);

  // See RouteList's identical wiring for the full untracked()/effect()
  // reasoning — required on every business-scoped list screen.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => void this.store.updateQuery({ business: businessId }));
      }
    },
    { allowSignalWrites: true }
  );

  /** The Licence and Compliance columns, hidden below `md` — see
   * `ui-table`'s note on the responsive-column tiers. */
  protected summaryLine(driver: Driver): string {
    const warnings = driver.compliance_warnings.length;
    return summaryLine([
      driver.license_number,
      warnings > 0 ? plural(warnings, 'warning') : 'Compliant',
    ]);
  }

  protected isActive(driver: Driver): boolean {
    // `?? true` mirrors the model default.
    return driver.is_active ?? true;
  }

  protected isSelectedActive(): boolean {
    const driver = this.selected();
    return driver ? this.isActive(driver) : false;
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onDensityChange(next: Density): void {
    this.densityStore.set(next);
  }

  protected async goToNewDriver(): Promise<void> {
    await this.router.navigate(['/drivers/new']);
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

  protected menuItems(driver: Driver): ActionMenuItem[] {
    const items: ActionMenuItem[] = [{ id: 'details', label: 'View details', icon: 'user-circle' }];
    if (this.canManage()) {
      items.push({ id: 'edit', label: 'Edit', icon: 'swatch' });
      items.push(
        this.isActive(driver)
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

  protected onMenuSelected(driver: Driver, id: string): void {
    switch (id) {
      case 'details':
        this.openDetails(driver);
        return;
      case 'edit':
        void this.router.navigate(['/drivers', driver.id, 'edit']);
        return;
      default:
        this.confirmActiveChange(driver);
    }
  }

  /** The compliance warnings used to be a `title` tooltip on the pill —
   * invisible on touch and not reliably announced. Here they are real
   * text, the same fix `vehicle-list` made in slice 2. */
  private openDetails(driver: Driver): void {
    this.selected.set(driver);
    this.drawers.open({
      title: driver.name,
      description: 'Licence, contact and compliance detail for this driver.',
      bodyTemplate: this.detailBody(),
    });
  }

  /** Replaces the in-table switch — docs/specs/14's one behavioural
   * change. */
  private confirmActiveChange(driver: Driver): void {
    this.selected.set(driver);
    this.activeError.set(null);

    const next = !this.isActive(driver);
    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `${next ? 'Activate' : 'Deactivate'} ${driver.name}?`,
        bodyTemplate: this.confirmBody(),
        confirmLabel: this.confirmLabel,
        danger: this.confirmDanger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitActiveChange(driver, next),
      },
    });

    // Deferred one tick — see trip-list.ts's identical reasoning.
    ref.closed.subscribe((confirmed) => {
      if (confirmed) {
        setTimeout(() => void this.store.getAll());
      }
    });
  }

  private async submitActiveChange(driver: Driver, next: boolean): Promise<ConfirmDialogResult> {
    const { error } = await this.api.PATCH('/api/v1/drivers/{id}/', {
      params: { path: { id: driver.id } },
      body: { is_active: next },
    });

    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(
            error,
            `Could not ${next ? 'activate' : 'deactivate'} ${driver.name}.`
          ),
        }
      : { ok: true };
  }
}
