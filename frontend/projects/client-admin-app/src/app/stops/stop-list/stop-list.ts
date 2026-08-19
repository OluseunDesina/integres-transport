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
import { StopStore } from '../../shared/data/store/stop.store';

@Component({
  selector: 'app-stop-list',
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
  templateUrl: './stop-list.html',
})
export class StopList implements OnInit {
  protected readonly store = inject(StopStore);
  private readonly businessStore = inject(BusinessStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);

  protected readonly businessNames = computed(
    () => new Map(this.businessStore.items().map((business) => [business.id, business.name]))
  );

  // See RouteList's identical wiring for the full reasoning.
  // `updateQuery()` synchronously reads and writes StopStore's own
  // `state` signal before its first `await` (see ListStore.updateQuery/
  // getAll). Called directly from an effect, that read gets swept into
  // *this* effect's dependency tracking too (Angular attributes any
  // signal read/write during an effect's synchronous execution window
  // to that effect, even across nested function calls) — the write then
  // retriggers the very effect that just ran, forever. Confirmed
  // empirically: this hung and crashed a real browser tab in e2e,
  // silently, with no thrown error to catch (Karma's zone/scheduler
  // handling masked it, so unit tests stayed green). `untracked()` is
  // the standard fix — it excludes the wrapped call from dependency
  // tracking entirely, so only `selectedBusinessId()` remains a real
  // dependency.
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
    // Deliberately no store.getAll() here — see RouteList's ngOnInit.
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected async goToNewStop(): Promise<void> {
    await this.router.navigate(['/stops/new']);
  }
}
