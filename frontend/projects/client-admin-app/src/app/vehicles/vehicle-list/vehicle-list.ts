import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HasPermissionDirective } from '@auth';
import { Alert, Button, EmptyState, Paginator, StatusPill, Table } from '@shared-ui';

import { BusinessStore } from '../../shared/data/store/business.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { VehicleStore } from '../../shared/data/store/vehicle.store';

@Component({
  selector: 'app-vehicle-list',
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
  ],
  templateUrl: './vehicle-list.html',
})
export class VehicleList implements OnInit {
  protected readonly store = inject(VehicleStore);
  private readonly businessStore = inject(BusinessStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);

  protected readonly businessNames = computed(
    () => new Map(this.businessStore.items().map((business) => [business.id, business.name]))
  );

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

  ngOnInit(): void {
    void this.businessStore.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected async goToNewVehicle(): Promise<void> {
    await this.router.navigate(['/vehicles/new']);
  }
}
