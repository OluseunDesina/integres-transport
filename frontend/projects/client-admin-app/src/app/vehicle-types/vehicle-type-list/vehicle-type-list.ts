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
import { VehicleTypeStore } from '../../shared/data/store/vehicle-type.store';

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
  ],
  templateUrl: './vehicle-type-list.html',
})
export class VehicleTypeList implements OnInit {
  protected readonly store = inject(VehicleTypeStore);
  private readonly businessStore = inject(BusinessStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);

  protected readonly businessNames = computed(
    () => new Map(this.businessStore.items().map((business) => [business.id, business.name]))
  );

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
    { allowSignalWrites: true }
  );

  ngOnInit(): void {
    void this.businessStore.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected async goToNewVehicleType(): Promise<void> {
    await this.router.navigate(['/vehicle-types/new']);
  }
}
