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

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { VehicleTypeStore, type VehicleType } from '../../shared/data/store/vehicle-type.store';
import { extractFirstErrorMessage } from '../../shared/error-message';
import { ACTIVE_FILTER_OPTIONS, ListFilters } from '../../shared/list-filters';
import { tripClassLabel } from '../../shared/trip-class';

@Component({
  selector: 'app-vehicle-type-list',
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
  templateUrl: './vehicle-type-list.html',
})
export class VehicleTypeList {
  protected readonly store = inject(VehicleTypeStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionsService);
  private readonly api = inject(API_CLIENT);
  private readonly dialog = inject(Dialog);
  private readonly drawers = inject(DrawerService);
  private readonly densityStore = inject(TableDensityStore);

  protected readonly canManage = computed(() => this.permissions.has('fleet.manage'));
  protected readonly canViewSeating = computed(() => this.permissions.has('seating.view'));

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

  protected readonly selected = signal<VehicleType | null>(null);
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

  /** The Capacity column, hidden below `md` — see `ui-table`'s note on
   * the responsive-column tiers. */
  protected readonly tripClassLabel = tripClassLabel;

  protected summaryLine(vehicleType: VehicleType): string {
    return summaryLine([
      plural(vehicleType.capacity, 'seat'),
      tripClassLabel(vehicleType.trip_class),
    ]);
  }

  protected isActive(vehicleType: VehicleType): boolean {
    // `?? true` mirrors the model default.
    return vehicleType.is_active ?? true;
  }

  protected isSelectedActive(): boolean {
    const vehicleType = this.selected();
    return vehicleType ? this.isActive(vehicleType) : false;
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onDensityChange(next: Density): void {
    this.densityStore.set(next);
  }

  protected async goToNewVehicleType(): Promise<void> {
    await this.router.navigate(['/vehicle-types/new']);
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

  /** "Seat map" is gated on `seating.view` rather than `fleet.manage` —
   * reading a vehicle type's seat layout is not a fleet edit, the same
   * split the old row's two links already carried. */
  protected menuItems(vehicleType: VehicleType): ActionMenuItem[] {
    const items: ActionMenuItem[] = [{ id: 'details', label: 'View details', icon: 'squares-2x2' }];
    if (this.canViewSeating()) {
      items.push({ id: 'seats', label: 'Seat map', icon: 'squares-2x2' });
    }
    if (this.canManage()) {
      items.push({ id: 'edit', label: 'Edit', icon: 'swatch' });
      items.push(
        this.isActive(vehicleType)
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

  protected onMenuSelected(vehicleType: VehicleType, id: string): void {
    switch (id) {
      case 'details':
        this.openDetails(vehicleType);
        return;
      case 'seats':
        void this.router.navigate(['/vehicle-types', vehicleType.id, 'seats']);
        return;
      case 'edit':
        void this.router.navigate(['/vehicle-types', vehicleType.id, 'edit']);
        return;
      default:
        this.confirmActiveChange(vehicleType);
    }
  }

  private openDetails(vehicleType: VehicleType): void {
    this.selected.set(vehicleType);
    this.drawers.open({
      title: vehicleType.name,
      description: 'Capacity and status for this vehicle type.',
      bodyTemplate: this.detailBody(),
    });
  }

  /** Replaces the in-table switch — docs/specs/14's one behavioural
   * change. */
  private confirmActiveChange(vehicleType: VehicleType): void {
    this.selected.set(vehicleType);
    this.activeError.set(null);

    const next = !this.isActive(vehicleType);
    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `${next ? 'Activate' : 'Deactivate'} ${vehicleType.name}?`,
        bodyTemplate: this.confirmBody(),
        confirmLabel: this.confirmLabel,
        danger: this.confirmDanger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitActiveChange(vehicleType, next),
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
    vehicleType: VehicleType,
    next: boolean
  ): Promise<ConfirmDialogResult> {
    const { error } = await this.api.PATCH('/api/v1/vehicle-types/{id}/', {
      params: { path: { id: vehicleType.id } },
      body: { is_active: next },
    });

    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(
            error,
            `Could not ${next ? 'activate' : 'deactivate'} ${vehicleType.name}.`
          ),
        }
      : { ok: true };
  }
}
