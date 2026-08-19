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
import { DriverStore } from '../../shared/data/store/driver.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

@Component({
  selector: 'app-driver-list',
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
  templateUrl: './driver-list.html',
})
export class DriverList implements OnInit {
  protected readonly store = inject(DriverStore);
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

  protected async goToNewDriver(): Promise<void> {
    await this.router.navigate(['/drivers/new']);
  }
}
