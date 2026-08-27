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
import { StopStore, type Stop } from '../../shared/data/store/stop.store';
import { extractFirstErrorMessage } from '../../shared/error-message';

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
    Toggle,
  ],
  templateUrl: './stop-list.html',
})
export class StopList {
  protected readonly store = inject(StopStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionsService);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  protected readonly canManage = computed(() => this.permissions.has('network.manage'));

  /** The row whose activate/deactivate is in flight, so only that row's
   * switch goes into its pending state rather than the whole table. */
  protected readonly pendingId = signal<string | null>(null);
  protected readonly activeError = signal<string | null>(null);

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
  // Deliberately no store.getAll() here — see RouteList's ngOnInit.
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

  protected async goToNewStop(): Promise<void> {
    await this.router.navigate(['/stops/new']);
  }

  /**
   * Activate/deactivate in place. Deliberately *not* optimistic — the
   * switch renders straight off the row and only moves once the refetch
   * lands, so a rejected write can't leave the table showing a state
   * the server never accepted. See RouteList for the original.
   */
  protected async onToggleActive(entity: Stop, next: boolean): Promise<void> {
    this.pendingId.set(entity.id);
    this.activeError.set(null);

    const { error } = await this.api.PATCH('/api/v1/stops/{id}/', {
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
