import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
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

import { RouteStore } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { ScheduleStore, type Schedule } from '../../shared/data/store/schedule.store';
import { extractFirstErrorMessage } from '../../shared/error-message';

const DAY_ABBREVIATIONS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

@Component({
  selector: 'app-schedule-list',
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
  templateUrl: './schedule-list.html',
})
export class ScheduleList implements OnInit {
  protected readonly store = inject(ScheduleStore);
  private readonly routeStore = inject(RouteStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionsService);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  protected readonly canManage = computed(() => this.permissions.has('scheduling.manage'));

  /** The row whose activate/deactivate is in flight, so only that row's
   * switch goes into its pending state rather than the whole table. */
  protected readonly pendingId = signal<string | null>(null);
  protected readonly activeError = signal<string | null>(null);

  protected readonly routeNames = computed(
    () => new Map(this.routeStore.items().map((route) => [route.id, route.name])),
  );

  // See StopList's identical wiring for the full untracked()/effect()
  // reasoning — required on every business-scoped list screen.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => void this.store.updateQuery({ business: businessId }));
      }
    },
    { allowSignalWrites: true },
  );

  ngOnInit(): void {
    void this.routeStore.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected formatDays(days: number[]): string {
    return [...days]
      .sort((a, b) => a - b)
      .map((day) => DAY_ABBREVIATIONS[day] ?? String(day))
      .join('/');
  }

  protected async goToNewSchedule(): Promise<void> {
    await this.router.navigate(['/schedules/new']);
  }

  /**
   * Activate/deactivate in place. Deliberately *not* optimistic — the
   * switch renders straight off the row and only moves once the refetch
   * lands, so a rejected write can't leave the table showing a state
   * the server never accepted. See RouteList for the original.
   */
  protected async onToggleActive(entity: Schedule, next: boolean): Promise<void> {
    this.pendingId.set(entity.id);
    this.activeError.set(null);

    const { error } = await this.api.PATCH('/api/v1/schedules/{id}/', {
      params: { path: { id: entity.id } },
      body: { is_active: next },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    if (error) {
      this.activeError.set(
        extractFirstErrorMessage(
          error,
          `Could not ${next ? 'activate' : 'deactivate'} ${'this schedule'}.`,
        ),
      );
      this.pendingId.set(null);
      return;
    }

    await this.store.getAll();
    this.pendingId.set(null);
  }
}
