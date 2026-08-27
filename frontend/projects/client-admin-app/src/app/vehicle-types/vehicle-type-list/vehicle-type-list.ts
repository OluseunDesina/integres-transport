import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore, HasPermissionDirective, PermissionsService } from '@auth';
import { Alert, Button, EmptyState, Paginator, StatusPill, Table, Toggle } from '@shared-ui';

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { VehicleTypeStore, type VehicleType } from '../../shared/data/store/vehicle-type.store';
import { extractFirstErrorMessage } from '../../shared/error-message';

@Component({
  selector: 'app-vehicle-type-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HasPermissionDirective,
    Alert,
    Button,
    EmptyState,
    Paginator,
    StatusPill,
    Table,
    Toggle,
  ],
  templateUrl: './vehicle-type-list.html',
})
export class VehicleTypeList {
  protected readonly store = inject(VehicleTypeStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionsService);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  protected readonly canManage = computed(() => this.permissions.has('fleet.manage'));

  /** The row whose activate/deactivate is in flight, so only that row's
   * switch goes into its pending state rather than the whole table. */
  protected readonly pendingId = signal<string | null>(null);
  protected readonly activeError = signal<string | null>(null);

  // See RouteList's identical wiring (frontend/.../routes/route-list/route-list.ts)
  // for the full untracked()/effect() reasoning — calling
  // store.updateQuery() directly from an effect crashes real browser
  // tabs via an infinite dependency-tracking loop; untracked() is the
  // fix, required on every business-scoped list screen.

  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => void this.store.updateQuery({ business: businessId }));
      }
    },
    { allowSignalWrites: true },
  );

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected async goToNewVehicleType(): Promise<void> {
    await this.router.navigate(['/vehicle-types/new']);
  }

  /**
   * Activate/deactivate in place. Deliberately *not* optimistic — the
   * switch renders straight off the row and only moves once the refetch
   * lands, so a rejected write can't leave the table showing a state
   * the server never accepted. See RouteList for the original.
   */
  protected async onToggleActive(entity: VehicleType, next: boolean): Promise<void> {
    this.pendingId.set(entity.id);
    this.activeError.set(null);

    const { error } = await this.api.PATCH('/api/v1/vehicle-types/{id}/', {
      params: { path: { id: entity.id } },
      body: { is_active: next },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    if (error) {
      this.activeError.set(
        extractFirstErrorMessage(
          error,
          `Could not ${next ? 'activate' : 'deactivate'} ${entity.name}.`,
        ),
      );
      this.pendingId.set(null);
      return;
    }

    await this.store.getAll();
    this.pendingId.set(null);
  }
}
