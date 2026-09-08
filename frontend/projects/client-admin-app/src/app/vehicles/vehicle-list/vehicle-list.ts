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
import { VehicleStore, type Vehicle } from '../../shared/data/store/vehicle.store';
import { extractFirstErrorMessage } from '../../shared/error-message';
import { ACTIVE_FILTER_OPTIONS, ListFilters } from '../../shared/list-filters';

@Component({
  selector: 'app-vehicle-list',
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
  templateUrl: './vehicle-list.html',
})
export class VehicleList {
  protected readonly store = inject(VehicleStore);
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
  // Slice 3a moved this out of the screen: density is a preference about
  // reading tables in general, not about this one.
  protected readonly density = this.densityStore.density;

  /** Skeleton rows stand in for the real ones at the same row count, so
   * the table does not resize under the reader when data lands. */
  protected readonly skeletonRows = [0, 1, 2, 3, 4];

  protected readonly cellClass = computed(() =>
    this.density() === 'compact' ? 'py-1' : 'py-3'
  );

  /**
   * Compact density is a **scoped override of the surface profile**, not
   * just tighter cell padding, and it has to be.
   *
   * `ui-action-menu`'s trigger is sized from `--ui-control-height`
   * (36px on the console profile), so it sets the row height floor: with
   * padding alone, compact came out 48px against comfortable's 60px — a
   * control that visibly did almost nothing. Overriding the token on the
   * table container shrinks every token-sized control inside it at once,
   * which is what the token layer is for.
   *
   * 28px still clears WCAG 2.2 SC 2.5.8's 24px minimum.
   */
  protected readonly densityStyle = computed(() =>
    this.density() === 'compact' ? '--ui-control-height: 1.75rem' : null
  );

  private readonly detailBody = viewChild.required<TemplateRef<unknown>>('detailBody');
  private readonly confirmBody = viewChild.required<TemplateRef<unknown>>('confirmBody');

  /** The row the drawer or confirm dialog is currently about. */
  protected readonly selected = signal<Vehicle | null>(null);

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

  /** The Compliance column, hidden below `md` — see `ui-table`'s note
   * on the responsive-column tiers. A vehicle out of compliance is the
   * one thing an operator must not have to open a drawer to discover,
   * so it stays on the row as text. */
  protected summaryLine(vehicle: Vehicle): string {
    const warnings = vehicle.compliance_warnings.length;
    return summaryLine([warnings > 0 ? plural(warnings, 'warning') : 'Compliant']);
  }

  protected isActive(vehicle: Vehicle): boolean {
    // `?? true` mirrors the model default.
    return vehicle.is_active ?? true;
  }

  protected isSelectedActive(): boolean {
    const vehicle = this.selected();
    return vehicle ? this.isActive(vehicle) : false;
  }

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

  protected async goToNewVehicle(): Promise<void> {
    await this.router.navigate(['/vehicles/new']);
  }

  /**
   * The row's actions. Built per row rather than shared, because
   * activate/deactivate reads the row's own state, and because a
   * viewer without `fleet.manage` gets the read-only subset — the same
   * gating the Edit link carried before, now expressed once here rather
   * than repeated around each control in the template.
   */
  protected menuItems(vehicle: Vehicle): ActionMenuItem[] {
    const items: ActionMenuItem[] = [
      { id: 'details', label: 'View details', icon: 'identification' },
    ];
    if (this.canManage()) {
      items.push({ id: 'edit', label: 'Edit', icon: 'swatch' });
      items.push(
        this.isActive(vehicle)
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

  protected onMenuSelected(vehicle: Vehicle, id: string): void {
    switch (id) {
      case 'details':
        this.openDetails(vehicle);
        return;
      case 'edit':
        void this.router.navigate(['/vehicles', vehicle.id, 'edit']);
        return;
      default:
        this.confirmActiveChange(vehicle);
    }
  }

  private openDetails(vehicle: Vehicle): void {
    this.selected.set(vehicle);
    this.drawers.open({
      title: vehicle.registration_number,
      description: 'Compliance and registration detail for this vehicle.',
      bodyTemplate: this.detailBody(),
    });
  }

  /**
   * Replaces the in-table switch this screen used to render.
   *
   * A write control living in a read surface is one mis-tap from taking
   * a vehicle out of service, is unlabelled beyond its colour, and
   * confirms nothing — docs/specs/14's one behavioural change. Same
   * endpoint, same permission, one deliberate step instead of one
   * accidental one.
   */
  private confirmActiveChange(vehicle: Vehicle): void {
    this.selected.set(vehicle);
    this.activeError.set(null);

    const next = !this.isActive(vehicle);
    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `${next ? 'Activate' : 'Deactivate'} ${vehicle.registration_number}?`,
        bodyTemplate: this.confirmBody(),
        confirmLabel: this.confirmLabel,
        danger: this.confirmDanger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitActiveChange(vehicle, next),
      },
    });

    // Deferred one tick — see trip-list.ts's identical reasoning:
    // refetching in the same synchronous tick as the dialog's own
    // close/focus-restoration sequence races it.
    ref.closed.subscribe((confirmed) => {
      if (confirmed) {
        setTimeout(() => void this.store.getAll());
      }
    });
  }

  private async submitActiveChange(vehicle: Vehicle, next: boolean): Promise<ConfirmDialogResult> {
    const { error } = await this.api.PATCH('/api/v1/vehicles/{id}/', {
      params: { path: { id: vehicle.id } },
      body: { is_active: next },
    });

    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(
            error,
            `Could not ${next ? 'activate' : 'deactivate'} ${vehicle.registration_number}.`
          ),
        }
      : { ok: true };
  }
}
