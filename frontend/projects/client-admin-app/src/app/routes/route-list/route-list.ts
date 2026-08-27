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

import { RouteStore, type Route } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { extractFirstErrorMessage } from '../../shared/error-message';

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
    Toggle,
  ],
  templateUrl: './route-list.html',
})
export class RouteList {
  protected readonly store = inject(RouteStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly permissions = inject(PermissionsService);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly canManage = computed(() => this.permissions.has('network.manage'));

  /** The row whose activate/deactivate is in flight, so only that row's
   * switch goes into its pending state rather than the whole table. */
  protected readonly pendingId = signal<string | null>(null);
  protected readonly activeError = signal<string | null>(null);

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
  //
  // This is the *only* fetch trigger on this screen — there is no
  // ngOnInit calling getAll(), deliberately: an unscoped fetch there
  // would race this scoped one and the table would briefly show every
  // Route across every Business. BusinessStore isn't loaded here any
  // more either, since the Business column it fed is gone — the list is
  // scoped to one Business, so every row repeated the same value.
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

  protected async goToNewRoute(): Promise<void> {
    await this.router.navigate(['/routes/new']);
  }

  /**
   * Activate/deactivate in place. Deliberately *not* optimistic — the
   * switch renders straight off `route.is_active` and only moves once
   * the refetch lands, so a rejected write can't leave the table
   * showing a state the server never accepted. The per-row `pendingId`
   * covers the gap.
   */
  protected async onToggleActive(route: Route, next: boolean): Promise<void> {
    this.pendingId.set(route.id);
    this.activeError.set(null);

    const { error } = await this.api.PATCH('/api/v1/routes/{id}/', {
      params: { path: { id: route.id } },
      body: { is_active: next },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    if (error) {
      this.activeError.set(
        extractFirstErrorMessage(
          error,
          `Could not ${next ? 'activate' : 'deactivate'} ${route.name}.`,
        ),
      );
      this.pendingId.set(null);
      return;
    }

    await this.store.getAll();
    this.pendingId.set(null);
  }
}
