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
import { RouteStore } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

@Component({
  selector: 'app-route-list',
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
  templateUrl: './route-list.html',
})
export class RouteList implements OnInit {
  protected readonly store = inject(RouteStore);
  private readonly businessStore = inject(BusinessStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);

  protected readonly businessNames = computed(
    () => new Map(this.businessStore.items().map((business) => [business.id, business.name]))
  );

  // AppShell's constructor already kicked off SelectedBusinessStore's
  // one-shot load for the whole session; this effect just reacts to
  // whatever it settles on (including the first resolution) and
  // re-scopes the Route query — it never calls store.getAll() itself,
  // ListStore.updateQuery() already does that internally.
  //
  // `updateQuery()` synchronously reads and writes RouteStore's own
  // `state` signal before its first `await` (see ListStore.updateQuery/
  // getAll). Called directly from an effect, that read gets swept into
  // *this* effect's dependency tracking too (Angular attributes any
  // signal read/write during an effect's synchronous execution window
  // to that effect, even across nested function calls) — the write then
  // retriggers the very effect that just ran, forever. Confirmed
  // empirically: this hung and crashed a real browser tab in e2e,
  // silently, with no thrown error to catch (Karma's zone/scheduler
  // handling masked it, so unit tests stayed green regardless).
  // `untracked()` is the standard fix — it excludes the wrapped call
  // from dependency tracking entirely, so only `selectedBusinessId()`
  // remains a real dependency. `allowSignalWrites` is still required
  // alongside it since the write itself is still a write, just no
  // longer a *tracked* one.
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
    // Deliberately no store.getAll() here — the effect above fires the
    // first scoped fetch once SelectedBusinessStore resolves an id, via
    // updateQuery(). Calling getAll() here too would race an unscoped
    // fetch (every Route across every Business) against the scoped one.
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected async goToNewRoute(): Promise<void> {
    await this.router.navigate(['/routes/new']);
  }
}
